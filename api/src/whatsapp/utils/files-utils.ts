import * as fs from 'fs-extra';
import * as path from 'path';

export async function deleteFilesInFolder(carpeta: string) {
  const exists = await fs.pathExists(carpeta);
  if (!exists) return;

  const archivos = await fs.readdir(carpeta);

  for (const archivo of archivos) {
    const ruta = path.join(carpeta, archivo);
    await fs.remove(ruta);
  }
}

export async function getFileTypeWithValidation(url) {
  try {
    // 1. Hacemos una petición HEAD (más eficiente que GET para solo verificar)
    const response = await fetch(url, {
      method: 'HEAD',
      mode: 'no-cors', // Intenta evitar CORS, pero no siempre funciona
      redirect: 'follow'
    });

    // 2. Verificamos si la URL es válida (códigos 2xx = éxito)
    if (!response.ok) {
      throw new Error(`La URL no es válida (HTTP ${response.status})`);
    }

    // 3. Obtenemos el tipo desde Content-Type (método más confiable)
    const contentType = response.headers.get('Content-Type');
    if (contentType) {
      if (contentType.includes('image/')) return { type: 'image', isValid: true };
      if (contentType.includes('audio/')) return { type: 'audio', isValid: true };
      if (contentType.includes('video/')) return { type: 'video', isValid: true };
      if (contentType === 'application/pdf') return { type: 'pdf', isValid: true };
      if (contentType.includes('xml')) return { type: 'xml', isValid: true };
    }

    // 4. Si no hay Content-Type, intentamos con la extensión en la URL
    const typeFromUrl = getFileTypeFromUrl(url);
    if (typeFromUrl !== 'unknown') {
      return { type: typeFromUrl, isValid: true };
    }

    // 5. Si no se pudo determinar, pero la URL es válida
    return { type: 'unknown', isValid: true };

  } catch (error) {
    return {
      type: 'unknown',
      isValid: false,
      error: error.message
    };
  }
}

// Función auxiliar para extraer tipo desde la URL (como antes)
function getFileTypeFromUrl(url) {
  const extension = url.split('.').pop().split(/[#?]/)[0].toLowerCase();
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
  const audioExts = ['mp3', 'wav', 'ogg', 'aac'];
  const videoExts = ['mp4', 'webm', 'avi', 'mov', 'mkv'];

  if (imageExts.includes(extension)) return 'image';
  if (audioExts.includes(extension)) return 'audio';
  if (videoExts.includes(extension)) return 'video';
  if (extension === 'pdf') return 'pdf';
  if (extension === 'xml') return 'xml';

  return 'unknown';
}

// await fs.remove(authPath)  --> borrar completamente
