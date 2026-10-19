import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    // Sin secreto no hay autenticacion que valga: mejor no arrancar.
    throw new Error('JWT_SECRET no definido o demasiado corto (minimo 32 caracteres)');
  }

  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api')

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
