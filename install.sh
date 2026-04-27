#!/usr/bin/env bash
# Instalador todo-en-uno de whatsapp-gateway.
#
# Uso (Debian/Ubuntu como root o con sudo):
#   bash install.sh
#
# Que hace:
#   1. Pide el dominio (si no esta en .env).
#   2. Instala Docker + compose plugin si faltan.
#   3. Genera .env con secretos aleatorios si no existe.
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
  read -rp "Continuar de todos modos? [y/N] " ans
  [[ "${ans,,}" == "y" ]] || err "Abortado por el usuario"
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
  cat > .env <<EOF
DOMAIN=${DOMAIN}

POSTGRES_USER=whatsapp
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=whatsapp
DB_SYNC=true

JWT_SECRET=${JWT_SECRET}
EOF
  chmod 600 .env
  log ".env creado (chmod 600). NO commitear este archivo."
else
  # Asegurar que DOMAIN esta actualizado
  if grep -q "^DOMAIN=" .env; then
    sed -i "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" .env
  else
    echo "DOMAIN=${DOMAIN}" >> .env
  fi
  log ".env ya existe, actualizando solo DOMAIN"
fi

# =============== 4. CARPETAS DE DATOS ===============
mkdir -p data/sesiones data/static data/backups
# UID 1000 (node) dentro del container
chown -R 1000:1000 data/sesiones data/static data/backups || true

# =============== 5. CHEQUEO DE PUERTOS ===============
hdr "Verificando puertos 80/443"
for p in 80 443; do
  if ss -tln | awk '{print $4}' | grep -qE ":${p}$"; then
    HOLDER="$(ss -tlnp 2>/dev/null | awk -v p=":${p}$" '$4 ~ p {print $NF; exit}')"
    warn "Puerto ${p} ya esta en uso por: ${HOLDER}"
    warn "Caddy NO podra obtener SSL si el puerto esta ocupado"
    read -rp "Continuar igualmente? [y/N] " ans
    [[ "${ans,,}" == "y" ]] || err "Libera el puerto ${p} y reintenta"
  fi
done

# =============== 6. UP -d ===============
hdr "Construyendo y levantando contenedores"
docker compose -p "$COMPOSE_PROJECT" up -d --build

# =============== 7. HEALTHCHECK ===============
hdr "Esperando a que la API responda"
ATTEMPTS=30
for i in $(seq 1 $ATTEMPTS); do
  CODE="$(docker compose -p "$COMPOSE_PROJECT" exec -T api curl -s -o /dev/null -w "%{http_code}" \
    http://127.0.0.1:3005/api/whatsapp/status-sessions 2>/dev/null || echo "000")"
  if [ "$CODE" = "200" ] || [ "$CODE" = "404" ]; then
    log "API respondiendo (HTTP $CODE)"
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

[ "$HTTPS_OK" = "1" ] || warn "HTTPS aun no responde. Revisa que el dominio resuelve y los puertos 80/443 estan abiertos."

# =============== 8. RESUMEN ===============
echo
log "=========================================="
log "  Instalacion completa"
log "=========================================="
log "  Frontend:        https://${DOMAIN}/"
log "  API:             https://${DOMAIN}/api"
log "  Compose project: ${COMPOSE_PROJECT}"
echo
log "  Logs API:        docker compose -p ${COMPOSE_PROJECT} logs -f api"
log "  Logs web/Caddy:  docker compose -p ${COMPOSE_PROJECT} logs -f web"
log "  Reiniciar:       docker compose -p ${COMPOSE_PROJECT} restart"
log "  Bajar todo:      docker compose -p ${COMPOSE_PROJECT} down"
log "=========================================="
