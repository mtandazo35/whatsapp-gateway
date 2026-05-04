import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import * as crypto from 'crypto'

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name)
  private readonly url = process.env.WEBHOOK_URL?.trim() || ''
  private readonly secret = process.env.WEBHOOK_SECRET?.trim() || ''
  private readonly timeoutMs = 10_000

  isEnabled(): boolean {
    return this.url.length > 0
  }

  async dispatch(event: string, payload: Record<string, any>): Promise<void> {
    if (!this.isEnabled()) return

    const body = JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      data: payload,
    })

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'whatsapp-gateway-webhook/1.0',
    }

    if (this.secret) {
      const sig = crypto.createHmac('sha256', this.secret).update(body).digest('hex')
      headers['X-Signature'] = `sha256=${sig}`
    }

    this.send(body, headers, event, 0)
  }

  private async send(
    body: string,
    headers: Record<string, string>,
    event: string,
    attempt: number,
  ): Promise<void> {
    const maxAttempts = 5
    try {
      await axios.post(this.url, body, { headers, timeout: this.timeoutMs })
    } catch (err: any) {
      if (attempt + 1 >= maxAttempts) {
        this.logger.warn(`webhook ${event} falló tras ${maxAttempts} intentos: ${err?.message}`)
        return
      }
      const delay = Math.min(60_000, 1000 * Math.pow(2, attempt))
      setTimeout(() => this.send(body, headers, event, attempt + 1), delay)
    }
  }
}
