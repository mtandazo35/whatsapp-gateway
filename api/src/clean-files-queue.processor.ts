import { Process, Processor } from '@nestjs/bull';
import * as path from 'path'
import { deleteFilesInFolder } from './whatsapp/utils/files-utils';
const { exec } = require('child_process');
import * as fs from 'fs';

@Processor('clean-file-queue')
export class CleanFilesQueueProcessor {

  constructor() {}

  private readonly backupDir = path.join(__dirname, '..', '..', 'backups');
  private readonly password = process.env.POSTGRES_PASSWORD;

  @Process('cleanFiles')
  async cleanFiles() {
    try {
      const pathFolder = path.resolve('static')
      deleteFilesInFolder(pathFolder)
    } catch (error) {
      console.error('fallo al limpiar la carpeta static', error)
    }
  }

  @Process('restartAPI')
  async restartAPI() {
    exec("pm2 restart API-WHATSAPP", (error, stdout, stderr) => {
      if (error) {
        console.error(`Error al ejecutar el comando: ${error.message}`);
        return;
      }
      if (stderr) {
        console.error(`Error en la salida estándar: ${stderr}`);
        return;
      }
      console.log(`Resultado del comando:\n${stdout}`);
    });
  }

  @Process('backupsDB')
  async backupEachDatabase() {
    const date = new Date().toISOString().split('T')[0];
    const todayDir = path.join(this.backupDir, date);
    fs.mkdirSync(todayDir, { recursive: true });

    // 🗑️ limpiar respaldos antiguos (más de 90 días / 3 meses)
    const backupDirs = fs.readdirSync(this.backupDir);

    backupDirs.forEach(dir => {
      const fullPath = path.join(this.backupDir, dir);
      try {
        const stats = fs.statSync(fullPath);

        if (stats.isDirectory()) {
          const dirDate = new Date(dir); // el nombre es yyyy-mm-dd
          if (!isNaN(dirDate.getTime())) {
            const diffDays =
              (Date.now() - dirDate.getTime()) / (1000 * 60 * 60 * 24);
            if (diffDays > 90) {
              fs.rmSync(fullPath, { recursive: true, force: true });
              console.log(`🗑️ Carpeta eliminada por antigüedad: ${fullPath}`);
            }
          }
        }
      } catch (err) {
        console.error(`Error al procesar carpeta ${dir}:`, err.message);
      }
    });

    const listCmd = `PGPASSWORD=${this.password} psql -h localhost -U postgres -t -c "SELECT datname FROM pg_database WHERE datistemplate = false;"`;

    exec(listCmd, (error, stdout, stderr) => {
      if (error) {
        console.error('Error al listar bases:', error.message);
        return;
      }

      const databases = stdout.split('\n').map(db => db.trim()).filter(Boolean);

      databases.forEach(db => {
        const file = path.join(todayDir, `${db}.sql`);
        const cmd = `PGPASSWORD=${this.password} pg_dump -h localhost -U postgres -F c ${db} > ${file}`;

        exec(cmd, (err) => {
          if (err) {
            console.error(`Error al respaldar ${db}:`, err.message);
          } else {
            console.log(`Respaldo de ${db} creado correctamente.`);
          }
        });
      });
    });
  }

}
