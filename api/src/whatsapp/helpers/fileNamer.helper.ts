import { ensureDirSync } from 'fs-extra';
import { randomUUID } from 'crypto';
import { extname } from 'path';

/**
 * Nombre único por archivo subido: UUID + extensión saneada.
 * El nombre original viaja como metadato en el job (originalname) y es el que
 * ve el destinatario; nunca se usa como ruta en disco, asi dos subidas con el
 * mismo nombre no se pisan ni un job puede borrar el archivo de otro.
 */
export const fileNamer = (_req: Express.Request, file: Express.Multer.File, callback: Function) => {
  if (!file) return callback(new Error('Archivo vacío'), false);

  ensureDirSync('./static');

  const ext = extname(file.originalname || '').toLowerCase();
  const extSegura = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';

  callback(null, `${randomUUID()}${extSegura}`);
};
