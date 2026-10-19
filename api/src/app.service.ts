import { InjectQueue } from '@nestjs/bull';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bull';

/** Id fijo: Bull deduplica los repetibles por (nombre, jobId, cron), asi cada reinicio no suma otro. */
export const CLEAN_FILES_JOB_ID = 'clean-files-daily'

@Injectable()
export class AppService implements OnModuleInit {

  private readonly logger = new Logger(AppService.name)

  constructor(
    @InjectQueue('clean-file-queue')
    private cleanFilesQueue: Queue,
  ){}

  async onModuleInit() {
    await this.cleanFiles()
  }

  /**
   * Limpieza diaria de static/: borra solo archivos con mas de 24 h, asi no se
   * lleva por delante subidas que todavia estan en cola.
   * Los antiguos jobs restartAPI y backupsDB se eliminaron: no tenian handler y
   * solo generaban un fallo diario en Redis. El backup lo hace scripts/backup.sh por cron.
   */
  async cleanFiles() {
    try {
      await this.cleanFilesQueue.add(
        'cleanFiles',
        {},
        {
          jobId: CLEAN_FILES_JOB_ID,
          repeat: { cron: '1 0 * * *' },
          removeOnFail: true,
          removeOnComplete: true,
          attempts: 1
        },
      );
    } catch (error) {
      this.logger.warn(`No se pudo programar la limpieza diaria: ${error?.message}`)
    }
  }

}
