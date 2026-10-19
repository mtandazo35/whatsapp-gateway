import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import * as path from 'path'
import { deleteOldFilesInFolder } from './whatsapp/utils/files-utils';

const MAX_AGE_MS = 24 * 60 * 60 * 1000

@Processor('clean-file-queue')
export class CleanFilesQueueProcessor {

  private readonly logger = new Logger(CleanFilesQueueProcessor.name)

  @Process('cleanFiles')
  async cleanFiles() {
    try {
      const pathFolder = path.resolve('static')
      const borrados = await deleteOldFilesInFolder(pathFolder, MAX_AGE_MS)
      this.logger.log(`Limpieza de static/: ${borrados} archivo(s) con más de 24 h eliminados`)
    } catch (error) {
      this.logger.error('Falló la limpieza de la carpeta static', error)
      throw error
    }
  }
}
