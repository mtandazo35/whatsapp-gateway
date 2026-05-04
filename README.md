# whatsapp-gateway

Gateway REST de WhatsApp basado en **NestJS + Baileys**, con frontend web minimalista y
SSL automático vía **Caddy + Let's Encrypt**. Se instala con un solo comando.

## Stack

- **API**: NestJS 10 + Baileys (cliente WhatsApp Web no oficial).
- **Frontend**: HTML + Bootstrap 5 + JS vanilla (sin build step).
- **Storage**: PostgreSQL 16 + Redis 7.
- **Reverse proxy + SSL**: Caddy 2 (auto-renueva el cert).
- **Empaquetado**: Docker compose, instalable de cero en Debian/Ubuntu.

## ⚠️ Requisitos

- **Servidor Debian o Ubuntu** (cualquier versión reciente) — fresh o con poco corriendo.
- **Dominio propio** apuntando a la IP del servidor con un registro `A`.
  - Ejemplo: `wa.miempresa.com` → `1.2.3.4`
  - El SSL se emite vía Let's Encrypt — **sin dominio no funciona HTTPS**.
- **Puertos 80 y 443 abiertos** en el firewall (Caddy los necesita para emitir el cert).
- Acceso `root` (o `sudo`).

## Instalación (un solo comando)

```bash
git clone https://github.com/mtandazo35/whatsapp-gateway.git
cd whatsapp-gateway
sudo bash install.sh
```

El instalador te pregunta el dominio (si no lo tienes en `.env`) y se encarga de todo:

1. Verifica que el dominio resuelve a esta IP (advierte si no).
2. Instala Docker + compose plugin si faltan.
3. Genera `.env` con `POSTGRES_PASSWORD` y `JWT_SECRET` aleatorios.
4. Levanta `postgres`, `redis`, `api` y `web` (Caddy).
5. Espera a que la API responda y a que Caddy emita el cert SSL.

URL final: **`https://<tu-dominio>/`** (frontend) y **`https://<tu-dominio>/api`** (REST).

### Modo no-interactivo

Si quieres saltar el prompt, define `DOMAIN` en `.env` o como env var:

```bash
DOMAIN=wa.miempresa.com sudo -E bash install.sh
```

## Uso del frontend

Abre `https://<tu-dominio>/` en el navegador:

- **Tab Sesion** → click "Vincular WhatsApp" → escanea el QR con tu WhatsApp.
  El modal se cierra solo cuando detecta la conexión.
- **Tab Mensaje** → enviar texto a un número.
- **Tab Archivo** → subir archivo o pasar URL.
- **Tab Verificar numero** → comprueba si un número está en WhatsApp.
- **Tab Historial** → últimos mensajes enviados.

## API REST

Base URL: `https://<tu-dominio>/api`

| Método | Ruta                                | Descripción                        |
|--------|-------------------------------------|------------------------------------|
| POST   | `/session`                          | Crear sesión                       |
| GET    | `/session?page=1&limit=10`          | Listar sesiones                    |
| GET    | `/whatsapp/qr/:sessionId`           | Obtener QR para vincular           |
| GET    | `/whatsapp/status-sessions`         | Estado de todas las sesiones       |
| GET    | `/whatsapp/session/:sessionId/info` | Info de la sesión conectada        |
| POST   | `/whatsapp/send`                    | Enviar mensaje de texto            |
| POST   | `/whatsapp/send-media/url`          | Enviar archivo desde URL           |
| POST   | `/whatsapp/send-media/file`         | Enviar archivos (multipart)        |
| GET    | `/whatsapp/check-number`            | Verificar si un número existe      |
| DELETE | `/whatsapp/session/:sessionId`      | Cerrar sesión / logout             |
| GET    | `/messages?session=<id>`            | Historial de mensajes              |
| GET    | `/health`                           | Liveness (sin checks externos)     |
| GET    | `/ready`                            | Readiness (chequea DB + Redis)     |

⚠️ La API **no tiene autenticación por defecto**. El JWT de `/user/login` está disponible pero
los controllers no validan el token. Si la expones a internet, agrega un firewall a nivel de
red o pon Cloudflare delante con WAF rules.

### Idempotencia en `/whatsapp/send`

Para evitar mensajes duplicados ante reintentos del cliente, manda el header
`Idempotency-Key: <uuid>`. La respuesta queda cacheada en Redis 24h:

```bash
curl -X POST https://<dominio>/api/whatsapp/send \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 7f3e9a2b-..." \
  -d '{"sessionId":"...","number":"5939...","message":"hola"}'
```

Si llega una segunda vez con la misma key se devuelve la respuesta original sin reenviar.

### Webhook saliente (mensajes entrantes + cambios de estado)

Define `WEBHOOK_URL` en `.env` para recibir POSTs con cada evento. Si además defines
`WEBHOOK_SECRET`, el body se firma con HMAC-SHA256 en el header `X-Signature: sha256=<hex>`.

Eventos disparados:

| `event`            | Cuando                                   |
|--------------------|------------------------------------------|
| `message.incoming` | Mensaje recibido en una sesión           |
| `message.update`   | Cambio de estado (sent/delivered/read)   |
| `session.open`     | Sesión vinculada con WhatsApp            |
| `session.close`    | Sesión desconectada                      |

Body de ejemplo:

```json
{
  "event": "message.incoming",
  "timestamp": "2026-05-03T12:34:56.000Z",
  "data": {
    "sessionId": "...",
    "messageId": "3EB0...",
    "from": "5939...",
    "fromJid": "5939...@s.whatsapp.net",
    "type": "conversation",
    "text": "hola"
  }
}
```

Verificación HMAC en el receptor (Node):

```js
const sig = crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')
if (`sha256=${sig}` !== req.headers['x-signature']) return res.status(401).end()
```

## Backup

Hay un script en `scripts/backup.sh` que respalda Postgres (vía `pg_dump` dentro del
container) + la carpeta `data/sesiones/` (credenciales de Baileys, perderlas = re-escanear
todos los QR). Se guarda en `data/backups/<fecha>/` y borra los > `BACKUP_RETENTION_DAYS`
(default 30).

```bash
# Ejecutar manualmente
bash scripts/backup.sh

# Agendar diario en cron del host
echo '0 3 * * * root cd /ruta/whatsapp-gateway && bash scripts/backup.sh >> /var/log/wa-gateway-backup.log 2>&1' \
  | sudo tee /etc/cron.d/whatsapp-gateway-backup
```

## Operación

```bash
# Logs en vivo
docker compose -p whatsapp-gateway logs -f api
docker compose -p whatsapp-gateway logs -f web

# Reiniciar
docker compose -p whatsapp-gateway restart api

# Bajar todo (mantiene volúmenes)
docker compose -p whatsapp-gateway down

# Bajar y eliminar volúmenes (PIERDES la sesión de WhatsApp y la BD)
docker compose -p whatsapp-gateway down -v

# Re-deploy tras git pull
git pull && sudo bash install.sh
```

## Persistencia

| Qué | Dónde | Si se pierde |
|---|---|---|
| Credenciales WhatsApp | `./data/sesiones/<sessionId>/` | hay que re-escanear QR |
| Base de datos | volumen Docker `pgdata` | se pierden mensajes/historial |
| Cola Bull | volumen Docker `redisdata` | se pierden envíos pendientes |
| Cert SSL | volumen Docker `caddydata` | Caddy lo re-emite solo |
| Archivos subidos | `./data/static/` | (es temporal, borrable) |
| Backups BD | `./data/backups/` | (los respaldos se pierden) |

## Variables de entorno (`.env`)

| Var | Descripción |
|---|---|
| `DOMAIN` | Tu dominio público (Caddy emite SSL para este). **Requerido.** |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Credenciales BD interna. |
| `DB_SYNC` | `true` solo en el primer boot (no hay migrations). **Cambia a `false`** despues para que un cambio de entidad no borre columnas. |
| `JWT_SECRET` | 32 chars aleatorios. |
| `WEBHOOK_URL` | (opcional) URL que recibe POST con eventos entrantes. |
| `WEBHOOK_SECRET` | (opcional) Firma HMAC-SHA256 del body en `X-Signature`. |
| `BACKUP_RETENTION_DAYS` | (opcional) Dias que guarda `scripts/backup.sh` (default 30). |

Ver `.env.example`. El `install.sh` genera todo el resto automáticamente.

## Estructura del proyecto

```
whatsapp-gateway/
├── api/                  Servicio NestJS (Baileys)
│   ├── src/
│   ├── Dockerfile        Multi-stage build (node:20-bookworm-slim)
│   └── package.json
├── web/                  Frontend + reverse proxy
│   ├── index.html        Modal web con tabs (Bootstrap 5)
│   ├── app.js
│   ├── styles.css
│   ├── Caddyfile         Config Caddy (auto-SSL Let's Encrypt)
│   └── Dockerfile
├── data/                 (creado por install.sh, gitignored)
├── docker-compose.yml
├── install.sh            Instalador todo-en-uno
├── .env.example
└── README.md
```

## Troubleshooting

**"HTTPS aun no responde"** después del install:
- Verifica DNS: `dig +short <tu-dominio>` debe devolver la IP del servidor.
- Verifica firewall: puertos 80 y 443 abiertos.
- Mira los logs de Caddy: `docker compose -p whatsapp-gateway logs web`.

**"Sesión no está conectada (estado: connecting)"**:
- Espera 10-15s tras escanear el QR.
- Si persiste, mira logs: `docker compose -p whatsapp-gateway logs api | grep Conectado`.

**El QR no aparece**:
- Comprueba que `data/sesiones/` tiene permisos `1000:1000` (UID node).
- `sudo chown -R 1000:1000 data/`.

## Licencia

Privado / uso interno.
