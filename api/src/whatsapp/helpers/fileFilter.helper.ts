
/**
 * Filtro de multer. Se aceptan todos los tipos (el gateway reenvía documentos
 * arbitrarios), pero se rechazan nombres vacíos. Los límites de tamaño y
 * cantidad van en `limits` del interceptor, no aquí.
 */
export const fileFilter = ( _req: Express.Request, file: Express.Multer.File, callback: Function ) => {

  if ( !file || !file.originalname ) return callback( new Error('Archivo vacío'), false );

  return callback( null, true )
}
