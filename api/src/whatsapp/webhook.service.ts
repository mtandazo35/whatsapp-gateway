import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { InjectQueue } from '@nestjs/bull'
import { Queue } from 'bull'
import { Repository } from 'typeorm'
import axios from 'axios'
import * as crypto from 'crypto'
import { WebhookEvent, WebhookEventStatus } from './entities/webhook-event.entity'

export const WEBHOOK_QUEUE = 'webhook'
/** 10 intentos con backoff exponencial desde 2 s: ~34 min en total antes de darlo por fallido. */
export const WEBHOOK_ATTEMPTS = 10
export const WEBHOOK_BACKOFF_MS = 2_000

/** Valida la URL del webhook: https salvo que el operador permita http explícitamente. */
export function validateWebhookUrl(raw: string, allowHttp: boolean): { ok: boolean; motivo?: string } {
  if (!raw) return { ok: true }
  let url: URL
  try { url = new URL(raw) } catch { return { ok: false, motivo: 'WEBHOOK_URL no es una URL válida' } }
  if (url.protocol === 'https:') return { ok: true }
  if (url.protocol === 'http:' && allowHttp) return { ok: true }
  if (url.protocol === 'http:') return { ok: false, motivo: 'WEBHOOK_URL usa http; pon https o WEBHOOK_ALLOW_HTTP=true si el receptor está en tu red' }
  return { ok: false, motivo: `WEBHOOK_URL con esquema no soportado: ${url.protocol}` }
}

@Injectable()
export class WebhookService implements OnModuleInit {
  private readonly logger = new Logger(WebhookService.name)
  private readonly url = process.env.WEBHOOK_URL?.trim() || ''
  private readonly secret = process.env.WEBHOOK_SECRET?.trim() || ''
  private readonly allowHttp = process.env.WEBHOOK_ALLOW_HTTP === 'true'
  private readonly timeoutMs = 10_000
  private enabled = false

  constructor(
    @InjectRepository(WebhookEvent)
    private readonly repo: Repository<WebhookEvent>,
    @InjectQueue(WEBHOOK_QUEUE)
    private readonly queue: Queue,
  ) {}

  onModuleInit() {
    if (!this.url) {
      this.logger.log('Webhook saliente desactivado (WEBHOOK_URL vacío)')
      return
    }
    const v = validateWebhookUrl(this.url, this.allowHttp)
    if (!v.ok) {
      this.logger.error(`${v.motivo}. Webhook desactivado.`)
      return
    }
    if (!this.secret) {
      this.logger.warn('WEBHOOK_SECRET vacío: los eventos salen sin firma HMAC')
    }
    this.enabled = true
    this.logger.log(`Webhook saliente activo -> ${this.url}`)
  }

  isEnabled(): boolean {
    return this.enabled
  }

  config() {
    return {
      enabled: this.enabled,
      url: this.url ? this.url.replace(/\/\/([^@/]+)@/, '//***@') : null,
      signed: !!this.secret,
      allowHttp: this.allowHttp,
      attempts: WEBHOOK_ATTEMPTS,
    }
  }

  /**
   * Persiste el evento y encola su entrega. Nunca lanza: lo llaman handlers de
   * Baileys que no deben romperse porque el webhook falle.
   */
  async dispatch(event: string, payload: Record<string, any>): Promise<void> {
    if (!this.enabled) return
    try {
      const ev = await this.repo.save(this.repo.create({ event, payload, status: 'pending', attempts: 0 }))
      await this.encolar(ev.id, ev.id)
    } catch (error) {
      this.logger.error(`no se pudo registrar el evento ${event}: ${error?.message}`)
    }
  }

  private async encolar(eventId: string, jobId: string) {
    await this.queue.add(
      'deliver',
      { eventId },
      {
        jobId,
        attempts: WEBHOOK_ATTEMPTS,
        backoff: { type: 'exponential', delay: WEBHOOK_BACKOFF_MS },
        removeOnComplete: true,
        removeOnFail: 1000,
      },
    )
  }

  /** Entrega real; la llama el procesador de la cola. Relanza para que Bull reintente. */
  async deliver(eventId: string, isLastAttempt: boolean): Promise<void> {
    const ev = await this.repo.findOneBy({ id: eventId })
    if (!ev) {
      this.logger.warn(`evento ${eventId} no existe; job descartado`)
      return
    }
    if (ev.status === 'sent') return

    const body = JSON.stringify({
      eventId: ev.id,
      event: ev.event,
      timestamp: ev.created_at.toISOString(),
      attempt: ev.attempts + 1,
      data: ev.payload,
    })

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'whatsapp-gateway-webhook/1.0',
      'X-Event-Id': ev.id,
      'X-Event-Type': ev.event,
    }
    if (this.secret) {
      headers['X-Signature'] = `sha256=${crypto.createHmac('sha256', this.secret).update(body).digest('hex')}`
    }

    try {
      await axios.post(this.url, body, { headers, timeout: this.timeoutMs, maxRedirects: 0 })
      await this.repo.update(ev.id, { status: 'sent', attempts: ev.attempts + 1, lastError: null, sentAt: new Date() })
    } catch (error: any) {
      const motivo = (error?.response ? `HTTP ${error.response.status}` : error?.message) ?? 'error desconocido'
      await this.repo.update(ev.id, {
        attempts: ev.attempts + 1,
        lastError: String(motivo).slice(0, 500),
        status: isLastAttempt ? 'failed' : 'pending',
      })
      if (isLastAttempt) {
        this.logger.warn(`webhook ${ev.event} ${ev.id} falló definitivamente tras ${ev.attempts + 1} intentos: ${motivo}`)
      }
      throw error
    }
  }

  // ---- administración ----

  async list(status: WebhookEventStatus | undefined, page: number, limit: number) {
    const [data, total] = await this.repo.findAndCount({
      where: status ? { status } : {},
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    })
    return { data, meta: { total, page, lastPage: Math.ceil(total / limit) } }
  }

  async counts(): Promise<Record<WebhookEventStatus, number>> {
    const rows = await this.repo
      .createQueryBuilder('e')
      .select('e.status', 'status')
      .addSelect('count(*)', 'n')
      .groupBy('e.status')
      .getRawMany<{ status: WebhookEventStatus; n: string }>()
    const out: Record<WebhookEventStatus, number> = { pending: 0, sent: 0, failed: 0 }
    for (const r of rows) out[r.status] = Number(r.n)
    return out
  }

  /** Vuelve a encolar un evento (fallido o pendiente atascado). Devuelve el evento. */
  async replay(eventId: string): Promise<WebhookEvent | null> {
    const ev = await this.repo.findOneBy({ id: eventId })
    if (!ev) return null
    await this.repo.update(ev.id, { status: 'pending', lastError: null })
    await this.encolar(ev.id, `${ev.id}:replay:${Date.now()}`)
    return { ...ev, status: 'pending' }
  }

  async replayFailed(): Promise<number> {
    const fallidos = await this.repo.find({ where: { status: 'failed' }, select: { id: true } })
    for (const ev of fallidos) await this.replay(ev.id)
    return fallidos.length
  }
}
