import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Public } from './user/decorators';

@Controller()
export class AppController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectQueue('clean-file-queue') private readonly cleanQueue: Queue,
  ) {}

  @Public()
  @Get('health')
  health() {
    return { status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() };
  }

  /**
   * Readiness: BD y Redis. Publico para que el healthcheck de compose y un
   * balanceador puedan consultarlo, pero sin detalles del error hacia fuera.
   */
  @Public()
  @Get('ready')
  async ready() {
    const checks: Record<string, string> = { db: 'unknown', redis: 'unknown' }

    try {
      await this.withTimeout(this.dataSource.query('SELECT 1'), 3000)
      checks.db = 'ok'
    } catch {
      checks.db = 'fail'
    }

    try {
      const client = await this.cleanQueue.client
      const pong = await this.withTimeout(client.ping(), 3000)
      checks.redis = pong === 'PONG' ? 'ok' : 'fail'
    } catch {
      checks.redis = 'fail'
    }

    const allOk = Object.values(checks).every(v => v === 'ok')
    if (!allOk) throw new ServiceUnavailableException({ status: 'degraded', checks })
    return { status: 'ok', checks }
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ])
  }
}
