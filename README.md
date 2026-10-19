# whatsapp-gateway

Gateway REST de WhatsApp: **NestJS + Baileys**, frontend web mínimo y SSL automático con
**Caddy + Let's Encrypt**. Se instala con un comando en Debian/Ubuntu y expone una API con
autenticación por token para enviar mensajes y archivos desde tus sistemas.

| Documento | Para qué |
|---|---|
| Este README | Instalar, primer login, visión general |
| [docs/API.md](docs/API.md) | Referencia completa de endpoints con ejemplos y errores |
| [docs/SEGURIDAD.md](docs/SEGURIDAD.md) | Modelo de seguridad: auth, roles, anti-SSRF, subidas, CSP, límites |
| [docs/OPERACION.md](docs/OPERACION.md) | Actualizar, respaldar, restaurar, diagnosticar |
| [CHANGELOG.md](CHANGELOG.md) | Qué cambia en cada versión y qué exige al actualizar |

> ⚠️ Baileys es un cliente **no oficial** de WhatsApp Web. WhatsApp puede limitar o
> bloquear números que lo usan, con más probabilidad cuanto más automatizado sea el
> tráfico. Para mensajería crítica la opción con garantías es la WhatsApp Business
> Cloud API oficial. Este gateway simula tiempos humanos de escritura y cachea las
> consultas de perfil para reducir el riesgo, pero no lo elimina.

## Stack

- **API**: NestJS 10 + Baileys ≥ 7.0.0-rc.12, colas con Bull sobre Redis.
- **Frontend**: HTML + Bootstrap 5 + JS vanilla, sin build step.
- **Datos**: PostgreSQL 16 (usuarios, sesiones, historial) y Redis 7 (colas, idempotencia).
- **Borde**: Caddy 2 con TLS automático, CSP y cabeceras de seguridad.
- **Empaquetado**: Docker Compose; solo Caddy publica puertos (80/443).

## Requisitos

- Servidor **Debian o Ubuntu** reciente con acceso `root` (o `sudo`).
- **Dominio** con registro `A` apuntando a la IP del servidor (`wa.miempresa.com → 1.2.3.4`).
  Sin dominio no hay certificado ni HTTPS.
- **Puertos 80 y 443** abiertos hacia el servidor.
- RAM: cuenta unos 100 MB por sesión de WhatsApp conectada, más ~600 MB para el stack.

## Instalación

```bash
git clone https://github.com/mtandazo35/whatsapp-gateway.git
cd whatsapp-gateway
sudo bash install.sh
```

El instalador:

1. Pide el dominio (o lo lee de `.env`) y avisa si no resuelve a esta IP.
2. Instala Docker y el plugin compose si faltan.
3. Genera `.env` con contraseña de PostgreSQL, `JWT_SECRET` y el **administrador inicial**.
4. Levanta `postgres`, `redis`, `api` y `web`.
5. Espera a que la API responda y a que Caddy emita el certificado.
6. Ofrece instalar el cron diario de respaldo.
7. Imprime la URL y **el usuario y la contraseña del administrador**. Guárdalos.

Modo no interactivo: `DOMAIN=wa.miempresa.com sudo -E bash install.sh`.

Tras el primer arranque pon `DB_SYNC=false` en `.env` y reinicia la API
(`docker compose -p whatsapp-gateway restart api`). Detalles en [docs/OPERACION.md](docs/OPERACION.md#primer-arranque).

## Primeros pasos

### Desde el navegador

Abre `https://<dominio>/`, entra con el administrador y:

1. **Sesion** → *Vincular WhatsApp* → escanea el QR con el teléfono. El modal se cierra solo
   al conectar y la sesión queda guardada: se reconecta sola tras reinicios.
2. **Mensaje** / **Archivo** → envía un texto, un archivo subido o una URL pública.
3. **Historial** → estado de cada envío: en cola, enviado, entregado, leído o fallido.

### Desde tu sistema

```bash
# 1. Token (caduca a las 8 h)
TOKEN=$(curl -s -X POST https://<dominio>/api/user/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@<dominio>","password":"<la de install.sh>"}' | jq -r .token)

# 2. Crear una sesión y obtener su QR (data URL PNG) para escanear
curl -s -X POST https://<dominio>/api/session -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"nameSession":"ventas"}'
curl -s https://<dominio>/api/whatsapp/qr/<sessionId> -H "Authorization: Bearer $TOKEN"

# 3. Enviar (responde 202: aceptado, no entregado)
curl -s -X POST https://<dominio>/api/whatsapp/send -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" \
  -d '{"sessionId":"<sessionId>","number":"593987654321","message":"Hola"}'
# -> { "status":"queued", "messageId":"0b1f...", "jobId":"0b1f..." }

# 4. Consultar el estado
curl -s https://<dominio>/api/messages/0b1f... -H "Authorization: Bearer $TOKEN"
# -> { ..., "status":"delivered", "sent":true, "waMessageId":"3EB0..." }
```

Un usuario `USUARIO` solo ve y usa sus propias sesiones; crea uno por integración con
`POST /api/user` y evita repartir el token del administrador.

## Mapa de la API

Todas con `Authorization: Bearer` salvo las marcadas 🔓. Detalle, cuerpos y errores en
[docs/API.md](docs/API.md).

| Método | Ruta | Descripción |
|---|---|---|
| POST 🔓 | `/user/login` | Token JWT |
| GET / PATCH | `/user/me` | Perfil propio |
| CRUD (admin) | `/user`, `/user/:id` | Gestión de usuarios y roles |
| POST / GET | `/session` | Crear y listar sesiones propias (admin: todas) |
| GET / PATCH / DELETE | `/session/:id` | Detalle, activar/desactivar, borrado lógico |
| GET | `/whatsapp/qr/:sessionId` | QR para vincular |
| GET | `/whatsapp/status-sessions` | Estado de conexión de las sesiones visibles |
| GET | `/whatsapp/session/:sessionId/info` | Número, nombre y foto (cacheado 5 min) |
| POST | `/whatsapp/send` | Texto → 202 `queued` |
| POST | `/whatsapp/send-media/url` | Archivo desde URL pública → 202 |
| POST | `/whatsapp/send-media/file` | Archivos multipart (10 × 25 MB) → 202 |
| GET | `/whatsapp/check-number` | ¿El número tiene WhatsApp? |
| DELETE | `/whatsapp/session/:sessionId` | Logout y borrado de credenciales |
| GET | `/messages`, `/messages/:id` | Historial y estado de un envío |
| GET 🔓 | `/health`, `/ready` | Liveness y readiness (BD + Redis) |

## Seguridad en dos párrafos

Toda ruta exige token y el guard comprueba en cada petición que el usuario exista y siga
activo, así que desactivar un usuario lo deja fuera al instante. Los roles los aplica el
servidor; nadie elige el suyo. Cada sesión tiene dueño y responder 403 a quien no lo sea
es la regla, aunque conozca el `sessionId`.

Las URLs que el gateway descarga se validan contra redes internas y redirecciones; las
subidas se guardan con nombre UUID y límites; el frontend escapa todo lo que viene de la
API y Caddy impone CSP. Lo que no cubre (rate limiting, rotación de secreto, bloqueo del
número por WhatsApp) está escrito en [docs/SEGURIDAD.md](docs/SEGURIDAD.md#lo-que-este-modelo-no-cubre).

## Webhook saliente

Define `WEBHOOK_URL` (y opcionalmente `WEBHOOK_SECRET` para firma HMAC-SHA256 en
`X-Signature`) y recibirás `POST` por cada mensaje entrante, cambio de estado de un envío y
apertura o cierre de sesión. Formato y verificación en [docs/API.md](docs/API.md#webhook-saliente).

## Variables de entorno (`.env`)

| Variable | Descripción |
|---|---|
| `DOMAIN` | Dominio público. **Requerido.** |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | BD interna (las genera el instalador). |
| `DB_SYNC` | `true` solo en el primer arranque y cuando el CHANGELOG lo pida. |
| `JWT_SECRET` | Mínimo 32 caracteres. Sin él la API no arranca. |
| `JWT_EXPIRES_IN` | Vida del token (`8h`). |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Administrador inicial; solo con la tabla de usuarios vacía. |
| `CORS_ORIGIN` | Orígenes permitidos, separados por coma. Vacío = CORS desactivado. |
| `WEBHOOK_URL` / `WEBHOOK_SECRET` | Webhook saliente opcional. |
| `BACKUP_RETENTION_DAYS` | Días que conserva `scripts/backup.sh` (30). |

Plantilla comentada en [`.env.example`](.env.example).

## Operación resumida

```bash
docker compose -p whatsapp-gateway logs -f api        # qué pasa
docker compose -p whatsapp-gateway restart api        # reinicio suave
bash scripts/backup.sh                                # respaldo BD + credenciales
git pull && sudo bash install.sh                      # actualizar
```

Actualización desde versiones sin autenticación, restauración completa y tabla de síntomas en
[docs/OPERACION.md](docs/OPERACION.md).

## Desarrollo y pruebas

```bash
cd api
npm install
npm run build
npm test            # unitarias: guard de autenticación y validador anti-SSRF (sin red ni BD)
npm run test:e2e    # necesita Postgres y Redis: comprueba que las rutas exigen token
```

Estructura:

```
api/src/
├── user/        usuarios, login, AuthGuard global, roles
├── session/     sesiones de WhatsApp (con dueño)
├── messages/    historial y estados de envío
└── whatsapp/    Baileys, colas Bull, webhook, anti-SSRF, subida de archivos
web/             index.html + app.js + Caddyfile (TLS, CSP)
docs/            API, seguridad, operación
install.sh       instalador todo-en-uno
scripts/         backup.sh
```

## Estado y pendientes

La auditoría del 2026-10-19 (20 hallazgos) tiene cerrado el bloque P0: autenticación y roles,
Baileys parcheado, registro fiel de envíos, respuesta `queued`, aislamiento de subidas,
anti-SSRF, XSS y CSP. Sigue pendiente, por orden:

1. Migraciones versionadas en lugar de `DB_SYNC`.
2. Webhooks con cola persistente (hoy los reintentos viven en memoria).
3. Idempotencia con hash del cuerpo y para multimedia; outbox transaccional.
4. Que desactivar o borrar una sesión desde el CRUD cierre también el socket.
5. Respaldos fuera del host, cifrados y con restauración ensayada.
6. CI con build, pruebas y `npm audit`; `npm ci` en el Dockerfile; TypeScript estricto.

## Licencia

Privado / uso interno.
