import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WhatsappService } from './whatsapp.service';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappSessionManager } from './whatsapp-session-manager';
import { SessionModule } from 'src/session/session.module';
import { MessagesModule } from 'src/messages/messages.module';
import { SendFileQueueProcessor } from './send-file-queue.processor';
import { BullModule } from '@nestjs/bull';
import { WebhookService } from './webhook.service';
import { IdempotencyService } from './idempotency.service';
import { Message } from 'src/messages/entities/message.entity';

@Module({
  controllers: [WhatsappController],
  providers: [
    WhatsappService,
    WhatsappSessionManager,
    SendFileQueueProcessor,
    WebhookService,
    IdempotencyService,
  ],
  imports: [
    SessionModule,
    MessagesModule,
    TypeOrmModule.forFeature([Message]),
    BullModule.registerQueueAsync({ name: 'send-file' }),
  ]
})
export class WhatsappModule {}
