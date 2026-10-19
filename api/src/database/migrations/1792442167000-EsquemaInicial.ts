import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Esquema completo a fecha de la versión 0.2.0.
 *
 * Es idempotente a propósito (IF NOT EXISTS en todo): las instalaciones anteriores
 * crearon las tablas con DB_SYNC=true y no tienen tabla `migrations`. Al arrancar
 * con migraciones, esta se ejecuta sobre ese esquema ya existente y solo añade lo
 * que falte (owner_id, last_error, índice, unique, defaults nuevos). En una base
 * vacía crea todo.
 *
 * A partir de aquí, cada cambio de entidad va en una migración nueva:
 *   npm run migration:generate -- NombreDelCambio
 */
export class EsquemaInicial1792442167000 implements MigrationInterface {
  name = 'EsquemaInicial1792442167000';

  public async up(q: QueryRunner): Promise<void> {
    // ---- tipos enum (TypeORM los nombra <tabla>_<columna>_enum) ----
    await q.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'users_rol_enum') THEN
        CREATE TYPE "users_rol_enum" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'USUARIO');
      END IF;
    END $$;`);

    await q.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sessions_status_enum') THEN
        CREATE TYPE "sessions_status_enum" AS ENUM ('open', 'close', 'connecting', 'not_started');
      END IF;
    END $$;`);

    // ---- users ----
    await q.query(`CREATE TABLE IF NOT EXISTS "users" (
      "id"         uuid NOT NULL DEFAULT gen_random_uuid(),
      "email"      text NOT NULL,
      "password"   text NOT NULL,
      "usuario"    text NOT NULL,
      "celular"    text,
      "rol"        "users_rol_enum" NOT NULL DEFAULT 'USUARIO',
      "isActive"   boolean NOT NULL DEFAULT true,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now(),
      "deleted_at" timestamp,
      CONSTRAINT "PK_users_id" PRIMARY KEY ("id")
    )`);
    await q.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"users"'::regclass AND contype = 'u'
                     AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = '"users"'::regclass AND attname = 'email')]) THEN
        ALTER TABLE "users" ADD CONSTRAINT "UQ_users_email" UNIQUE ("email");
      END IF;
    END $$;`);

    // ---- sessions ----
    await q.query(`CREATE TABLE IF NOT EXISTS "sessions" (
      "id"            uuid NOT NULL DEFAULT gen_random_uuid(),
      "owner_id"      uuid,
      "sessionId"     text NOT NULL,
      "nameSession"   text NOT NULL,
      "numberSession" text,
      "status"        "sessions_status_enum" DEFAULT 'not_started',
      "isActive"      boolean NOT NULL DEFAULT true,
      "created_at"    timestamp NOT NULL DEFAULT now(),
      "updated_at"    timestamp NOT NULL DEFAULT now(),
      "deleted_at"    timestamp,
      CONSTRAINT "PK_sessions_id" PRIMARY KEY ("id")
    )`);
    await q.query(`ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "owner_id" uuid`);
    await q.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"sessions"'::regclass AND contype = 'u'
                     AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = '"sessions"'::regclass AND attname = 'sessionId')]) THEN
        ALTER TABLE "sessions" ADD CONSTRAINT "UQ_sessions_sessionId" UNIQUE ("sessionId");
      END IF;
    END $$;`);
    await q.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_sessions_owner_users') THEN
        ALTER TABLE "sessions" ADD CONSTRAINT "FK_sessions_owner_users"
          FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
      END IF;
    END $$;`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_sessions_owner_id" ON "sessions" ("owner_id")`);

    // ---- messages ----
    await q.query(`CREATE TABLE IF NOT EXISTS "messages" (
      "id"            uuid NOT NULL DEFAULT gen_random_uuid(),
      "session_id"    uuid,
      "message"       text NOT NULL,
      "receptor"      text,
      "sent"          boolean NOT NULL DEFAULT false,
      "wa_message_id" character varying(128),
      "status"        character varying(32) NOT NULL DEFAULT 'queued',
      "last_error"    character varying(512),
      "created_at"    timestamp NOT NULL DEFAULT now(),
      "updated_at"    timestamp NOT NULL DEFAULT now(),
      "deleted_at"    timestamp,
      CONSTRAINT "PK_messages_id" PRIMARY KEY ("id")
    )`);
    await q.query(`ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "wa_message_id" character varying(128)`);
    await q.query(`ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "status" character varying(32) NOT NULL DEFAULT 'queued'`);
    await q.query(`ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "last_error" character varying(512)`);
    // Defaults de versiones anteriores (sent=true, status='pending') dejan de aplicar.
    await q.query(`ALTER TABLE "messages" ALTER COLUMN "sent" SET DEFAULT false`);
    await q.query(`ALTER TABLE "messages" ALTER COLUMN "status" SET DEFAULT 'queued'`);
    await q.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"messages"'::regclass AND contype = 'f') THEN
        ALTER TABLE "messages" ADD CONSTRAINT "FK_messages_session_sessions"
          FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
      END IF;
    END $$;`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_messages_wa_message_id" ON "messages" ("wa_message_id")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_messages_session_created" ON "messages" ("session_id", "created_at" DESC)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Solo deshace lo que esta migración añade sobre un esquema anterior; no borra
    // tablas con datos. Para una base vacía, `down` la deja vacía de nuevo.
    await q.query(`DROP INDEX IF EXISTS "IDX_messages_session_created"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_messages_wa_message_id"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_sessions_owner_id"`);
    await q.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "last_error"`);
    await q.query(`ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "FK_sessions_owner_users"`);
    await q.query(`ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "UQ_sessions_sessionId"`);
    await q.query(`ALTER TABLE "sessions" DROP COLUMN IF EXISTS "owner_id"`);

    const vacias = await q.query(
      `SELECT (SELECT count(*) FROM "users") + (SELECT count(*) FROM "sessions") + (SELECT count(*) FROM "messages") AS n`,
    );
    if (Number(vacias?.[0]?.n ?? 1) === 0) {
      await q.query(`DROP TABLE IF EXISTS "messages"`);
      await q.query(`DROP TABLE IF EXISTS "sessions"`);
      await q.query(`DROP TABLE IF EXISTS "users"`);
      await q.query(`DROP TYPE IF EXISTS "sessions_status_enum"`);
      await q.query(`DROP TYPE IF EXISTS "users_rol_enum"`);
    }
  }
}
