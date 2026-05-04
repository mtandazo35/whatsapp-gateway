import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';

@Controller()
export class AppController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectQueue('clean-file-queue') private readonly cleanQueue: Queue,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() };
  }

  @Get('ready')
  async ready() {
    const checks: Record<string, string> = { db: 'unknown', redis: 'unknown' }

    try {
      await this.dataSource.query('SELECT 1')
      checks.db = 'ok'
    } catch (e: any) {
      checks.db = `fail: ${e?.message ?? 'unknown'}`
    }

    try {
      const client = await this.cleanQueue.client
      const pong = await client.ping()
      checks.redis = pong === 'PONG' ? 'ok' : `fail: ${pong}`
    } catch (e: any) {
      checks.redis = `fail: ${e?.message ?? 'unknown'}`
    }

    const allOk = Object.values(checks).every(v => v === 'ok')
    if (!allOk) throw new ServiceUnavailableException(checks)
    return { status: 'ok', checks }
  }
}
