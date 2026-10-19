import { BadRequestException } from '@nestjs/common'
import { lookup } from 'dns/promises'
import { isIP } from 'net'

/**
 * Defensa anti-SSRF para las URLs que el gateway descarga en nombre del cliente.
 * Reglas:
 *  - solo http/https, sin credenciales en la URL
 *  - nada de localhost, *.local, *.internal, *.localhost
 *  - el host (literal o resuelto por DNS, todas sus direcciones) no puede caer en
 *    rangos privados, loopback, link-local, CGNAT, multicast ni reservados
 *  - las redirecciones se rechazan en la descarga (maxRedirects 0 / redirect manual),
 *    asi un destino publico no puede rebotar hacia dentro
 * Limite conocido: una resolucion DNS que cambie entre la comprobacion y la
 * descarga (rebinding) no se detecta; por eso ademas se vuelve a validar en el worker.
 */

const HOSTS_PROHIBIDOS = new Set(['localhost', 'metadata.google.internal', 'metadata', 'instance-data'])
const SUFIJOS_PROHIBIDOS = ['.localhost', '.local', '.internal', '.lan', '.home.arpa']

export function isPrivateIPv4(ip: string): boolean {
  const partes = ip.split('.').map(Number)
  if (partes.length !== 4 || partes.some(p => Number.isNaN(p) || p < 0 || p > 255)) return true
  const [a, b] = partes
  if (a === 0 || a === 10 || a === 127) return true          // "this", privada, loopback
  if (a === 169 && b === 254) return true                     // link-local / metadata cloud
  if (a === 172 && b >= 16 && b <= 31) return true            // privada
  if (a === 192 && b === 168) return true                     // privada
  if (a === 192 && b === 0) return true                       // 192.0.0.0/24 y 192.0.2.0/24 (doc)
  if (a === 198 && (b === 18 || b === 19)) return true        // benchmarking
  if (a === 100 && b >= 64 && b <= 127) return true           // CGNAT
  if (a >= 224) return true                                   // multicast y reservado
  return false
}

export function isPrivateIPv6(ip: string): boolean {
  const l = ip.toLowerCase()
  if (l === '::' || l === '::1') return true
  if (l.startsWith('::ffff:')) {                              // IPv4 mapeada
    const v4 = l.slice(7)
    return isIP(v4) === 4 ? isPrivateIPv4(v4) : true
  }
  if (l.startsWith('64:ff9b:')) return true                   // NAT64: no se puede verificar el destino real
  if (/^fe[89ab]/.test(l)) return true                        // link-local fe80::/10
  if (/^f[cd]/.test(l)) return true                           // ULA fc00::/7
  if (l.startsWith('ff')) return true                         // multicast
  if (l.startsWith('2001:db8')) return true                   // documentacion
  return false
}

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip)
  if (version === 4) return isPrivateIPv4(ip)
  if (version === 6) return isPrivateIPv6(ip)
  return true
}

/** Valida la URL y resuelve el host. Lanza BadRequest con motivo si no es segura. */
export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new BadRequestException('URL inválida')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BadRequestException('Solo se permiten URLs http o https')
  }
  if (url.username || url.password) {
    throw new BadRequestException('La URL no puede llevar usuario ni contraseña')
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()

  if (!host || HOSTS_PROHIBIDOS.has(host) || SUFIJOS_PROHIBIDOS.some(s => host.endsWith(s))) {
    throw new BadRequestException('Destino de la URL no permitido')
  }

  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new BadRequestException('La URL apunta a una dirección interna')
    }
    return url
  }

  let direcciones: { address: string }[]
  try {
    direcciones = await lookup(host, { all: true })
  } catch {
    throw new BadRequestException('No se pudo resolver el host de la URL')
  }

  if (direcciones.length === 0 || direcciones.some(d => isPrivateAddress(d.address))) {
    throw new BadRequestException('La URL apunta a una dirección interna')
  }

  return url
}

export interface MediaProbe {
  type: 'image' | 'video' | 'audio' | 'document'
  contentType: string | null
  contentLength: number | null
}

/**
 * HEAD a la URL (ya validada) con timeout y sin seguir redirecciones.
 * Devuelve el tipo de medio segun Content-Type.
 */
export async function probeMediaUrl(url: URL, timeoutMs = 10_000): Promise<MediaProbe> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let response: Awaited<ReturnType<typeof fetch>>
  try {
    response = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': 'whatsapp-gateway/1.0' },
    })
  } catch (error) {
    throw new BadRequestException(`No se pudo consultar la URL: ${error?.name === 'AbortError' ? 'tiempo de espera agotado' : error?.message}`)
  } finally {
    clearTimeout(timer)
  }

  if (response.status >= 300 && response.status < 400) {
    throw new BadRequestException('La URL redirige a otro destino; usa la URL final')
  }
  if (!response.ok) {
    throw new BadRequestException(`La URL respondió HTTP ${response.status}`)
  }

  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? null
  const lengthHeader = response.headers.get('content-length')
  const contentLength = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null

  const prefijo = contentType?.split('/')[0]
  const type: MediaProbe['type'] =
    prefijo === 'image' || prefijo === 'video' || prefijo === 'audio' ? prefijo : 'document'

  return { type, contentType, contentLength }
}
