import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common'
import Redis from 'ioredis'
import { createHash } from 'crypto'

/** Resultado de la reserva de una Idempotency-Key. */
export type IdemCheck =
  | { status: 'new' }
  | { status: 'pending' }
  | { status: 'conflict' }
  | { status: 'done'; response: any }

interface IdemRecord {
  state: 'pending' | 'done'
  hash: string
  at: number
  response?: any
}

/** Una reserva 'pending' más vieja que esto se considera abandonada (caída entre reserva y respuesta). */
export const IDEM_PENDING_MS = 2 * 60 * 1000
export const IDEM_TTL_SECONDS = 24 * 60 * 60

/** Hash estable del cuerpo: JSON con claves ordenadas, así el orden de los campos no importa. */
export function hashPayload(payload: Record<string, any>): string {
  const canon = JSON.stringify(payload, Object.keys(payload).sort())
  return createHash('sha256').update(canon).digest('hex')
}

/** Decide el resultado a partir del registro guardado (puro, para poder probarlo). */
export function decidir(registro: IdemRecord | null, hash: string, ahora = Date.now()): IdemCheck | 'reclamar' {
  if (!registro) return { status: 'new' }
  if (registro.hash !== hash) return { status: 'conflict' }
  if (registro.state === 'done') return { status: 'done', response: registro.response }
  if (ahora - registro.at > IDEM_PENDING_MS) return 'reclamar'
  return { status: 'pending' }
}

/**
 * Idempotencia por (sesión, Idempotency-Key) con hash del cuerpo:
 *  - misma clave + mismo cuerpo  -> se devuelve la respuesta original (done) o 'pending'
 *  - misma clave + otro cuerpo   -> conflict (409)
 *  - reserva abandonada > 2 min  -> se reclama y la petición sigue como nueva
 */
@Injectable()
export class IdempotencyService implements OnModuleDestroy {
  private readonly logger = new Logger(IdempotencyService.name)
  private readonly redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: +(process.env.REDIS_PORT ?? 6379),
    lazyConnect: true,
    maxRetriesPerRequest: 2,
  })

  async onModuleDestroy() {
    try { await this.redis.quit() } catch { /* noop */ }
  }

  private key(k: string) { return `idem:${k}` }

  async checkAndReserve(key: string, hash: string): Promise<IdemCheck> {
    const pending: IdemRecord = { state: 'pending', hash, at: Date.now() }
    const reserved = await this.redis.set(this.key(key), JSON.stringify(pending), 'EX', IDEM_TTL_SECONDS, 'NX')
    if (reserved === 'OK') return { status: 'new' }

    const raw = await this.redis.get(this.key(key))
    let registro: IdemRecord | null = null
    try { registro = raw ? JSON.parse(raw) : null } catch { registro = null }

    const r = decidir(registro, hash)
    if (r === 'reclamar') {
      await this.redis.set(this.key(key), JSON.stringify(pending), 'EX', IDEM_TTL_SECONDS)
      return { status: 'new' }
    }
    return r
  }

  async store(key: string, hash: string, response: any): Promise<void> {
    const done: IdemRecord = { state: 'done', hash, at: Date.now(), response }
    try {
      await this.redis.set(this.key(key), JSON.stringify(done), 'EX', IDEM_TTL_SECONDS)
    } catch (err: any) {
      this.logger.warn(`no se pudo guardar respuesta idempotente: ${err?.message}`)
    }
  }

  async release(key: string): Promise<void> {
    try { await this.redis.del(this.key(key)) } catch { /* noop */ }
  }
}
