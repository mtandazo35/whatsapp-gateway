import { Controller, Get } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Roles } from 'src/user/decorators';
import { Rol } from 'src/user/dto/create-user.dto';
import { WhatsappService } from './whatsapp.service';
import { WEBHOOK_QUEUE, WebhookService } from './webhook.service';
import { MessagesService } from 'src/messages/messages.service';

/**
 * Salud operativa para administradores: sesiones, colas, mensajes de las
 * últimas 24 h y webhooks. Lo que /ready no dice (ese solo responde si BD y
 * Redis contestan).
 */
@Roles(Rol.ADMIN, Rol.SUPER_ADMIN)
@Controller('status')
export class StatusController {
  constructor(
    private readonly whatsapp: WhatsappService,
    private readonly webhook: WebhookService,
    private readonly messages: MessagesService,
    @InjectQueue(WEBHOOK_QUEUE) private readonly webhookQueue: Queue,
    @InjectQueue('clean-file-queue') private readonly cleanQueue: Queue,
  ) {}

  @Get()
  async status() {
    const [sessions, sendQueue, webhookQueue, cleanQueue, messages24h, webhookEvents] = await Promise.all([
      this.whatsapp.getAllSessionStates(),
      this.whatsapp.queueCounts(),
      this.webhookQueue.getJobCounts(),
      this.cleanQueue.getJobCounts(),
      this.messages.countsByStatus(24),
      this.webhook.counts(),
    ])

    const mem = process.memoryUsage()
    const porEstado: Record<string, number> = {}
    for (const s of sessions) porEstado[s.state] = (porEstado[s.state] ?? 0) + 1

    return {
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      memory: { rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576) },
      sessions: { total: sessions.length, byState: porEstado, list: sessions },
      queues: { send: sendQueue, webhook: webhookQueue, maintenance: cleanQueue },
      messagesLast24h: messages24h,
      webhook: { ...this.webhook.config(), events: webhookEvents },
      alerts: this.alertas(sendQueue, webhookEvents, porEstado),
    }
  }

  private alertas(send: Record<string, number>, wh: Record<string, number>, sesiones: Record<string, number>): string[] {
    const out: string[] = []
    if ((send.waiting ?? 0) > 100) out.push(`cola de envío con ${send.waiting} trabajos esperando`)
    if ((send.failed ?? 0) > 50) out.push(`${send.failed} trabajos de envío fallidos conservados en Redis`)
    if ((wh.failed ?? 0) > 0) out.push(`${wh.failed} evento(s) de webhook fallidos: revisa /webhooks/events?status=failed`)
    if ((sesiones.connecting ?? 0) > 0) out.push(`${sesiones.connecting} sesión(es) en connecting`)
    return out
  }
}
