import * as fs from 'fs-extra';
import * as path from 'path';

/** Borra TODO el contenido de una carpeta (credenciales de una sesión cerrada). */
export async function deleteFilesInFolder(carpeta: string) {
  const exists = await fs.pathExists(carpeta);
  if (!exists) return;

  const archivos = await fs.readdir(carpeta);

  for (const archivo of archivos) {
    const ruta = path.join(carpeta, archivo);
    await fs.remove(ruta);
  }
}

/**
 * Borra solo los archivos con antigüedad mayor a maxAgeMs. Es lo que usa la
 * limpieza diaria de static/: los archivos recién subidos pueden estar en cola.
 * Devuelve cuántos borró.
 */
export async function deleteOldFilesInFolder(carpeta: string, maxAgeMs: number): Promise<number> {
  const exists = await fs.pathExists(carpeta);
  if (!exists) return 0;

  const limite = Date.now() - maxAgeMs;
  const archivos = await fs.readdir(carpeta);
  let borrados = 0;

  for (const archivo of archivos) {
    const ruta = path.join(carpeta, archivo);
    try {
      const stat = await fs.stat(ruta);
      if (stat.mtimeMs < limite) {
        await fs.remove(ruta);
        borrados++;
      }
    } catch {
      // ya no existe o no se puede leer: se ignora
    }
  }

  return borrados;
}

/** Borra una lista de rutas sin lanzar (limpieza de subidas rechazadas). */
export async function removeQuietly(rutas: (string | undefined | null)[]): Promise<void> {
  for (const ruta of rutas) {
    if (!ruta) continue;
    try { await fs.remove(ruta) } catch { /* noop */ }
  }
}
