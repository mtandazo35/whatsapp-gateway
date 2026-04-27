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

⚠️ La API **no tiene autenticación por defecto**. El JWT de `/user/login` está disponible pero
los controllers no validan el token. Si la expones a internet, agrega un firewall a nivel de
red o pon Cloudflare delante con WAF rules.

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
| `DB_SYNC` | `true` para que TypeORM cree tablas al boot. Apagar tras primer arranque si quieres control manual. |
| `JWT_SECRET` | 32 chars aleatorios. |

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
