#!/usr/bin/env bash
# Respaldo diario de Postgres + carpeta de sesiones de Baileys.
#
# Uso: bash scripts/backup.sh
# Sugerencia: agendar con cron en el host.
#   0 3 * * *  cd /ruta/whatsapp-gateway && bash scripts/backup.sh >> /var/log/wa-gateway-backup.log 2>&1
#
# Que hace:
#   1. pg_dump del POSTGRES_DB ejecutado dentro del container postgres
#   2. tar.gz de data/sesiones (credenciales de Baileys)
#   3. Borra respaldos > RETENTION_DAYS (default 30)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

[ -f .env ] || { echo "[backup] .env no encontrado en $SCRIPT_DIR" >&2; exit 1; }
set -a; source .env; set +a

COMPOSE_PROJECT="${COMPOSE_PROJECT:-whatsapp-gateway}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
DATE="$(date +%Y-%m-%d_%H%M)"
BACKUP_DIR="${SCRIPT_DIR}/data/backups/${DATE}"

mkdir -p "$BACKUP_DIR"

echo "[backup] $(date -Iseconds) iniciando respaldo en $BACKUP_DIR"

# 1. Postgres dump (formato custom comprimido)
SQL_FILE="$BACKUP_DIR/${POSTGRES_DB}.dump"
docker compose -p "$COMPOSE_PROJECT" exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -F c \
  > "$SQL_FILE"

if [ -s "$SQL_FILE" ]; then
  echo "[backup] postgres OK ($(du -h "$SQL_FILE" | cut -f1))"
else
  echo "[backup] ERROR: dump de postgres vacio" >&2
  rm -f "$SQL_FILE"
  exit 1
fi

# 2. Sesiones de Baileys (creds.json + keys)
if [ -d "${SCRIPT_DIR}/data/sesiones" ]; then
  SESS_FILE="$BACKUP_DIR/sesiones.tgz"
  tar -czf "$SESS_FILE" -C "${SCRIPT_DIR}/data" sesiones
  echo "[backup] sesiones OK ($(du -h "$SESS_FILE" | cut -f1))"
else
  echo "[backup] no hay carpeta data/sesiones, se omite"
fi

# 3. Limpieza de respaldos antiguos
find "${SCRIPT_DIR}/data/backups" -mindepth 1 -maxdepth 1 -type d -mtime +"$RETENTION_DAYS" -exec rm -rf {} + 2>/dev/null || true

echo "[backup] $(date -Iseconds) listo"
