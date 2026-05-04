import { Process, Processor } from '@nestjs/bull';
import * as path from 'path'
import { deleteFilesInFolder } from './whatsapp/utils/files-utils';

@Processor('clean-file-queue')
export class CleanFilesQueueProcessor {

  constructor() {}

  @Process('cleanFiles')
  async cleanFiles() {
    try {
      const pathFolder = path.resolve('static')
      deleteFilesInFolder(pathFolder)
    } catch (error) {
      console.error('fallo al limpiar la carpeta static', error)
    }
  }
}
