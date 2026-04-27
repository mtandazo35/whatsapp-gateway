import { InjectQueue } from '@nestjs/bull';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bull';
import { randomUUID } from 'crypto';

@Injectable()
export class AppService implements OnModuleInit {

  constructor(
    @InjectQueue('clean-file-queue')
    private cleanFilesQueue: Queue,
  ){}

  async onModuleInit() {
    this.cleanFiles()
    this.restartAPI()
    this.backupsDB()
  }

  cleanFiles() {
    try {
      this.cleanFilesQueue.add(
        'cleanFiles',
        {},
        {
          jobId: randomUUID(),
          repeat: { cron: '1 0 * * *' },
          removeOnFail: true,
          removeOnComplete: true,
          attempts: 1
        },
      );
    } catch (error) {}
  }

  restartAPI() {
    try {
      this.cleanFilesQueue.add(
        'restartAPI',
        {},
        {
          repeat: { cron: '10 0 * * *' },
          removeOnFail: false,
          removeOnComplete: false
        },
      );
    } catch (error) {}
  }

  backupsDB() {
    try {
      this.cleanFilesQueue.add(
        'backupsDB',
        {},
        {
          repeat: { cron: '0 0 * * *' },
          removeOnFail: false,
          removeOnComplete: false
        },
      );
    } catch (error) {}
  }

}
