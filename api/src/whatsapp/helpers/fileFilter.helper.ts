
export const fileFilter = ( req: Express.Request, file: Express.Multer.File, callback: Function ) => {

  if ( !file ) return callback( new Error('File is empty'), false );

  return callback( null, true )
}