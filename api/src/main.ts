import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

/** Rutas que el healthcheck de compose y los balanceadores llaman sin parar: no se registran. */
const RUTAS_SILENCIOSAS = new Set(['/api/health', '/api/ready'])

async function bootstrap() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    // Sin secreto no hay autenticacion que valga: mejor no arrancar.
    throw new Error('JWT_SECRET no definido o demasiado corto (minimo 32 caracteres)');
  }

  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api')

  // Un salto de proxy (Caddy en la misma red de compose): req.ip pasa a ser la IP
  // real del cliente via X-Forwarded-For, que es lo que usa el rate limit.
  app.getHttpAdapter().getInstance().set('trust proxy', +(process.env.TRUST_PROXY_HOPS ?? 1))

  // Request-Id + línea de acceso por petición: método, ruta, código, ms, usuario, IP.
  // Permite seguir una petición de punta a punta (el id vuelve en X-Request-Id).
  const access = new Logger('HTTP')
  app.use((req: Request, res: Response, next: NextFunction) => {
    const recibido = req.headers['x-request-id']
    const rid = (typeof recibido === 'string' && recibido.slice(0, 64)) || randomUUID()
    ;(req as any).requestId = rid
    res.setHeader('X-Request-Id', rid)
    const inicio = process.hrtime.bigint()
    res.on('finish', () => {
      if (RUTAS_SILENCIOSAS.has(req.path)) return
      const ms = Number(process.hrtime.bigint() - inicio) / 1e6
      const user = (req as any).user?.id ?? '-'
      const linea = `${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${ms.toFixed(1)}ms user=${user} ip=${req.ip} rid=${rid}`
      if (res.statusCode >= 500) access.error(linea)
      else if (res.statusCode >= 400) access.warn(linea)
      else access.log(linea)
    })
    next()
  })

  // El frontend se sirve desde el mismo origen (Caddy), asi que CORS solo se
  // abre si el operador lo pide explicitamente para otros origenes.
  const corsOrigin = process.env.CORS_ORIGIN?.split(',').map(s => s.trim()).filter(Boolean)
  if (corsOrigin?.length) {
    app.enableCors({ origin: corsOrigin, credentials: true })
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true
    })
  );

  // Cierra sockets, colas y conexiones al recibir SIGTERM (docker stop).
  app.enableShutdownHooks()

  await app.listen(process.env.PORT || 3005);
  new Logger('Bootstrap').log(`API escuchando en el puerto ${process.env.PORT || 3005}`)
}
bootstrap();
