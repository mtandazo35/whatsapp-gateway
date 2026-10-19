import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0.3.0:
 *  - messages: tipo de envío (kind), caption, fast_mode y quién lo pidió (requested_by)
 *    para poder reintentar y auditar.
 *  - webhook_events: cola persistente de eventos salientes (replay, DLQ).
 */
export class WebhooksYAuditoria1792450000000 implements MigrationInterface {
  name = 'WebhooksYAuditoria1792450000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "kind" character varying(16) NOT NULL DEFAULT 'text'`);
    await q.query(`ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "caption" text`);
    await q.query(`ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "fast_mode" boolean NOT NULL DEFAULT false`);
    await q.query(`ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "requested_by" uuid`);
    await q.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_messages_requested_by_users') THEN
        ALTER TABLE "messages" ADD CONSTRAINT "FK_messages_requested_by_users"
          FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
      END IF;
    END $$;`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_messages_status_created" ON "messages" ("status", "created_at")`);

    await q.query(`CREATE TABLE IF NOT EXISTS "webhook_events" (
      "id"         uuid NOT NULL DEFAULT gen_random_uuid(),
      "event"      character varying(64) NOT NULL,
      "payload"    jsonb NOT NULL,
      "status"     character varying(16) NOT NULL DEFAULT 'pending',
      "attempts"   integer NOT NULL DEFAULT 0,
      "last_error" character varying(512),
      "sent_at"    timestamp,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now(),
      CONSTRAINT "PK_webhook_events_id" PRIMARY KEY ("id")
    )`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_webhook_events_status_created" ON "webhook_events" ("status", "created_at")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "webhook_events"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_messages_status_created"`);
    await q.query(`ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "FK_messages_requested_by_users"`);
    await q.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "requested_by"`);
    await q.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "fast_mode"`);
    await q.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "caption"`);
    await q.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "kind"`);
  }
}
