import { Module } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappSessionManager } from './whatsapp-session-manager';
import { SessionModule } from 'src/session/session.module';
import { MessagesModule } from 'src/messages/messages.module';
import { SendFileQueueProcessor } from './send-file-queue.processor';
import { BullModule } from '@nestjs/bull';

@Module({
  controllers: [WhatsappController],
  providers: [WhatsappService, WhatsappSessionManager, SendFileQueueProcessor],
  imports: [
    SessionModule,
    MessagesModule,
    BullModule.registerQueueAsync({ name: 'send-file' }),
  ]
})
export class WhatsappModule {}
