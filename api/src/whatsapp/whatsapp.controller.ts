import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { SendMessageDto } from './dto/send-message.dto';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { fileFilter } from './helpers/fileFilter.helper';
import { fileNamer } from './helpers/fileNamer.helper';
import { SendMediaUrlDto } from './dto/send-media-url.dto';
import { SendMediaDto } from './dto/send-media.dto';
import { SessionService } from 'src/session/session.service';

@Controller('whatsapp')
export class WhatsappController {
  constructor(
    private readonly whatsappService: WhatsappService,
    private readonly sessionService: SessionService
  ) {}

  @Get('/qr/:sessionId')
  async getQR(@Param('sessionId') sessionId: string) {

    const exist = await this.sessionService.findSession(sessionId);

    if (!exist)
      throw new BadRequestException(`No existe una session con el id ${ sessionId }, por favor comunicarte con el administrador`)

    this.whatsappService.resetQrAttempts(sessionId)

    const state = this.whatsappService.getConnectionState(sessionId)

    if (state === 'open')
      return { status: 'waiting', message: `la sesion ${sessionId} ya tiene vinculado whatSapp` }

    await this.whatsappService.startSession(sessionId);

    const qr = await this.whatsappService.waitForQR(sessionId);

    if (!qr) {
      if (state === 'close')
        return { status: 'disconnected', message: 'Sesión cerrada, reinicia para obtener nuevo QR' }

      return { status: 'waiting', message: 'Ya conectado o QR aún no generado' }
    }

    return { status: 'ok', qr }
  }

  @Get('/status-sessions')
  async statusSesion() {
    return this.whatsappService.getAllSessionStates()
  }

  @Post('/send')
  async sendMessage(
    @Body() data: SendMessageDto,
    @Query('fastMode') fastMode?: boolean
  ) {

    const useFastMode = fastMode !== undefined ? fastMode : false;

    let { sessionId, number, message } = data;

    const session = await this.sessionService.findSession(sessionId);

    if (!session)
      throw new BadRequestException(`No existe una session con el id ${ sessionId }, por favor comunicarte con el administrador`)

    if (!session.isActive)
      throw new BadRequestException(`La session con el id ${ sessionId }, se encuentra inactiva`)

    number = number.replace(/\D/g, "");

    if (number.length < 10) {
      throw new BadRequestException(`Número inválido: ${data.number}`);
    }

    const result = await this.whatsappService.sendMessage(sessionId, number, message, useFastMode)

    if (!result) {
      throw new BadRequestException(`No se pudo enviar mensaje. ¿La sesión está activa?`)
    }

    return { status: 'ok', message: `Mensaje enviado a ${number}` }
  }

  @Post('/send-media/url')
  async sendMediaFromUrl(@Body() body: SendMediaUrlDto) {
    let { sessionId, number, mediaUrl, caption } = body;

    const session = await this.sessionService.findSession(sessionId);

    if (!session)
      throw new BadRequestException(`No existe una session con el id ${ sessionId }, por favor comunicarte con el administrador`)

    if (!session.isActive)
      throw new BadRequestException(`La session con el id ${ sessionId }, se encuentra inactiva`)

    number = number.replace(/\D/g, "");

    if (number.length < 10) {
      throw new BadRequestException(`Número inválido: ${body.number}`);
    }

    const result = await this.whatsappService.sendMediaMessage(sessionId, number, mediaUrl, caption)

    if (!result) {
      throw new BadRequestException('No se pudo enviar el archivo, por favor comprobar la url del archivo')
    }

    return { status: 'ok', message: 'El archivo se encuentra en procesamiento de envio' }
  }

  @UseInterceptors(FileFieldsInterceptor([
    { name: 'files' }
  ],
    {
      fileFilter: fileFilter,
      storage: diskStorage({
        destination: function (_, __, cb) {
          cb(null, `./static`)
        },
        filename: fileNamer
      })
    }
  ))
  @Post('/send-media/file')
  async sendMediaFromFile(
    @Body() body: SendMediaDto,
    @UploadedFiles() files: { files?: Express.Multer.File[] }
  ) {

    if (!files.files)
      throw new BadRequestException('Debes enviar al menos 1 archivo')

    let { sessionId, number, caption } = body;

    const session = await this.sessionService.findSession(sessionId);

    if (!session)
      throw new BadRequestException(`No existe una session con el id ${ sessionId }, por favor comunicarte con el administrador`)

    if (!session.isActive)
      throw new BadRequestException(`La session con el id ${ sessionId }, se encuentra inactiva`)

    number = number.replace(/\D/g, "");

    if (number.length < 10) {
      throw new BadRequestException(`Número inválido: ${body.number}`);
    }

    const result = await this.whatsappService.sendMediaFiles(sessionId, number, files.files, caption)

    if (!result) {
      throw new BadRequestException('No se pudo enviar el archivo.')
    }

    return { status: 'ok', message: 'El archivo se encuentra en procesamiento de envio' }
  }

  @Delete('/session/:sessionId')
  async closeSession(@Param('sessionId') sessionId: string) {
    const result = await this.whatsappService.logoutSession(sessionId)
    return { status: 'ok', sessionId, result }
  }

  @Get('session/:sessionId/info')
  async getSessionInfo(@Param('sessionId') sessionId: string) {
    return this.whatsappService.getSessionInfo(sessionId)
  }

  @Get('check-number')
  async checkNumber(
    @Query('sessionId') sessionId: string,
    @Query('number') number: string
  ) {
    if (!sessionId || !number) {
      throw new BadRequestException('Debes enviar sessionId y number');
    }

    return this.whatsappService.checkIfNumberExists(sessionId, number);
  }
}
