import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { WEBHOOK_QUEUE, WebhookService } from './webhook.service';

@Processor(WEBHOOK_QUEUE)
export class WebhookQueueProcessor {
  constructor(private readonly webhook: WebhookService) {}

  @Process('deliver')
  async deliver(job: Job<{ eventId: string }>) {
    const attempts = job.opts?.attempts ?? 1
    const isLast = job.attemptsMade + 1 >= attempts
    await this.webhook.deliver(job.data.eventId, isLast)
  }
}
