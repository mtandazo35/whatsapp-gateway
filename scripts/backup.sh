#!/usr/bin/env bash
# Respaldo de whatsapp-gateway: Postgres + credenciales de Baileys + Redis (colas).
#
# Uso: bash scripts/backup.sh
# Cron:  0 3 * * *  cd /ruta/whatsapp-gateway && bash scripts/backup.sh >> /var/log/wa-gateway-backup.log 2>&1
#
# Variables (.env):
#   BACKUP_RETENTION_DAYS       dias que se conservan los respaldos locales (30)
#   BACKUP_ENCRYPT_PASSPHRASE   si se define, cada archivo se cifra con AES-256 (openssl enc, pbkdf2)
#                               y solo se conserva la version cifrada (.enc)
#   BACKUP_REMOTE_DEST          destino rsync/ssh (user@host:/ruta/) al que se copia el respaldo
#   BACKUP_SSH_KEY              clave privada para el destino remoto (opcional)
#
# Resultado: data/backups/<fecha>/ con whatsapp.dump, sesiones.tgz, redis.rdb, MANIFEST.sha256
# (cada uno con sufijo .enc si hay cifrado). Restaurar con scripts/restore.sh <carpeta>.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

[ -f .env ] || { echo "[backup] .env no encontrado en $SCRIPT_DIR" >&2; exit 1; }
set -a; source .env; set +a

COMPOSE_PROJECT="${COMPOSE_PROJECT:-whatsapp-gateway}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
PASS="${BACKUP_ENCRYPT_PASSPHRASE:-}"
REMOTE="${BACKUP_REMOTE_DEST:-}"
SSH_KEY="${BACKUP_SSH_KEY:-}"
DATE="$(date +%Y-%m-%d_%H%M)"
BACKUP_ROOT="${SCRIPT_DIR}/data/backups"
BACKUP_DIR="${BACKUP_ROOT}/${DATE}"

log() { echo "[backup] $(date -Iseconds) $*"; }
die() { echo "[backup] ERROR: $*" >&2; exit 1; }

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_ROOT" "$BACKUP_DIR"

log "iniciando respaldo en $BACKUP_DIR"

# 1. Postgres (formato custom comprimido, dentro del contenedor)
SQL_FILE="$BACKUP_DIR/whatsapp.dump"
docker compose -p "$COMPOSE_PROJECT" exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -F c > "$SQL_FILE"
[ -s "$SQL_FILE" ] || { rm -f "$SQL_FILE"; die "dump de postgres vacio"; }
log "postgres OK ($(du -h "$SQL_FILE" | cut -f1))"

# 2. Credenciales de Baileys (equivalen al telefono: tratar como secreto)
if [ -d "${SCRIPT_DIR}/data/sesiones" ] && [ -n "$(ls -A "${SCRIPT_DIR}/data/sesiones" 2>/dev/null)" ]; then
  SESS_FILE="$BACKUP_DIR/sesiones.tgz"
  tar -czf "$SESS_FILE" -C "${SCRIPT_DIR}/data" sesiones
  log "sesiones OK ($(du -h "$SESS_FILE" | cut -f1))"
else
  log "sin sesiones vinculadas, se omite"
fi

# 3. Redis (colas pendientes y claves de idempotencia): snapshot y copia
if docker compose -p "$COMPOSE_PROJECT" exec -T redis redis-cli BGSAVE >/dev/null 2>&1; then
  for _ in $(seq 1 30); do
    if docker compose -p "$COMPOSE_PROJECT" exec -T redis redis-cli INFO persistence 2>/dev/null | grep -q 'rdb_bgsave_in_progress:0'; then break; fi
    sleep 1
  done
  REDIS_CID="$(docker compose -p "$COMPOSE_PROJECT" ps -q redis)"
  if docker cp "${REDIS_CID}:/data/dump.rdb" "$BACKUP_DIR/redis.rdb" 2>/dev/null; then
    log "redis OK ($(du -h "$BACKUP_DIR/redis.rdb" | cut -f1))"
  else
    log "redis: no se pudo copiar dump.rdb (se omite)"
  fi
fi

# 4. Metadatos para la restauracion
{
  echo "fecha=$DATE"
  echo "version=$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || echo desconocida)"
  echo "postgres_db=$POSTGRES_DB"
  echo "cifrado=$([ -n "$PASS" ] && echo si || echo no)"
} > "$BACKUP_DIR/INFO.txt"

# 5. Cifrado opcional (AES-256-CBC con PBKDF2; se borra el original)
if [ -n "$PASS" ]; then
  for f in "$BACKUP_DIR"/*.dump "$BACKUP_DIR"/*.tgz "$BACKUP_DIR"/*.rdb; do
    [ -f "$f" ] || continue
    BACKUP_ENCRYPT_PASSPHRASE="$PASS" openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
      -in "$f" -out "$f.enc" -pass env:BACKUP_ENCRYPT_PASSPHRASE
    rm -f "$f"
  done
  log "archivos cifrados (.enc)"
fi

# 6. Manifiesto de integridad
( cd "$BACKUP_DIR" && sha256sum ./* > MANIFEST.sha256 )
chmod 600 "$BACKUP_DIR"/*
log "manifiesto: $(wc -l < "$BACKUP_DIR/MANIFEST.sha256") archivo(s)"

# 7. Copia fuera del host (rsync sobre ssh)
if [ -n "$REMOTE" ]; then
  SSH_OPTS="-o BatchMode=yes -o StrictHostKeyChecking=accept-new"
  [ -n "$SSH_KEY" ] && SSH_OPTS="$SSH_OPTS -i $SSH_KEY"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --chmod=D700,F600 -e "ssh $SSH_OPTS" "$BACKUP_DIR" "$REMOTE" && log "copiado a $REMOTE" || log "ERROR: fallo la copia remota a $REMOTE"
  else
    # shellcheck disable=SC2086
    scp -r $SSH_OPTS "$BACKUP_DIR" "$REMOTE" && log "copiado a $REMOTE (scp)" || log "ERROR: fallo la copia remota a $REMOTE"
  fi
else
  log "AVISO: respaldo solo local; define BACKUP_REMOTE_DEST para sacarlo del host"
fi

# 8. Limpieza de respaldos antiguos
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +"$RETENTION_DAYS" -exec rm -rf {} + 2>/dev/null || true

log "listo: $BACKUP_DIR"
