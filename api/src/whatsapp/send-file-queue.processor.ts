import * as fs from 'fs-extra';
import { Job } from 'bull';
import axios from 'axios'
import { Buffer } from 'buffer'
import { basename } from 'path'
import mime from 'mime-types'
import { Process, Processor } from '@nestjs/bull';
import { MessagesService } from 'src/messages/messages.service';
import { BadRequestException, Logger } from '@nestjs/common';
import { WhatsappSessionManager } from './whatsapp-session-manager';
import { assertSafeUrl } from './utils/url-guard';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { STALE_QUEUED_MS } from './whatsapp.service';

/** Límites de tamaño por tipo (MB), alineados con lo que acepta WhatsApp. */
const SIZE_LIMITS_MB: Record<string, number> = {
  image: 16,
  video: 64,
  audio: 16,
  document: 100,
}

/**
 * Worker de envíos. Contrato con la API:
 *  - cada job trae messageId: la fila ya existe en estado queued
 *  - al enviar con éxito -> markSent(waMessageId); lo que pase DESPUÉS del envío
 *    (presencia, borrar archivo) nunca hace fallar el job, para no reintentar y
 *    duplicar un mensaje que WhatsApp ya aceptó
 *  - si falla antes de enviar: se relanza para que Bull reintente; solo en el
 *    último intento se marca failed y se borra el archivo
 *  - los reintentos los gestiona Bull (attempts/backoff); aquí no hay bucles
 *    internos de reintento, que multiplicaban los envíos
 */
@Processor('send-file')
export class SendFileQueueProcessor {

  private readonly logger = new Logger(SendFileQueueProcessor.name)

  constructor(
    private readonly messageService: MessagesService,
    private readonly whatsAppSessionManager: WhatsappSessionManager,
    @InjectQueue('send-file') private readonly queue: Queue,
  ) {}

  /** Barrido periódico: mensajes queued viejos cuyo job ya no existe pasan a failed. */
  @Process('reapQueued')
  async reapQueued() {
    const stale = await this.messageService.findStaleQueued(STALE_QUEUED_MS)
    let marcados = 0
    for (const m of stale) {
      const job = await this.queue.getJob(m.id)
      const estado = job ? await job.getState() : null
      if (!job || estado === 'completed' || estado === 'failed') {
        await this.messageService.markFailed(m.id, `job perdido (${estado ?? 'sin job'}): la API se reinició o la cola se vació`)
        marcados++
      }
    }
    if (marcados) this.logger.warn(`barrido: ${marcados} mensaje(s) queued marcados como failed`)
    return { marcados }
  }

  private getRecipientJid(number: string): string {
    const cleanNumber = number.replace(/[^0-9]/g, '');
    return `${cleanNumber}@s.whatsapp.net`;
  }

  private validateSocket(sessionId: string) {
    const sock = this.whatsAppSessionManager.getSocket(sessionId);

    if (!sock) {
      throw new BadRequestException(`Socket no disponible para sesión ${sessionId}`);
    }

    const state = this.whatsAppSessionManager.getSessionState(sessionId);

    if (state !== 'open') {
      throw new BadRequestException(`Sesión ${sessionId} no está conectada (estado: ${state})`);
    }

    return sock;
  }

  private isLastAttempt(job: Job): boolean {
    const attempts = job.opts?.attempts ?? 1
    return job.attemptsMade + 1 >= attempts
  }

  /** La presencia es cosmética: nunca debe hacer fallar un envío. */
  private async presence(sock: any, ...args: any[]) {
    try {
      await sock.sendPresenceUpdate(...args)
    } catch (error) {
      this.logger.debug(`sendPresenceUpdate falló: ${error?.message}`)
    }
  }

  private async onFailure(job: Job, messageId: string, error: any, filePath?: string) {
    if (this.isLastAttempt(job)) {
      await this.messageService.markFailed(messageId, error).catch(e =>
        this.logger.warn(`no se pudo marcar failed ${messageId}: ${e?.message}`))
      if (filePath) await fs.remove(filePath).catch(() => undefined)
    } else {
      this.logger.warn(`[${job.data?.sessionId}] job ${job.id} falló (intento ${job.attemptsMade + 1}), se reintentará: ${error?.message}`)
    }
  }

  private async onSuccess(messageId: string, sent: any) {
    const waMessageId: string | undefined = sent?.key?.id
    try {
      await this.messageService.markSent(messageId, waMessageId)
    } catch (error) {
      // El mensaje SÍ salió. Se registra y no se relanza: relanzar duplicaría el envío.
      this.logger.error(`mensaje ${messageId} enviado (wa ${waMessageId}) pero no se pudo registrar: ${error?.message}`)
    }
    return { messageId, waMessageId }
  }

  @Process('sendMessageText')
  async sendMessageText(job: Job) {
    const { messageId, message, number, sessionId, fastMode = false } = job.data;

    try {
      const sock = this.validateSocket(sessionId);
      const recipientJid = this.getRecipientJid(number);

      let sent: any
      if (fastMode) {
        sent = await sock.sendMessage(recipientJid, { text: message });
      } else {
        sent = await this.sendMessageWithTypingSimulation(sock, recipientJid, message);
      }

      const resultado = await this.onSuccess(messageId, sent)
      await this.presence(sock, 'available')
      return resultado

    } catch (error) {
      await this.onFailure(job, messageId, error)
      throw new BadRequestException(`Error al enviar mensaje: ${error.message}`);
    }
  }

  private async sendMessageWithTypingSimulation(sock: any, recipientJid: string, message: string): Promise<any> {
    const typingTime = this.calculateTypingTime(message);
    await this.presence(sock, 'composing', recipientJid);
    await this.delay(typingTime);
    await this.presence(sock, 'paused', recipientJid);
    await this.delay(this.getRandomDelay(500, 1500));
    return await sock.sendMessage(recipientJid, { text: message });
  }

  @Process('sendMessageFile')
  async sendMessageFile(job: Job) {
    const { messageId, caption, number, sessionId, path, mimetype, originalname } = job.data;

    try {
      const sock = this.validateSocket(sessionId);

      if (!path || !(await fs.pathExists(path))) {
        throw new BadRequestException(`Archivo no encontrado: ${path}`);
      }

      await this.delay(this.getRandomDelay(1000, 1700));
      await this.presence(sock, 'available');
      await this.delay(this.getRandomDelay(500, 1000));

      const type = String(mimetype ?? '').split('/')[0];
      const fileBuffer = await fs.readFile(path);
      const recipientJid = this.getRecipientJid(number);

      this.validateFileSize(fileBuffer, type);

      const configMedia = await this.buildMedia(type, fileBuffer, {
        mimetype,
        fileName: originalname,
        caption,
      })

      await this.simulateBeforeSend(sock, recipientJid, type, caption, configMedia)

      const sent = await sock.sendMessage(recipientJid, configMedia);

      const resultado = await this.onSuccess(messageId, sent)
      await this.presence(sock, 'available')
      await fs.remove(path).catch(() => undefined)
      return resultado

    } catch (error) {
      await this.onFailure(job, messageId, error, path)
      throw new BadRequestException(`Fallo al enviar el archivo: ${error.message}`);
    }
  }

  @Process('sendMessageUrl')
  async sendMessageUrl(job: Job) {
    const { messageId, caption, number, sessionId, mediaUrl, type, contentType } = job.data;

    try {
      const sock = this.validateSocket(sessionId);
      const recipientJid = this.getRecipientJid(number);

      // Se vuelve a validar aquí: el DNS pudo cambiar entre la API y el worker.
      await assertSafeUrl(mediaUrl)

      await this.delay(this.getRandomDelay(1500, 3000));
      await this.presence(sock, 'available');

      const limitMb = SIZE_LIMITS_MB[type] ?? SIZE_LIMITS_MB.document
      const response = await axios.get(mediaUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxRedirects: 0,
        maxContentLength: limitMb * 1024 * 1024,
        maxBodyLength: limitMb * 1024 * 1024,
        headers: { 'User-Agent': 'whatsapp-gateway/1.0' },
        validateStatus: s => s >= 200 && s < 300,
      });

      const fileBuffer = Buffer.from(response.data);
      this.validateFileSize(fileBuffer, type);

      const pathname = new URL(mediaUrl).pathname;
      const cleanName = basename(pathname) || 'archivo';
      const headerType = String(response.headers['content-type'] ?? '').split(';')[0].trim()
      const mimeType = headerType
        || contentType
        || mime.lookup(cleanName)
        || 'application/octet-stream';

      const configMedia = await this.buildMedia(type, fileBuffer, {
        mimetype: mimeType,
        fileName: cleanName,
        caption,
      })

      await this.simulateBeforeSend(sock, recipientJid, type, caption, configMedia)

      const sent = await sock.sendMessage(recipientJid, configMedia);

      const resultado = await this.onSuccess(messageId, sent)
      await this.presence(sock, 'available')
      return resultado

    } catch (error) {
      await this.onFailure(job, messageId, error)
      throw new BadRequestException(`Fallo al enviar multimedia: ${error.message}`);
    }
  }

  // ---------- helpers ----------

  private async buildMedia(
    type: string,
    fileBuffer: Buffer,
    meta: { mimetype: string; fileName: string; caption?: string },
  ): Promise<any> {
    if (type === 'image') {
      return { image: await this.compressImageIfNeeded(fileBuffer), caption: meta.caption || '' }
    }
    if (type === 'audio') {
      return { audio: fileBuffer, mimetype: 'audio/mp4', ptt: false }
    }
    if (type === 'video') {
      return { video: fileBuffer, caption: meta.caption || '' }
    }
    return {
      mimetype: meta.mimetype,
      fileName: meta.fileName,
      document: fileBuffer,
      caption: meta.caption || '',
    }
  }

  private async simulateBeforeSend(sock: any, recipientJid: string, type: string, caption: string | undefined, configMedia: any) {
    if (type === 'audio') {
      await this.presence(sock, 'recording', recipientJid);
      await this.delay(this.getRandomDelay(2000, 5000));
    } else if (caption) {
      await this.presence(sock, 'composing', recipientJid);
      await this.delay(this.calculateTypingTime(caption));
    }

    await this.delay(this.calculateUploadTime(type, configMedia));
    await this.presence(sock, 'paused', recipientJid);
    await this.delay(this.getRandomDelay(500, 1500));
  }

  /** Simula velocidad de escritura humana (40-60 ppm), entre 2 y 15 s. */
  private calculateTypingTime(message: string): number {
    const wordCount = message.length / 5;
    const wpm = this.getRandomDelay(40, 60);
    const timeInMs = (wordCount / wpm) * 60 * 1000;
    return Math.min(Math.max(timeInMs, 2000), 15000);
  }

  private getRandomDelay(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private calculateUploadTime(type: string, configMedia: any): number {
    switch (type) {
      case 'image': return this.getRandomDelay(2000, 4000);
      case 'video': return this.getRandomDelay(5000, 10000);
      case 'audio': return this.getRandomDelay(2000, 5000);
      default:
        if (configMedia?.document) {
          const sizeInMB = configMedia.document.length / (1024 * 1024);
          return Math.min(Math.max(sizeInMB * 1000, 2000), 15000);
        }
        return this.getRandomDelay(3000, 8000);
    }
  }

  private validateFileSize(buffer: Buffer, type: string): void {
    const sizeInMB = buffer.length / (1024 * 1024);
    const maxSize = SIZE_LIMITS_MB[type] ?? SIZE_LIMITS_MB.document;

    if (sizeInMB > maxSize) {
      throw new BadRequestException(
        `Archivo muy grande (${sizeInMB.toFixed(2)}MB). Máximo permitido: ${maxSize}MB`
      );
    }
  }

  private async compressImageIfNeeded(buffer: Buffer, maxSizeKB: number = 500): Promise<Buffer> {
    const sizeInKB = buffer.length / 1024;

    if (sizeInKB <= maxSizeKB) {
      return buffer;
    }

    // sharp es dependencia directa (package.json); se carga aquí para no pagar el arranque si no hay imágenes.
    const sharp = require('sharp');

    let quality = 80;
    let compressed = await sharp(buffer).jpeg({ quality }).toBuffer();

    while (compressed.length / 1024 > maxSizeKB && quality > 20) {
      quality -= 10;
      compressed = await sharp(buffer).jpeg({ quality }).toBuffer();
    }

    return compressed;
  }
}
