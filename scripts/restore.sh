#!/usr/bin/env bash
# Restaura un respaldo creado por scripts/backup.sh sobre el stack levantado.
#
# Uso: bash scripts/restore.sh data/backups/2026-10-19_0300 [--sin-redis] [--si]
#
#   --sin-redis  no restaura las colas de Redis (solo BD y credenciales)
#   --si         no pide confirmacion (para pruebas automatizadas)
#
# Que hace, en orden:
#   1. verifica MANIFEST.sha256 y descifra si hace falta (BACKUP_ENCRYPT_PASSPHRASE)
#   2. para la API (los workers no deben escribir durante la restauracion)
#   3. pg_restore --clean sobre la BD actual
#   4. reemplaza data/sesiones por las del respaldo
#   5. (opcional) carga redis.rdb y reinicia redis
#   6. arranca la API y espera /api/health
# La BD actual se respalda antes en data/backups/pre-restore_<fecha>/ por si hay que volver atras.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

SRC="${1:-}"; shift || true
SIN_REDIS=0; SI=0
for a in "$@"; do
  case "$a" in
    --sin-redis) SIN_REDIS=1 ;;
    --si) SI=1 ;;
    *) echo "argumento desconocido: $a" >&2; exit 2 ;;
  esac
done

[ -n "$SRC" ] && [ -d "$SRC" ] || { echo "uso: bash scripts/restore.sh <carpeta-de-respaldo> [--sin-redis] [--si]" >&2; exit 2; }
[ -f .env ] || { echo "[restore] .env no encontrado" >&2; exit 1; }
set -a; source .env; set +a

COMPOSE_PROJECT="${COMPOSE_PROJECT:-whatsapp-gateway}"
PASS="${BACKUP_ENCRYPT_PASSPHRASE:-}"
log() { echo "[restore] $(date -Iseconds) $*"; }
die() { echo "[restore] ERROR: $*" >&2; exit 1; }

SRC="$(cd "$SRC" && pwd)"
log "respaldo: $SRC"
[ -f "$SRC/INFO.txt" ] && sed 's/^/  /' "$SRC/INFO.txt"

# 1. Integridad y descifrado a un directorio temporal
WORK="$(mktemp -d "${SCRIPT_DIR}/data/backups/.restore-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"

if [ -f "$SRC/MANIFEST.sha256" ]; then
  ( cd "$SRC" && sha256sum -c --quiet MANIFEST.sha256 ) || die "el manifiesto no cuadra: respaldo corrupto o manipulado"
  log "integridad OK"
else
  log "AVISO: sin MANIFEST.sha256, no se verifica integridad"
fi

for f in "$SRC"/*; do
  base="$(basename "$f")"
  case "$base" in
    MANIFEST.sha256|INFO.txt) continue ;;
    *.enc)
      [ -n "$PASS" ] || die "respaldo cifrado y BACKUP_ENCRYPT_PASSPHRASE vacia"
      BACKUP_ENCRYPT_PASSPHRASE="$PASS" openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
        -in "$f" -out "$WORK/${base%.enc}" -pass env:BACKUP_ENCRYPT_PASSPHRASE || die "no se pudo descifrar $base (clave incorrecta?)"
      ;;
    *) cp "$f" "$WORK/$base" ;;
  esac
done
[ -f "$WORK/whatsapp.dump" ] || die "el respaldo no contiene whatsapp.dump"
log "archivos listos: $(ls "$WORK" | tr '\n' ' ')"

if [ "$SI" != "1" ]; then
  echo
  echo "Se va a SOBRESCRIBIR la base de datos y las credenciales de WhatsApp actuales."
  read -rp "Escribe RESTAURAR para continuar: " ans
  [ "$ans" = "RESTAURAR" ] || die "cancelado"
fi

# 2. Respaldo previo de lo actual y parada de la API
PRE="${SCRIPT_DIR}/data/backups/pre-restore_$(date +%Y-%m-%d_%H%M%S)"
mkdir -p "$PRE" && chmod 700 "$PRE"
docker compose -p "$COMPOSE_PROJECT" exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -F c > "$PRE/whatsapp.dump" || die "no se pudo respaldar la BD actual"
[ -d data/sesiones ] && tar -czf "$PRE/sesiones.tgz" -C data sesiones 2>/dev/null || true
log "estado previo guardado en $PRE"

log "parando la API"
docker compose -p "$COMPOSE_PROJECT" stop api >/dev/null

# 3. Base de datos
log "restaurando postgres"
docker compose -p "$COMPOSE_PROJECT" exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --no-privileges < "$WORK/whatsapp.dump" \
  || log "pg_restore devolvio avisos (normal si habia objetos inexistentes); revisa arriba si hay ERROR"

# 4. Credenciales de Baileys
if [ -f "$WORK/sesiones.tgz" ]; then
  rm -rf data/sesiones && mkdir -p data/sesiones
  tar -xzf "$WORK/sesiones.tgz" -C data
  chown -R 1000:1000 data/sesiones || true
  log "sesiones restauradas: $(ls data/sesiones | wc -l) carpeta(s)"
else
  log "el respaldo no trae sesiones; se conservan las actuales"
fi

# 5. Redis
if [ "$SIN_REDIS" != "1" ] && [ -f "$WORK/redis.rdb" ]; then
  log "restaurando redis"
  docker compose -p "$COMPOSE_PROJECT" stop redis >/dev/null
  REDIS_CID="$(docker compose -p "$COMPOSE_PROJECT" ps -a -q redis)"
  docker cp "$WORK/redis.rdb" "${REDIS_CID}:/data/dump.rdb"
  # Con appendonly activo Redis carga el AOF, no el RDB: se retira el AOF para que use el snapshot restaurado.
  docker run --rm --volumes-from "$REDIS_CID" alpine sh -c 'rm -rf /data/appendonlydir /data/appendonly.aof* 2>/dev/null; chown 999:999 /data/dump.rdb' >/dev/null 2>&1 || true
  docker compose -p "$COMPOSE_PROJECT" start redis >/dev/null
fi

# 6. Arranque y comprobacion
log "arrancando la API"
docker compose -p "$COMPOSE_PROJECT" start api >/dev/null
for i in $(seq 1 30); do
  if docker compose -p "$COMPOSE_PROJECT" exec -T api curl -sf http://127.0.0.1:3005/api/health >/dev/null 2>&1; then
    log "API arriba tras $((i*2)) s"
    USUARIOS="$(docker compose -p "$COMPOSE_PROJECT" exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc 'SELECT count(*) FROM users' | tr -d '[:space:]')"
    log "usuarios en la BD restaurada: $USUARIOS"
    log "listo. Si algo salio mal: bash scripts/restore.sh $PRE --si"
    exit 0
  fi
  sleep 2
done
die "la API no respondio tras la restauracion: docker compose -p $COMPOSE_PROJECT logs api"
