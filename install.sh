#!/usr/bin/env bash
# Instalador todo-en-uno de whatsapp-gateway.
#
# Uso (Debian/Ubuntu como root o con sudo):
#   bash install.sh
#
# Que hace:
#   1. Pide el dominio (si no esta en .env).
#   2. Instala Docker + compose plugin si faltan.
#   3. Genera .env con secretos aleatorios si no existe (incluye el admin inicial).
#   4. Levanta postgres + redis + api + web (Caddy con SSL automatico).
#   5. Espera a que la API responda.
#
# Requisitos:
#   - Debian/Ubuntu reciente.
#   - Dominio apuntando a la IP de este servidor (registro A).
#   - Puertos 80 y 443 abiertos (Caddy obtiene cert Let's Encrypt).

set -euo pipefail

RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'; BLU='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${GRN}[install]${NC} $*"; }
warn() { echo -e "${YLW}[warn]${NC}    $*" >&2; }
err()  { echo -e "${RED}[error]${NC}   $*" >&2; exit 1; }
hdr()  { echo -e "${BLU}==>${NC} $*"; }

[ "$(id -u)" -eq 0 ] || err "Hay que correr este script como root (sudo bash install.sh)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

COMPOSE_PROJECT="whatsapp-gateway"
ADMIN_GENERADO=0

# Pregunta si/no. Sin terminal (cron, pipe, CI) no bloquea: usa la respuesta por
# defecto que se le pasa como segundo argumento ("n" si no se indica).
ask_yn() {
  local ans
  if [ -t 0 ]; then
    read -rp "$1 [y/N] " ans
  else
    ans="${2:-n}"
  fi
  [[ "${ans,,}" == "y" ]]
}

# Contraseña que cumple la politica de la API (8+, mayuscula, minuscula, numero, simbolo).
gen_admin_password() {
  echo "Wa$(openssl rand -hex 10)!"
}

# =============== 1. DOMINIO ===============
hdr "Configurando dominio"

if [ -f .env ]; then
  set -a; source .env; set +a
fi

if [ -z "${DOMAIN:-}" ] || [ "$DOMAIN" = "ejemplo.midominio.com" ]; then
  echo
  echo "Para que el SSL automatico (Let's Encrypt) funcione, necesitas:"
  echo "  - Un dominio apuntando a la IP de este servidor (registro A en DNS)"
  echo "  - Puertos 80 y 443 abiertos en el firewall"
  echo
  [ -t 0 ] || err "Falta DOMAIN y no hay terminal para preguntarlo: usa DOMAIN=wa.midominio.com bash install.sh"
  read -rp "Ingresa el dominio (ej. wa.midominio.com): " DOMAIN
  DOMAIN="$(echo "$DOMAIN" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
fi

[ -n "$DOMAIN" ] || err "Dominio vacio, abortando"

# Validacion basica del dominio
if ! [[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]]; then
  err "Dominio invalido: $DOMAIN"
fi

log "Dominio: $DOMAIN"

# Verificacion DNS (warning, no aborto)
SERVER_IP="$(curl -s --max-time 5 https://api.ipify.org || echo '?')"
DOMAIN_IP="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || echo '?')"
if [ "$SERVER_IP" != "?" ] && [ "$DOMAIN_IP" != "?" ] && [ "$SERVER_IP" != "$DOMAIN_IP" ]; then
  warn "El dominio resuelve a $DOMAIN_IP pero este servidor tiene IP $SERVER_IP"
  warn "Si no actualizas el DNS, el certificado SSL FALLARA"
  ask_yn "Continuar de todos modos?" || err "Abortado: el dominio no apunta a este servidor"
fi

# =============== 2. DOCKER ===============
hdr "Verificando Docker"
if ! command -v docker >/dev/null 2>&1; then
  log "Instalando Docker..."
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  . /etc/os-release
  case "$ID" in
    debian|ubuntu)
      curl -fsSL "https://download.docker.com/linux/${ID}/gpg" \
        | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
      chmod a+r /etc/apt/keyrings/docker.gpg
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
        > /etc/apt/sources.list.d/docker.list
      ;;
    *)
      err "Distro $ID no soportada por este instalador. Instala Docker manualmente."
      ;;
  esac
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
else
  log "Docker ya instalado: $(docker --version)"
fi

docker compose version >/dev/null 2>&1 || err "docker compose plugin no disponible"

# =============== 3. .env ===============
hdr "Configurando .env"

if [ ! -f .env ]; then
  log "Generando .env con secretos aleatorios..."
  POSTGRES_PASSWORD="$(openssl rand -hex 16)"
  JWT_SECRET="$(openssl rand -hex 32)"
  ADMIN_EMAIL="admin@${DOMAIN}"
  ADMIN_PASSWORD="$(gen_admin_password)"
  ADMIN_GENERADO=1
  cat > .env <<EOF
DOMAIN=${DOMAIN}

POSTGRES_USER=whatsapp
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=whatsapp
# Solo en primer boot. Cambia a false despues para no perder columnas.
DB_SYNC=true

JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=8h

# Administrador inicial (solo se usa si la tabla de usuarios esta vacia)
ADMIN_EMAIL=${ADMIN_EMAIL}
ADMIN_PASSWORD=${ADMIN_PASSWORD}

# Origenes CORS permitidos (vacio = desactivado; el frontend va por el mismo dominio)
CORS_ORIGIN=

# Webhook saliente opcional (mensajes entrantes + estado de sesion/mensajes)
WEBHOOK_URL=
WEBHOOK_SECRET=

# Retencion de respaldos generados por scripts/backup.sh
BACKUP_RETENTION_DAYS=30
EOF
  chmod 600 .env
  log ".env creado (chmod 600). NO commitear este archivo."
  log "Para activar webhook: edita WEBHOOK_URL en .env y reinicia el api."
else
  # Asegurar que DOMAIN esta actualizado
  if grep -q "^DOMAIN=" .env; then
    sed -i "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" .env
  else
    echo "DOMAIN=${DOMAIN}" >> .env
  fi

  # Instalaciones anteriores a la autenticacion: añadir el admin inicial si falta.
  if ! grep -q "^ADMIN_EMAIL=" .env; then
    ADMIN_EMAIL="admin@${DOMAIN}"
    ADMIN_PASSWORD="$(gen_admin_password)"
    ADMIN_GENERADO=1
    {
      echo
      echo "# Administrador inicial (solo se usa si la tabla de usuarios esta vacia)"
      echo "ADMIN_EMAIL=${ADMIN_EMAIL}"
      echo "ADMIN_PASSWORD=${ADMIN_PASSWORD}"
    } >> .env
    log "Añadidos ADMIN_EMAIL / ADMIN_PASSWORD a .env"
  fi

  log ".env ya existe, actualizando solo lo necesario"
fi

# =============== 4. CARPETAS DE DATOS ===============
mkdir -p data/sesiones data/static data/backups
# UID 1000 (node) dentro del container
chown -R 1000:1000 data/sesiones data/static || true
chmod 700 data/backups || true

# =============== 5. CHEQUEO DE PUERTOS ===============
hdr "Verificando puertos 80/443"
for p in 80 443; do
  if ss -tln | awk '{print $4}' | grep -qE ":${p}$"; then
    HOLDER="$(ss -tlnp 2>/dev/null | awk -v p=":${p}$" '$4 ~ p {print $NF; exit}')"
    warn "Puerto ${p} ya esta en uso por: ${HOLDER}"
    warn "Caddy NO podra obtener SSL si el puerto esta ocupado"
    ask_yn "Continuar igualmente?" || err "Libera el puerto ${p} y reintenta"
  fi
done

# =============== 6. UP -d ===============
hdr "Construyendo y levantando contenedores"
docker compose -p "$COMPOSE_PROJECT" up -d --build

# =============== 7. HEALTHCHECK ===============
hdr "Esperando a que la API responda (/api/health)"
ATTEMPTS=30
for i in $(seq 1 $ATTEMPTS); do
  CODE="$(docker compose -p "$COMPOSE_PROJECT" exec -T api curl -s -o /dev/null -w "%{http_code}" \
    http://127.0.0.1:3005/api/health 2>/dev/null || echo "000")"
  if [ "$CODE" = "200" ]; then
    log "API healthy (HTTP $CODE)"
    break
  fi
  sleep 2
  if [ "$i" = "$ATTEMPTS" ]; then
    warn "La API no respondio despues de $((ATTEMPTS*2))s"
    warn "Logs: docker compose -p $COMPOSE_PROJECT logs --tail=50 api"
    exit 1
  fi
done

hdr "Esperando a que Caddy obtenga el certificado SSL (~30s)"
sleep 15
ATTEMPTS=20
HTTPS_OK=0
for i in $(seq 1 $ATTEMPTS); do
  CODE="$(curl -sk -o /dev/null -w "%{http_code}" "https://${DOMAIN}/" 2>/dev/null || echo "000")"
  if [ "$CODE" = "200" ] || [ "$CODE" = "301" ] || [ "$CODE" = "302" ]; then
    log "HTTPS respondiendo en https://${DOMAIN} (HTTP $CODE)"
    HTTPS_OK=1
    break
  fi
  sleep 3
done

if [ "$HTTPS_OK" != "1" ]; then
  warn "HTTPS aun no responde. Revisa que el dominio resuelve y los puertos 80/443 estan abiertos."
  warn "Logs de Caddy: docker compose -p ${COMPOSE_PROJECT} logs web"
  if [[ "$DOMAIN" =~ ^[0-9.]+$ ]]; then
    warn "DOMAIN es una IP: Caddy dentro de Docker no puede servir TLS por IP (ve la IP interna del contenedor). Usa un nombre DNS."
  fi
fi

# =============== 8. BACKUP CRON (opcional) ===============
hdr "Backup automatico"
CRON_FILE="/etc/cron.d/whatsapp-gateway-backup"
if [ -f "$CRON_FILE" ]; then
  log "Cron de backup ya instalado en $CRON_FILE"
else
  # Sin terminal decide INSTALL_BACKUP_CRON=y|n (por defecto n).
  if ask_yn "Instalar cron diario de backup (3:00 AM)?" "${INSTALL_BACKUP_CRON:-n}"; then
    cat > "$CRON_FILE" <<EOF
# Respaldo diario de whatsapp-gateway (Postgres + sesiones Baileys)
0 3 * * * root cd ${SCRIPT_DIR} && bash scripts/backup.sh >> /var/log/wa-gateway-backup.log 2>&1
EOF
    chmod 644 "$CRON_FILE"
    log "Cron instalado en $CRON_FILE"
  else
    log "Saltado. Para correr a mano: bash scripts/backup.sh"
  fi
fi

# =============== 9. RESUMEN ===============
echo
log "=========================================="
log "  Instalacion completa"
log "=========================================="
log "  Frontend:        https://${DOMAIN}/"
log "  API:             https://${DOMAIN}/api"
log "  Health:          https://${DOMAIN}/api/health"
log "  Compose project: ${COMPOSE_PROJECT}"
echo
if [ "$ADMIN_GENERADO" = "1" ]; then
  log "  Usuario inicial: ${ADMIN_EMAIL}"
  log "  Contraseña:      ${ADMIN_PASSWORD}"
  warn "  Guarda la contraseña y cambiala tras el primer login (PATCH /api/user/me)."
  warn "  Si la BD ya tenia usuarios, estas credenciales NO se aplican."
else
  log "  Usuario inicial: ver ADMIN_EMAIL / ADMIN_PASSWORD en .env (solo valen si la BD estaba vacia)"
fi
echo
log "  Logs API:        docker compose -p ${COMPOSE_PROJECT} logs -f api"
log "  Logs web/Caddy:  docker compose -p ${COMPOSE_PROJECT} logs -f web"
log "  Reiniciar:       docker compose -p ${COMPOSE_PROJECT} restart"
log "  Bajar todo:      docker compose -p ${COMPOSE_PROJECT} down"
log "  Backup manual:   bash scripts/backup.sh"
log "  Webhook:         editar WEBHOOK_URL en .env y reiniciar"
log "=========================================="
