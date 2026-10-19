import { Throttle } from '@nestjs/throttler';

function entero(nombre: string, porDefecto: number): number {
  const v = Number(process.env[nombre]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : porDefecto;
}

/**
 * Límites por minuto y por IP de origen. Se leen una vez al arrancar.
 *  - global: cualquier ruta (protege de barridos y bucles rotos)
 *  - login: frena la fuerza bruta (bcrypt ya cuesta ~70 ms, esto lo remata)
 *  - send: envíos de texto y multimedia; también protege al número de WhatsApp
 */
export const RATE_LIMIT = {
  globalPerMin: entero('RATE_LIMIT_GLOBAL_PER_MIN', 600),
  loginPerMin: entero('RATE_LIMIT_LOGIN_PER_MIN', 10),
  sendPerMin: entero('RATE_LIMIT_SEND_PER_MIN', 120),
};

export const ThrottleLogin = () => Throttle({ default: { limit: RATE_LIMIT.loginPerMin, ttl: 60_000 } });
export const ThrottleSend = () => Throttle({ default: { limit: RATE_LIMIT.sendPerMin, ttl: 60_000 } });
