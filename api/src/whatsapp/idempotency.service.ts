import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common'
import Redis from 'ioredis'

@Injectable()
export class IdempotencyService implements OnModuleDestroy {
  private readonly logger = new Logger(IdempotencyService.name)
  private readonly redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: +(process.env.REDIS_PORT ?? 6379),
    lazyConnect: true,
    maxRetriesPerRequest: 2,
  })
  private readonly ttlSeconds = 24 * 60 * 60

  async onModuleDestroy() {
    try { await this.redis.quit() } catch { /* noop */ }
  }

  /**
   * Si la key ya existe devuelve la respuesta cacheada (string JSON).
   * Si no existe, la reserva con `pending` y devuelve null.
   */
  async checkAndReserve(key: string): Promise<string | null> {
    const redisKey = `idem:${key}`
    const reserved = await this.redis.set(redisKey, 'pending', 'EX', this.ttlSeconds, 'NX')
    if (reserved === 'OK') return null
    return await this.redis.get(redisKey)
  }

  async store(key: string, response: any): Promise<void> {
    try {
      await this.redis.set(`idem:${key}`, JSON.stringify(response), 'EX', this.ttlSeconds)
    } catch (err: any) {
      this.logger.warn(`no se pudo guardar respuesta idempotente: ${err?.message}`)
    }
  }

  async release(key: string): Promise<void> {
    try { await this.redis.del(`idem:${key}`) } catch { /* noop */ }
  }
}
