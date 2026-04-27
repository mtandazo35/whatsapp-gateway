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
import { InjectRepository } from '@nestjs/typeorm';
import { Session } from 'src/session/entities/session.entity';
import { Repository } from 'typeorm';

@Processor('send-file')
export class SendFileQueueProcessor {

  constructor(
    @InjectRepository(Session)
    private readonly sessionRepository: Repository<Session>,
    private readonly messageService: MessagesService,
    private readonly whatsAppSessionManager: WhatsappSessionManager
  ) {}

  /**
   * Obtiene el JID correcto (PN o LID) para enviar mensajes
   * En v7, WhatsApp puede usar LIDs en lugar de números de teléfono
   */
  private getRecipientJid(number: string): string {
    // Limpiamos el número (eliminar espacios, guiones, etc)
    const cleanNumber = number.replace(/[^0-9]/g, '');

    // Formato estándar de WhatsApp (PN - Phone Number)
    return `${cleanNumber}@s.whatsapp.net`;
  }

  /**
   * Valida que el socket esté disponible y conectado
   */
  private async validateSocket(sessionId: string) {
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

  @Process('sendMessageText')
  async sendMessageText(job: Job) {
    const {
      message,
      number,
      sessionId,
      fastMode = false
    } = job.data;

    try {
      const sock = await this.validateSocket(sessionId);
      const recipientJid = this.getRecipientJid(number);

      if (fastMode) {
        await sock.sendMessage(recipientJid, { text: message });
      } else {
        await this.sendMessageWithTypingSimulation(sock, recipientJid, message);
      }

      // ✅ Crear registro del mensaje
      return await this.messageService.create({
        message,
        session: sessionId,
        receptor: number,
      });

    } catch (error) {
      // Manejo de error
      const session = await this.sessionRepository.findOneBy({ sessionId });
      if (session) {
        await this.messageService.create({
          message,
          session,
          receptor: number
        });
      }
      throw new BadRequestException(`Error al enviar mensaje: ${error.message}`);
    }
  }

  // ✅ Método auxiliar para modo normal con simulaciones
  private async sendMessageWithTypingSimulation(
    sock: any,
    recipientJid: string,
    message: string
  ): Promise<void> {
    // 1. Calcular tiempo de tipeo basado en longitud del mensaje
    const typingTime = this.calculateTypingTime(message);

    // 2. Enviar estado "escribiendo..."
    await sock.sendPresenceUpdate('composing', recipientJid);

    // 3. Esperar el tiempo de tipeo simulado
    await this.delay(typingTime);

    // 4. Cambiar a estado "pausado" (dejó de escribir)
    await sock.sendPresenceUpdate('paused', recipientJid);

    // 5. Pequeña pausa antes de enviar (más natural)
    await this.delay(this.getRandomDelay(500, 1500));

    // 6. Enviar el mensaje
    await sock.sendMessage(recipientJid, { text: message });

    // 7. Volver a estado "available" (online)
    await sock.sendPresenceUpdate('available');
  }

  @Process('sendMessageFile')
  async sendMessageFile(job: Job) {
    const {
      caption,
      number,
      sessionId,
      path,
      mimetype,
      originalname
    } = job.data;

    try {
      const sock = await this.validateSocket(sessionId);
      const session = await this.sessionRepository.findOneBy({ sessionId });

      if (!session) {
        throw new BadRequestException(`Sesión ${sessionId} no encontrada en BD`);
      }

      // Verificar que el archivo existe
      if (!fs.existsSync(path)) {
        throw new BadRequestException(`Archivo no encontrado: ${path}`);
      }

      // ✅ 1. Pausa inicial (como si estuviera seleccionando el archivo)
      await this.delay(this.getRandomDelay(1000, 1700));

      // ✅ 2. Indicar que está disponible/activo
      await sock.sendPresenceUpdate('available');
      await this.delay(this.getRandomDelay(500, 1000));

      const type = mimetype.split('/')[0];
      const fileBuffer = fs.readFileSync(path);
      const recipientJid = this.getRecipientJid(number);

      // ✅ 3. Validar tamaño del archivo
      this.validateFileSize(fileBuffer, type);

      let configMedia: any = {};

      if (!['image', 'video', 'audio'].includes(type)) {
        configMedia = {
          mimetype: mimetype,
          fileName: originalname,
          document: fileBuffer,
          caption: caption || ''
        };
      }

      if (type === 'image') {
        // ✅ 4. Comprimir imagen si es necesaria
        const compressedBuffer = await this.compressImageIfNeeded(fileBuffer);

        configMedia = {
          image: compressedBuffer,
          caption: caption || ''
        };
      }

      if (type === 'audio') {
        configMedia = {
          audio: fileBuffer,
          mimetype: 'audio/mp4',
          ptt: false
        };
      }

      if (type === 'video') {
        configMedia = {
          video: fileBuffer,
          caption: caption || ''
        };
      }

      // ✅ 5. Simular comportamiento según el tipo de archivo
      if (type === 'audio') {
        // Simular que está "grabando" para audios
        await sock.sendPresenceUpdate('recording', recipientJid);
        await this.delay(this.getRandomDelay(2000, 5000));
      } else {
        // Para otros tipos, si hay caption simular que está escribiendo
        if (caption) {
          await sock.sendPresenceUpdate('composing', recipientJid);
          const typingTime = this.calculateTypingTime(caption);
          await this.delay(typingTime);
        }
      }

      // ✅ 6. Simular tiempo de "subida" del archivo
      const uploadTime = this.calculateUploadTime(type, configMedia);
      await this.delay(uploadTime);

      // ✅ 7. Pausar brevemente antes de enviar
      await sock.sendPresenceUpdate('paused', recipientJid);
      await this.delay(this.getRandomDelay(500, 1500));

      // ✅ 8. Enviar mensaje con retry
      await this.sendWithRetry(sock, recipientJid, configMedia);

      // ✅ 9. Volver a estado disponible
      await sock.sendPresenceUpdate('available');

      // Limpiar archivo después de enviar
      if (fs.existsSync(path)) {
        fs.unlinkSync(path);
      }

      return await this.messageService.create({
        message: originalname,
        session,
        receptor: number
      });

    } catch (error) {
      const session = await this.sessionRepository.findOneBy({ sessionId });
      if (session) {
        await this.messageService.create({
          message: path,
          session,
          receptor: number
        }, false);
      }

      // Limpiar archivo en caso de error también
      if (path && fs.existsSync(path)) {
        try {
          fs.unlinkSync(path);
        } catch (unlinkError) {
          console.error('Error al eliminar archivo:', unlinkError);
        }
      }

      throw new BadRequestException(`Fallo al enviar el archivo: ${error.message}`);
    }
  }

  @Process('sendMessageUrl')
  async sendMessageUrl(job: Job) {
    const { caption, number, sessionId, mediaUrl, type } = job.data;

    try {
      const sock = await this.validateSocket(sessionId);
      const session = await this.sessionRepository.findOneBy({ sessionId });

      if (!session) {
        throw new BadRequestException(`Sesión ${sessionId} no encontrada en BD`);
      }

      const recipientJid = this.getRecipientJid(number);

      // ✅ Pausa inicial
      await this.delay(this.getRandomDelay(1500, 3000));
      await sock.sendPresenceUpdate('available');

      let configMedia: any = {};
      let fileBuffer: Buffer | null = null;

      // Descargar y preparar el archivo
      if (!['image', 'video', 'audio'].includes(type)) {
        const response = await axios.get(mediaUrl, {
          responseType: 'arraybuffer',
          timeout: 30000
        });

        fileBuffer = Buffer.from(response.data);

        // ✅ Validar tamaño
        this.validateFileSize(fileBuffer, type);

        const urlObj = new URL(mediaUrl);
        const pathname = urlObj.pathname;
        const rawName = basename(pathname);
        const cleanName = rawName.split('?')[0];

        let mimeType = response.headers['content-type']?.split(';')[0].trim()
          || mime.lookup(cleanName)
          || 'application/octet-stream';

        configMedia = {
          mimetype: mimeType,
          fileName: cleanName,
          document: fileBuffer,
          caption: caption || ''
        };
      } else if (type === 'image') {
        // Descargar imagen para validar/comprimir
        const response = await axios.get(mediaUrl, {
          responseType: 'arraybuffer',
          timeout: 30000
        });

        fileBuffer = Buffer.from(response.data);

        // ✅ Comprimir si es muy grande
        const compressedBuffer = await this.compressImageIfNeeded(fileBuffer);

        configMedia = {
          image: compressedBuffer,
          caption: caption || ''
        };
      } else if (type === 'audio') {
        configMedia = {
          audio: { url: mediaUrl },
          mimetype: 'audio/mp4',
          ptt: false
        };
      } else if (type === 'video') {
        configMedia = {
          video: { url: mediaUrl },
          caption: caption || ''
        };
      }

      // ✅ Simular comportamiento según tipo
      if (type === 'audio') {
        await sock.sendPresenceUpdate('recording', recipientJid);
        await this.delay(this.getRandomDelay(2000, 5000));
      } else {
        if (caption) {
          await sock.sendPresenceUpdate('composing', recipientJid);
          const typingTime = this.calculateTypingTime(caption);
          await this.delay(typingTime);
        }
      }

      // ✅ Simular tiempo de subida
      const uploadTime = this.calculateUploadTime(type, configMedia);
      await this.delay(uploadTime);

      // ✅ Pausa antes de enviar
      await sock.sendPresenceUpdate('paused', recipientJid);
      await this.delay(this.getRandomDelay(500, 1500));

      // ✅ Enviar con retry
      await this.sendWithRetry(sock, recipientJid, configMedia);

      await sock.sendPresenceUpdate('available');

      return await this.messageService.create({
        message: mediaUrl,
        session,
        receptor: number
      });

    } catch (error) {
      const session = await this.sessionRepository.findOneBy({ sessionId });
      if (session) {
        await this.messageService.create({
          message: mediaUrl,
          session,
          receptor: number
        }, false);
      }

      throw new BadRequestException(`Fallo al enviar multimedia: ${error.message}`);
    }
  }

  /**
   * Calcula tiempo de tipeo basado en la longitud del mensaje
   * Simula velocidad de escritura humana (40-60 palabras por minuto)
   */
  private calculateTypingTime(message: string): number {
    const MIN_WPM = 40; // palabras por minuto mínimo
    const MAX_WPM = 60; // palabras por minuto máximo

    // Estimar palabras (aproximadamente 5 caracteres por palabra)
    const wordCount = message.length / 5;

    // Velocidad aleatoria entre min y max WPM
    const wpm = this.getRandomDelay(MIN_WPM, MAX_WPM);

    // Convertir a milisegundos
    const timeInMs = (wordCount / wpm) * 60 * 1000;

    // Límites razonables: mínimo 2s, máximo 15s
    return Math.min(Math.max(timeInMs, 2000), 15000);
  }

  /**
   * Genera un delay aleatorio entre min y max (en milisegundos)
   */
  private getRandomDelay(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Helper para delays con Promises
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private calculateUploadTime(type: string, configMedia: any): number {
    let baseTime = 2000; // 2 segundos base

    switch (type) {
      case 'image':
        baseTime = this.getRandomDelay(2000, 4000); // 2-4s
        break;

      case 'video':
        baseTime = this.getRandomDelay(5000, 10000); // 5-10s
        break;

      case 'audio':
        baseTime = this.getRandomDelay(2000, 5000); // 2-5s
        break;

      default: // documentos
        // Estimar por tamaño si está disponible
        if (configMedia.document) {
          const sizeInMB = configMedia.document.length / (1024 * 1024);
          // ~1 segundo por MB, con mínimo de 2s y máximo de 15s
          baseTime = Math.min(Math.max(sizeInMB * 1000, 2000), 15000);
        } else {
          baseTime = this.getRandomDelay(3000, 8000); // 3-8s
        }
        break;
    }

    return baseTime;
  }

  private async sendWithRetry(
    sock: any,
    recipientJid: string,
    configMedia: any,
    maxRetries: number = 3
  ): Promise<any> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await sock.sendMessage(recipientJid, configMedia);
      } catch (error) {
        if (attempt === maxRetries) throw error;

        // Backoff exponencial: 2s, 4s, 8s
        const backoffTime = Math.pow(2, attempt) * 1000;
        console.log(`Reintento ${attempt}/${maxRetries} después de ${backoffTime}ms`);
        await this.delay(backoffTime);
      }
    }
  }

  private validateFileSize(buffer: Buffer, type: string): void {
    const sizeInMB = buffer.length / (1024 * 1024);

    const limits = {
      image: 16, // 16 MB
      video: 64, // 64 MB
      audio: 16, // 16 MB
      document: 100 // 100 MB
    };

    const maxSize = limits[type] || limits.document;

    if (sizeInMB > maxSize) {
      throw new BadRequestException(
        `Archivo muy grande (${sizeInMB.toFixed(2)}MB). Máximo permitido: ${maxSize}MB`
      );
    }
  }

  private async compressImageIfNeeded(buffer: Buffer, maxSizeKB: number = 500): Promise<Buffer> {
    const sizeInKB = buffer.length / 1024;

    if (sizeInKB <= maxSizeKB) {
      return buffer; // No necesita compresión
    }

    // Usar sharp para comprimir (instalar: npm install sharp)
    const sharp = require('sharp');

    let quality = 80;
    let compressed = await sharp(buffer)
      .jpeg({ quality })
      .toBuffer();

    // Reducir calidad hasta alcanzar el tamaño deseado
    while (compressed.length / 1024 > maxSizeKB && quality > 20) {
      quality -= 10;
      compressed = await sharp(buffer)
        .jpeg({ quality })
        .toBuffer();
    }

    return compressed;
  }
}
