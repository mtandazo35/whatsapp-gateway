import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserModule } from './user/user.module';
import { SessionModule } from './session/session.module';
import { MessagesModule } from './messages/messages.module';
import { BullModule } from '@nestjs/bull';
import { CleanFilesQueueProcessor } from './clean-files-queue.processor';

@Module({
  imports: [
    ConfigModule.forRoot(),
    WhatsappModule,
    BullModule.forRoot({
      redis: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: +(process.env.REDIS_PORT ?? 6379),
      }
    }),
    TypeOrmModule.forRoot({
      ssl: process.env.POSTGRES_SSL === 'true',
      extra: {
        ssl: process.env.POSTGRES_SSL === 'true'
        ? { rejectUnauthorized: false }
        : null
      },
      type: 'postgres',
      host: process.env.POSTGRES_HOST,
      port: +(process.env.POSTGRES_PORT ?? 5432),
      database: process.env.POSTGRES_DB,
      username: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      autoLoadEntities: true,
      synchronize: process.env.DB_SYNC === 'true' || process.env.STAGE === 'dev'
    }),
    BullModule.registerQueueAsync({ name: 'clean-file-queue' }),
    UserModule,
    SessionModule,
    MessagesModule,
  ],
  controllers: [AppController],
  providers: [AppService, CleanFilesQueueProcessor],
})
export class AppModule {}
