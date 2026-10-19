import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import { join } from 'path';

/**
 * Configuración de conexión compartida por la aplicación (app.module.ts) y por la
 * CLI de TypeORM (scripts migration:* de package.json).
 *
 * Las migraciones viven en src/database/migrations y se compilan a dist/ con el
 * resto del código, así que en producción se cargan como .js.
 */
export function buildDataSourceOptions(): DataSourceOptions {
  const esTs = __filename.endsWith('.ts');

  return {
    type: 'postgres',
    host: process.env.POSTGRES_HOST,
    port: +(process.env.POSTGRES_PORT ?? 5432),
    database: process.env.POSTGRES_DB,
    username: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    ssl: process.env.POSTGRES_SSL === 'true',
    extra: {
      ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : null,
    },
    entities: [join(__dirname, '..', '**', '*.entity.' + (esTs ? 'ts' : 'js'))],
    migrations: [join(__dirname, 'migrations', '*.' + (esTs ? 'ts' : 'js'))],
    migrationsTableName: 'migrations',
    // DB_SYNC=true solo en desarrollo: altera tablas al vuelo y puede borrar columnas.
    synchronize: process.env.DB_SYNC === 'true',
    // Por defecto las migraciones pendientes se aplican al arrancar la API.
    migrationsRun: process.env.DB_MIGRATIONS !== 'false',
    logging: process.env.DB_LOGGING === 'true' ? ['error', 'warn', 'migration'] : ['error', 'migration'],
  };
}

/** Instancia para la CLI: `npm run migration:generate -- NombreDelCambio`. */
export default new DataSource(buildDataSourceOptions());
