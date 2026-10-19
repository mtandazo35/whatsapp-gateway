import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common'
import { WhatsappSessionManager } from './whatsapp-session-manager';
import { Session } from 'src/session/entities/session.entity';
import { MessagesService } from 'src/messages/messages.service';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { assertSafeUrl, probeMediaUrl } from './utils/url-guard';
import { SessionEventsService } from 'src/session/session-events.service';
import { Message } from 'src/messages/entities/message.entity';

/** Cuántos jobs fallidos se conservan en Redis para diagnóstico. */
const KEEP_FAILED_JOBS = 1000
/** Los datos de perfil (foto, perfil comercial) se piden a WhatsApp como mucho cada 5 min. */
const INFO_CACHE_MS = 5 * 60 * 1000
/** Un mensaje queued sin job en Bull pasados estos minutos se da por perdido. */
export const STALE_QUEUED_MS = 15 * 60 * 1000
export const REAP_JOB_ID = 'reap-queued'

export interface QueuedSend {
  messageId: string
  jobId: string | number
}

export interface SessionInfo {
  sessionId: string
  state: string
  connected: boolean
  info: {
    jid: string | null
    number: string | null
    pushName: string | null
    profilePicUrl: string | null
    businessProfile: any
  } | null
}

@Injectable()
export class WhatsappService implements OnModuleInit {

  private readonly logger = new Logger(WhatsappService.name)
  private readonly infoCache = new Map<string, { at: number; info: SessionInfo['info'] }>()

  constructor(
    @InjectQueue('send-file')
    private sendMessageFileQueue: Queue,
    private readonly whatsAppSessionManager: WhatsappSessionManager,
    private readonly messageService: MessagesService,
    private readonly sessionEvents: SessionEventsService,
  ) {}

  async onModuleInit() {
    // Desactivar o borrar una sesión desde el CRUD cierra el socket y cancela su cola.
    this.sessionEvents.onDeactivated(sid => this.cancelSession(sid, 'sesión desactivada'))
    this.sessionEvents.onDeleted(sid => this.cancelSession(sid, 'sesión eliminada'))

    // Barrido cada 5 min de mensajes queued cuyo job ya no existe (reinicio, cola vaciada).
    try {
      await this.sendMessageFileQueue.add('reapQueued', {}, {
        jobId: REAP_JOB_ID,
        repeat: { cron: '*/5 * * * *' },
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 1,
      })
    } catch (error) {
      this.logger.warn(`no se pudo programar el barrido de mensajes queued: ${error?.message}`)
    }

    await this.whatsAppSessionManager.loadAllSessions();
  }

  /**
   * Valida que la sesión esté conectada
   */
  private validateSession(sessionId: string) {
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

  /**
   * Crea el registro del mensaje en estado queued y encola el job. Si encolar
   * falla, el mensaje queda como failed con el motivo. El id del mensaje es
   * también el jobId: estable, consultable y sin duplicar jobs por reintentos.
   */
  private async encolar(
    nombre: 'sendMessageText' | 'sendMessageUrl' | 'sendMessageFile',
    session: Session,
    registro: { message: string; kind: Message['kind']; caption?: string | null; fastMode?: boolean; requestedBy?: string | null },
    number: string,
    data: Record<string, any>,
    opts: { attempts: number; backoffMs?: number },
  ): Promise<QueuedSend> {
    const msg = await this.messageService.createQueued({ session, receptor: number, ...registro })

    try {
      const job = await this.sendMessageFileQueue.add(
        nombre,
        { ...data, messageId: msg.id, sessionId: session.sessionId, number },
        {
          jobId: msg.id,
          removeOnComplete: true,
          removeOnFail: KEEP_FAILED_JOBS,
          attempts: opts.attempts,
          ...(opts.backoffMs ? { backoff: { type: 'exponential', delay: opts.backoffMs } } : {}),
        }
      );
      return { messageId: msg.id, jobId: job.id }
    } catch (error) {
      await this.messageService.markFailed(msg.id, error).catch(() => undefined)
      throw new BadRequestException(`No se pudo encolar el envío: ${error?.message}`)
    }
  }

  async sendMessage(session: Session, number: string, message: string, fastMode: boolean, requestedBy?: string): Promise<QueuedSend> {
    // Sin socket abierto no se acepta: antes se encolaba y se perdía en silencio.
    this.validateSession(session.sessionId);

    return this.encolar(
      'sendMessageText', session,
      { message, kind: 'text', fastMode, requestedBy },
      number, { message, fastMode }, { attempts: 1 },
    )
  }

  /**
   * Envía multimedia desde una URL. La URL se valida contra destinos internos
   * (anti-SSRF) y se sondea con HEAD antes de aceptar el trabajo.
   */
  async sendMediaMessage(session: Session, number: string, mediaUrl: string, caption?: string, requestedBy?: string): Promise<QueuedSend> {
    this.validateSession(session.sessionId);

    const url = await assertSafeUrl(mediaUrl)
    const probe = await probeMediaUrl(url)

    return this.encolar(
      'sendMessageUrl', session,
      { message: mediaUrl, kind: 'media_url', caption: caption ?? null, requestedBy },
      number,
      { caption, mediaUrl: url.toString(), type: probe.type, contentType: probe.contentType },
      { attempts: 2, backoffMs: 2000 },
    )
  }

  /**
   * Envía archivos ya subidos por multer. Un job por archivo.
   */
  async sendMediaFiles(session: Session, number: string, files: Express.Multer.File[], caption?: string, requestedBy?: string): Promise<Array<QueuedSend & { file: string }>> {
    this.validateSession(session.sessionId);

    if (!files || files.length === 0) {
      throw new BadRequestException('No se proporcionaron archivos');
    }

    const resultados: Array<QueuedSend & { file: string }> = []

    for (const file of files) {
      const queued = await this.encolar(
        'sendMessageFile', session,
        { message: file.originalname, kind: 'file', caption: caption ?? null, requestedBy },
        number,
        { caption, path: file.path, mimetype: file.mimetype, originalname: file.originalname },
        { attempts: 2, backoffMs: 2000 },
      )
      resultados.push({ ...queued, file: file.originalname })
    }

    return resultados
  }

  /**
   * Reintenta un envío fallido creando un mensaje nuevo (el histórico se conserva).
   * Texto y URL se pueden repetir; un archivo subido ya no existe en disco.
   */
  async retry(original: Message, session: Session, requestedBy: string): Promise<QueuedSend> {
    if (original.status !== 'failed') {
      throw new BadRequestException(`Solo se reintentan mensajes en estado failed (este está en ${original.status})`)
    }
    if (original.kind === 'file') {
      throw new BadRequestException('El archivo temporal ya no existe; vuelve a subirlo')
    }
    if (original.kind === 'media_url') {
      return this.sendMediaMessage(session, original.receptor, original.message, original.caption ?? undefined, requestedBy)
    }
    return this.sendMessage(session, original.receptor, original.message, original.fastMode, requestedBy)
  }

  /**
   * Cierra el socket, cancela los jobs en espera de esa sesión y marca sus
   * mensajes queued como failed. Lo disparan el CRUD (desactivar/borrar) y el logout.
   */
  async cancelSession(sessionId: string, motivo: string): Promise<{ cancelled: number }> {
    let cancelled = 0
    try {
      await this.logoutSession(sessionId)
    } catch (error) {
      this.logger.warn(`[${sessionId}] logout al cancelar falló: ${error?.message}`)
    }

    try {
      const jobs = await this.sendMessageFileQueue.getJobs(['waiting', 'delayed', 'paused'])
      for (const job of jobs) {
        if (job?.data?.sessionId !== sessionId) continue
        await job.remove().catch(() => undefined)
        if (job.data?.messageId) await this.messageService.markFailed(job.data.messageId, motivo).catch(() => undefined)
        cancelled++
      }
      // Mensajes queued sin job (por si Bull ya los había soltado).
      for (const m of await this.messageService.findQueuedBySession(sessionId)) {
        await this.messageService.markFailed(m.id, motivo).catch(() => undefined)
      }
    } catch (error) {
      this.logger.warn(`[${sessionId}] no se pudieron cancelar jobs: ${error?.message}`)
    }

    this.logger.log(`[${sessionId}] ${motivo}: socket cerrado, ${cancelled} job(s) cancelados`)
    return { cancelled }
  }

  async queueCounts() {
    return this.sendMessageFileQueue.getJobCounts()
  }

  async getQR(sessionId: string) {
    return this.whatsAppSessionManager.getQR(sessionId);
  }

  async startSession(sessionId: string) {
    return this.whatsAppSessionManager.startSession(sessionId);
  }

  async getAllSessionStates() {
    return this.whatsAppSessionManager.getAllStates();
  }

  resetQrAttempts(sessionId: string) {
    return this.whatsAppSessionManager.resetQrAttempts(sessionId);
  }

  waitForQR(sessionId: string) {
    return this.whatsAppSessionManager.waitForQR(sessionId);
  }

  getConnectionState(sessionId: string) {
    return this.whatsAppSessionManager.getSessionState(sessionId);
  }

  async logoutSession(sessionId: string) {
    this.infoCache.delete(sessionId)
    return this.whatsAppSessionManager.logout(sessionId)
  }

  /**
   * Estado + datos de perfil. El estado siempre es en vivo; la foto y el perfil
   * comercial se cachean 5 min para no consultar a WhatsApp en cada polling.
   */
  async getSessionInfo(sessionId: string): Promise<SessionInfo> {
    const state = this.whatsAppSessionManager.getSessionState(sessionId)
    const sock = this.whatsAppSessionManager.getSocket(sessionId)

    if (!sock || state !== 'open') {
      this.infoCache.delete(sessionId)
      return { sessionId, state, connected: false, info: null }
    }

    const cached = this.infoCache.get(sessionId)
    if (cached && Date.now() - cached.at < INFO_CACHE_MS) {
      return { sessionId, state, connected: true, info: cached.info }
    }

    const meJid =
      sock.user?.id ??
      (sock as any)?.authState?.creds?.me?.id ??
      null

    const pushName =
      sock.user?.name ??
      (sock as any)?.authState?.creds?.me?.name ??
      null

    let number: string | null = null
    if (meJid) {
      const bare = meJid.split('@')[0]
      number = bare.includes(':') ? bare.split(':')[0] : bare
    }

    let profilePicUrl: string | null = null
    if (meJid) {
      try {
        profilePicUrl = await sock.profilePictureUrl(meJid)
      } catch {
        profilePicUrl = null
      }
    }

    let businessProfile: any = null
    if (meJid) {
      try {
        businessProfile = await (sock as any).getBusinessProfile?.(meJid)
      } catch {
        businessProfile = null
      }
    }

    const info = { jid: meJid, number, pushName, profilePicUrl, businessProfile }
    this.infoCache.set(sessionId, { at: Date.now(), info })

    return { sessionId, state, connected: true, info }
  }

  async checkIfNumberExists(sessionId: string, number: string) {
    const sock = this.whatsAppSessionManager.getSocket(sessionId)
    if (!sock) {
      throw new NotFoundException(`No existe sesión activa con id ${sessionId}`);
    }

    const jid = `${number}@s.whatsapp.net`;

    try {
      const [result] = await sock.onWhatsApp(jid);
      return {
        exists: !!result?.exists,
        jid: result?.jid || null
      };
    } catch (error) {
      this.logger.warn(`[${sessionId}] onWhatsApp falló: ${error?.message}`)
      return {
        exists: false,
        error: 'Error verificando el número en WhatsApp'
      };
    }
  }
}
