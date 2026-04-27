import { ensureDirSync } from 'fs-extra';

export const fileNamer = (req: Express.Request, file: Express.Multer.File, callback: Function) => {
  if (!file) return callback(new Error('File is empty'), false);

  const folders = ['./static'];
  folders.forEach(folder => ensureDirSync(folder));

  const fileName = file.originalname;

  callback(null, fileName);
};