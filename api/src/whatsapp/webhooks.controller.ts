import { Controller, DefaultValuePipe, Get, NotFoundException, Param, ParseIntPipe, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Roles } from 'src/user/decorators';
import { Rol } from 'src/user/dto/create-user.dto';
import { WebhookService } from './webhook.service';
import { WebhookEventStatus } from './entities/webhook-event.entity';

/** Administración del webhook saliente: ver eventos, reenviar fallidos. Solo administradores. */
@Roles(Rol.ADMIN, Rol.SUPER_ADMIN)
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhook: WebhookService) {}

  @Get('config')
  config() {
    return this.webhook.config();
  }

  @Get('events')
  async list(
    @Query('status') status: string | undefined,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    const estado = ['pending', 'sent', 'failed'].includes(status ?? '') ? (status as WebhookEventStatus) : undefined;
    return this.webhook.list(estado, Math.max(1, page), Math.min(Math.max(1, limit), 200));
  }

  @Get('events/counts')
  counts() {
    return this.webhook.counts();
  }

  @Post('events/replay-failed')
  async replayFailed() {
    const n = await this.webhook.replayFailed();
    return { status: 'ok', replayed: n };
  }

  @Post('events/:id/replay')
  async replay(@Param('id', ParseUUIDPipe) id: string) {
    const ev = await this.webhook.replay(id);
    if (!ev) throw new NotFoundException(`No existe el evento ${id}`);
    return { status: 'ok', event: ev };
  }
}
