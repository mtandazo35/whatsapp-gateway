import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserModule } from './user/user.module';
import { SessionModule } from './session/session.module';
import { MessagesModule } from './messages/messages.module';
import { BullModule } from '@nestjs/bull';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CleanFilesQueueProcessor } from './clean-files-queue.processor';
import { buildDataSourceOptions } from './database/data-source';
import { RATE_LIMIT } from './common/rate-limit';

@Module({
  imports: [
    ConfigModule.forRoot(),
    // Rate limit global por IP (detrás de Caddy, ver trust proxy en main.ts).
    // Los límites finos de login y envíos van con @Throttle en cada ruta.
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: RATE_LIMIT.globalPerMin }],
      errorMessage: 'Demasiadas peticiones, espera un momento',
    }),
    WhatsappModule,
    BullModule.forRoot({
      redis: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: +(process.env.REDIS_PORT ?? 6379),
      }
    }),
    TypeOrmModule.forRoot({
      ...buildDataSourceOptions(),
      autoLoadEntities: true,
    }),
    BullModule.registerQueueAsync({ name: 'clean-file-queue' }),
    UserModule,
    SessionModule,
    MessagesModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    CleanFilesQueueProcessor,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
