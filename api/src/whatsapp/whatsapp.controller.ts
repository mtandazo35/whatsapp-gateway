import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { SendMessageDto } from './dto/send-message.dto';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { fileFilter } from './helpers/fileFilter.helper';
import { fileNamer } from './helpers/fileNamer.helper';
import { SendMediaUrlDto } from './dto/send-media-url.dto';
import { SendMediaDto } from './dto/send-media.dto';
import { SessionService } from 'src/session/session.service';
import { hashPayload, IdempotencyService } from './idempotency.service';
import { GetUser } from 'src/user/decorators';
import { AuthUser } from 'src/user/interfaces/auth-user.interface';
import { Session } from 'src/session/entities/session.entity';
import { removeQuietly } from './utils/files-utils';
import { ThrottleSend } from 'src/common/rate-limit';
import { MessagesService } from 'src/messages/messages.service';

/** Límites de subida por petición (Caddy además corta el cuerpo en 25 MB). */
export const UPLOAD_MAX_FILES = 10
export const UPLOAD_MAX_FILE_BYTES = 25 * 1024 * 1024
const IDEM_KEY_MAX = 128

/**
 * Todas las rutas exigen token (guard global) y comprueban que el usuario sea
 * dueño de la sesión o administrador.
 *
 * Los envíos responden 202 con {status:'queued', messageId, jobId}: la API
 * acepta el trabajo, no garantiza la entrega. El estado real se consulta en
 * GET /messages/:messageId (queued -> sent -> delivered -> read | failed).
 */
@Controller('whatsapp')
export class WhatsappController {
  constructor(
    private readonly whatsappService: WhatsappService,
    private readonly sessionService: SessionService,
    private readonly messagesService: MessagesService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private async sessionLista(sessionId: string, actor: AuthUser): Promise<Session> {
    const session = await this.sessionService.findSessionForUser(sessionId, actor);

    if (!session.isActive)
      throw new BadRequestException(`La sesión con el id ${ sessionId } se encuentra inactiva`)

    return session
  }

  private numeroLimpio(raw: string): string {
    const number = (raw ?? '').replace(/\D/g, "");

    if (number.length < 10 || number.length > 15) {
      throw new BadRequestException(`Número inválido: ${raw}`);
    }
    return number
  }

  /**
   * Ejecuta `accion` bajo una Idempotency-Key opcional:
   *  - misma clave y mismo cuerpo -> respuesta cacheada (o 'duplicate' si sigue en curso)
   *  - misma clave y otro cuerpo  -> 409
   */
  private async conIdempotencia<T>(
    sessionId: string,
    rawKey: string | undefined,
    payload: Record<string, any>,
    accion: () => Promise<T>,
  ): Promise<T | { status: string; message: string }> {
    const idemKey = rawKey?.trim()
    if (!idemKey) return accion()
    if (idemKey.length > IDEM_KEY_MAX) throw new BadRequestException(`Idempotency-Key demasiado larga (máximo ${IDEM_KEY_MAX})`)

    const key = `${sessionId}:${idemKey}`
    const hash = hashPayload(payload)
    const check = await this.idempotency.checkAndReserve(key, hash)

    if (check.status === 'conflict')
      throw new ConflictException('Esta Idempotency-Key ya se usó con otro cuerpo; usa una clave nueva')
    if (check.status === 'pending')
      return { status: 'duplicate', message: 'Petición ya en proceso con la misma Idempotency-Key' }
    if (check.status === 'done')
      return check.response

    try {
      const response = await accion()
      await this.idempotency.store(key, hash, response)
      return response
    } catch (err) {
      await this.idempotency.release(key)
      throw err
    }
  }

  @Get('/qr/:sessionId')
  async getQR(@Param('sessionId') sessionId: string, @GetUser() actor: AuthUser) {
    await this.sessionLista(sessionId, actor);

    this.whatsappService.resetQrAttempts(sessionId)

    const state = this.whatsappService.getConnectionState(sessionId)

    if (state === 'open')
      return { status: 'waiting', message: `La sesión ${sessionId} ya tiene vinculado WhatsApp` }

    await this.whatsappService.startSession(sessionId);

    const qr = await this.whatsappService.waitForQR(sessionId);

    if (!qr) {
      if (state === 'close')
        return { status: 'disconnected', message: 'Sesión cerrada, reinicia para obtener nuevo QR' }

      return { status: 'waiting', message: 'Ya conectado o QR aún no generado' }
    }

    return { status: 'ok', qr }
  }

  /** Estado en memoria de las sesiones visibles para el usuario. */
  @Get('/status-sessions')
  async statusSesion(@GetUser() actor: AuthUser) {
    const visibles = await this.sessionService.visibleSessionIds(actor)
    const states = await this.whatsappService.getAllSessionStates()

    if (visibles === null) return states
    return states.filter(s => visibles.has(s.sessionId))
  }

  @ThrottleSend()
  @Post('/send')
  @HttpCode(202)
  async sendMessage(
    @Body() data: SendMessageDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Query('fastMode', new DefaultValuePipe(false), ParseBoolPipe) fastMode: boolean,
    @GetUser() actor: AuthUser,
  ) {
    const { sessionId, message } = data;

    const session = await this.sessionLista(sessionId, actor)
    const number = this.numeroLimpio(data.number)

    return this.conIdempotencia(sessionId, idempotencyKey, { sessionId, number, message, fastMode }, async () => {
      const { messageId, jobId } = await this.whatsappService.sendMessage(session, number, message, fastMode, actor.id)
      return {
        status: 'queued',
        message: `Mensaje aceptado para ${number}; consulta /api/messages/${messageId} para ver el estado`,
        messageId,
        jobId,
      }
    })
  }

  @ThrottleSend()
  @Post('/send-media/url')
  @HttpCode(202)
  async sendMediaFromUrl(
    @Body() body: SendMediaUrlDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @GetUser() actor: AuthUser,
  ) {
    const { sessionId, mediaUrl, caption } = body;

    const session = await this.sessionLista(sessionId, actor)
    const number = this.numeroLimpio(body.number)

    return this.conIdempotencia(sessionId, idempotencyKey, { sessionId, number, mediaUrl, caption: caption ?? '' }, async () => {
      const { messageId, jobId } = await this.whatsappService.sendMediaMessage(session, number, mediaUrl, caption, actor.id)
      return {
        status: 'queued',
        message: 'El archivo se encuentra en cola de envío',
        messageId,
        jobId,
      }
    })
  }

  @ThrottleSend()
  @UseInterceptors(FileFieldsInterceptor([
    { name: 'files', maxCount: UPLOAD_MAX_FILES }
  ],
    {
      fileFilter: fileFilter,
      limits: {
        files: UPLOAD_MAX_FILES,
        fileSize: UPLOAD_MAX_FILE_BYTES,
        fields: 10,
      },
      storage: diskStorage({
        destination: function (_, __, cb) {
          cb(null, `./static`)
        },
        filename: fileNamer
      })
    }
  ))
  @Post('/send-media/file')
  @HttpCode(202)
  async sendMediaFromFile(
    @Body() body: SendMediaDto,
    @UploadedFiles() files: { files?: Express.Multer.File[] },
    @GetUser() actor: AuthUser,
  ) {
    const subidos = files?.files ?? []

    // multer ya escribió en disco: si algo de lo que sigue rechaza la petición,
    // se borran los archivos para no dejar huérfanos.
    try {
      if (subidos.length === 0)
        throw new BadRequestException('Debes enviar al menos 1 archivo')

      const { sessionId, caption } = body;

      const session = await this.sessionLista(sessionId, actor)
      const number = this.numeroLimpio(body.number)

      const queued = await this.whatsappService.sendMediaFiles(session, number, subidos, caption, actor.id)

      return {
        status: 'queued',
        message: `${queued.length} archivo(s) en cola de envío`,
        queued,
      }
    } catch (err) {
      await removeQuietly(subidos.map(f => f.path))
      throw err
    }
  }

  /** Reintenta un mensaje failed (texto o URL). Crea un mensaje nuevo; el fallido queda en el historial. */
  @ThrottleSend()
  @Post('/messages/:id/retry')
  @HttpCode(202)
  async retry(@Param('id', ParseUUIDPipe) id: string, @GetUser() actor: AuthUser) {
    const original = await this.messagesService.findOne(id, actor)
    const session = await this.sessionLista(original.session.sessionId, actor)
    const { messageId, jobId } = await this.whatsappService.retry(original, session, actor.id)
    return { status: 'queued', message: `Reintento encolado; consulta /api/messages/${messageId}`, messageId, jobId, retryOf: id }
  }

  @Delete('/session/:sessionId')
  async closeSession(@Param('sessionId') sessionId: string, @GetUser() actor: AuthUser) {
    await this.sessionService.findSessionForUser(sessionId, actor);

    const result = await this.whatsappService.cancelSession(sessionId, 'sesión cerrada por el usuario')
    return { status: 'ok', sessionId, result: { status: 'closed', ...result } }
  }

  @Get('session/:sessionId/info')
  async getSessionInfo(@Param('sessionId') sessionId: string, @GetUser() actor: AuthUser) {
    await this.sessionService.findSessionForUser(sessionId, actor);

    return this.whatsappService.getSessionInfo(sessionId)
  }

  @Get('check-number')
  async checkNumber(
    @Query('sessionId') sessionId: string,
    @Query('number') number: string,
    @GetUser() actor: AuthUser,
  ) {
    if (!sessionId || !number) {
      throw new BadRequestException('Debes enviar sessionId y number');
    }

    await this.sessionService.findSessionForUser(sessionId, actor);

    return this.whatsappService.checkIfNumberExists(sessionId, this.numeroLimpio(number));
  }
}
