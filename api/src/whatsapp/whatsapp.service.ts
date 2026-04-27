import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common'
import { WhatsappSessionManager } from './whatsapp-session-manager';
import { InjectRepository } from '@nestjs/typeorm';
import { Session } from 'src/session/entities/session.entity';
import { Repository } from 'typeorm';
import { MessagesService } from 'src/messages/messages.service';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { randomUUID } from 'crypto';

@Injectable()
export class WhatsappService implements OnModuleInit {

  constructor(
    @InjectRepository(Session)
    private readonly sessionRepository: Repository<Session>,
    @InjectQueue('send-file')
    private sendMessageFileQueue: Queue,
    private readonly whatsAppSessionManager: WhatsappSessionManager,
    private readonly messageService: MessagesService
  ) {}

  async onModuleInit() {
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

  async sendMessage(sessionId: string, number: string, message: string, fastMode: boolean) {
    try {

      const session = await this.sessionRepository.findOneBy({ sessionId });

      if (!session) {
        throw new BadRequestException(`Sesión ${sessionId} no encontrada`);
      }

      return await this.sendMessageFileQueue.add(
        'sendMessageText',
        {
          message,
          sessionId,
          number,
          fastMode
        },
        {
          jobId: randomUUID(),
          removeOnFail: true,
          removeOnComplete: true,
          attempts: 1
        }
      );
    } catch (error) {
      const session = await this.sessionRepository.findOneBy({ sessionId });
      if (session) {
        await this.messageService.create({ message, session, receptor: number }, false);
      }

      throw new BadRequestException(`Error al enviar mensaje: ${error.message}`);
    }
  }

  /**
   * Envía multimedia desde una URL
   */
  async sendMediaMessage(
    sessionId: string,
    number: string,
    mediaUrl: string,
    caption?: string
  ) {
    try {
      // Validar sesión antes de encolar
      this.validateSession(sessionId);

      const { type, isValid } = await this.getFileTypeWithValidation(mediaUrl);

      if (!isValid) {
        throw new BadRequestException('URL inválida o tipo de archivo no soportado');
      }

      return await this.sendMessageFileQueue.add(
        'sendMessageUrl',
        {
          caption,
          number,
          sessionId,
          mediaUrl,
          type
        },
        {
          jobId: randomUUID(),
          removeOnFail: true,
          removeOnComplete: true,
          attempts: 2,
          backoff: {
            type: 'exponential',
            delay: 2000
          }
        }
      );
    } catch (error) {
      throw new BadRequestException(`Error al enviar multimedia: ${error.message}`);
    }
  }

  /**
   * Envía archivos desde el sistema de archivos
   */
  async sendMediaFiles(
    sessionId: string,
    number: string,
    files: any[],
    caption?: string
  ) {
    try {
      this.validateSession(sessionId);

      if (!files || files.length === 0) {
        throw new BadRequestException('No se proporcionaron archivos');
      }

      const jobs = files.map((file) => {
        return this.sendMessageFileQueue.add(
          'sendMessageFile',
          {
            caption,
            number,
            sessionId,
            path: file.path,
            mimetype: file.mimetype,
            originalname: file.originalname,
          },
          {
            jobId: randomUUID(),
            removeOnFail: true,
            removeOnComplete: true,
            attempts: 2,
            backoff: {
              type: 'exponential',
              delay: 2000
            }
          }
        );
      });

      await Promise.all(jobs);

      return { success: true, filesQueued: files.length };
    } catch (error) {
      throw new BadRequestException(`Error al enviar archivos: ${error.message}`);
    }
  }

  /**
   * Valida el tipo de archivo desde una URL
   * (Implementa tu lógica existente aquí)
   */
  private async getFileTypeWithValidation(url: string): Promise<{ type: string; isValid: boolean }> {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      const contentType = response.headers.get('content-type');

      if (!contentType) {
        return { type: 'document', isValid: false };
      }

      const type = contentType.split('/')[0];
      return {
        type: ['image', 'video', 'audio'].includes(type) ? type : 'document',
        isValid: true
      };
    } catch {
      return { type: 'document', isValid: false };
    }
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
    return this.whatsAppSessionManager.logout(sessionId)
  }

  async getSessionInfo(sessionId: string) {
    const state = this.whatsAppSessionManager.getSessionState(sessionId)
    const sock = this.whatsAppSessionManager.getSocket(sessionId)

    if (!sock) {
      return {
        sessionId,
        state,
        connected: state === 'open',
        info: null,
      }
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

    return {
      sessionId,
      state,
      connected: state === 'open',
      info: {
        jid: meJid,
        number,
        pushName,
        profilePicUrl,
        businessProfile,
      },
    }
  }

  async checkIfNumberExists(sessionId: string, number: string) {
    const sock = this.whatsAppSessionManager.getSocket(sessionId)
    if (!sock) {
      throw new NotFoundException(`No existe sesión con id ${sessionId}`);
    }

    const jid = number.includes('@s.whatsapp.net')
      ? number
      : `${number}@s.whatsapp.net`;

    try {
      const [result] = await sock.onWhatsApp(jid);
      return {
        exists: !!result?.exists,
        jid: result?.jid || null
      };
    } catch (error) {
      return {
        exists: false,
        error: 'Error verificando el número en WhatsApp'
      };
    }
  }
}
