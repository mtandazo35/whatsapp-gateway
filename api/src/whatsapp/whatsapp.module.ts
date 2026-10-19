import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WhatsappService } from './whatsapp.service';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappSessionManager } from './whatsapp-session-manager';
import { SessionModule } from 'src/session/session.module';
import { MessagesModule } from 'src/messages/messages.module';
import { SendFileQueueProcessor } from './send-file-queue.processor';
import { BullModule } from '@nestjs/bull';
import { WEBHOOK_QUEUE, WebhookService } from './webhook.service';
import { WebhookQueueProcessor } from './webhook-queue.processor';
import { WebhooksController } from './webhooks.controller';
import { IdempotencyService } from './idempotency.service';
import { WebhookEvent } from './entities/webhook-event.entity';
import { StatusController } from './status.controller';

@Module({
  controllers: [WhatsappController, WebhooksController, StatusController],
  providers: [
    WhatsappService,
    WhatsappSessionManager,
    SendFileQueueProcessor,
    WebhookService,
    WebhookQueueProcessor,
    IdempotencyService,
  ],
  imports: [
    SessionModule,
    MessagesModule,
    TypeOrmModule.forFeature([WebhookEvent]),
    BullModule.registerQueueAsync({ name: 'send-file' }),
    BullModule.registerQueueAsync({ name: WEBHOOK_QUEUE }),
    BullModule.registerQueueAsync({ name: 'clean-file-queue' }),
  ],
  exports: [WhatsappService, WebhookService],
})
export class WhatsappModule {}
