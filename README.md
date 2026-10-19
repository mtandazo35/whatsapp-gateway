# whatsapp-gateway

Gateway REST de WhatsApp basado en **NestJS + Baileys**, con frontend web minimalista y
SSL automático vía **Caddy + Let's Encrypt**. Se instala con un solo comando.

> ⚠️ Baileys es un cliente **no oficial** de WhatsApp Web. WhatsApp puede limitar o
> bloquear números que lo usan, con más probabilidad cuanto más automatizado sea el
> tráfico. Para mensajería crítica la opción con garantías es la WhatsApp Business
> Cloud API oficial. Este gateway simula tiempos humanos de escritura y cachea las
> consultas de perfil para reducir el riesgo, pero no lo elimina.

## Stack

- **API**: NestJS 10 + Baileys (cliente WhatsApp Web no oficial).
- **Frontend**: HTML + Bootstrap 5 + JS vanilla (sin build step).
- **Storage**: PostgreSQL 16 + Redis 7.
- **Reverse proxy + SSL**: Caddy 2 (auto-renueva el cert, cabeceras de seguridad y CSP).
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
3. Genera `.env` con `POSTGRES_PASSWORD`, `JWT_SECRET` y el **administrador inicial** aleatorios.
4. Levanta `postgres`, `redis`, `api` y `web` (Caddy).
5. Espera a que la API responda y a que Caddy emita el cert SSL.
6. Imprime el usuario y la contraseña del administrador inicial. **Guárdalos.**

URL final: **`https://<tu-dominio>/`** (frontend) y **`https://<tu-dominio>/api`** (REST).

### Modo no-interactivo

Si quieres saltar el prompt, define `DOMAIN` en `.env` o como env var:

```bash
DOMAIN=wa.miempresa.com sudo -E bash install.sh
```

## Autenticación y roles

**Toda la API exige token** salvo `POST /user/login`, `GET /health` y `GET /ready`.

```bash
# 1. Login
curl -s -X POST https://<dominio>/api/user/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@<dominio>","password":"<la que imprimió install.sh>"}'
# -> { "id": "...", "email": "...", "rol": "SUPER_ADMIN", "token": "eyJ..." }

# 2. Todas las demás llamadas
curl -s https://<dominio>/api/session -H "Authorization: Bearer eyJ..."
```

| Rol | Puede |
|---|---|
| `USUARIO` | Crear sesiones propias, vincularlas, enviar mensajes y ver el historial **de sus sesiones**. Editar su perfil (`PATCH /user/me`). |
| `ADMIN` | Todo lo anterior sobre **todas** las sesiones. Crear, editar, desactivar y borrar usuarios `USUARIO` y `ADMIN`. |
| `SUPER_ADMIN` | Todo. Es el único que puede crear o editar otros `SUPER_ADMIN`. |

Reglas que aplica el servidor:

- El rol lo asigna quien da de alta; un usuario no puede elegirse ni cambiarse el rol.
- Desactivar un usuario (`isActive=false`) o borrarlo invalida sus tokens al instante: el guard
  comprueba el usuario en BD en cada petición.
- Un usuario no accede a una sesión ajena aunque conozca su `sessionId` (responde 403).
- El token caduca según `JWT_EXPIRES_IN` (por defecto 8 h). No hay refresh: se vuelve a hacer login.
- El administrador inicial se crea **solo si la tabla de usuarios está vacía**, a partir de
  `ADMIN_EMAIL` / `ADMIN_PASSWORD` del `.env`. Cámbiale la contraseña tras el primer login.

## Uso del frontend

Abre `https://<tu-dominio>/` en el navegador. Pide usuario y contraseña (los de `install.sh`).

- **Tab Sesion** → click "Vincular WhatsApp" → escanea el QR con tu WhatsApp.
  El modal se cierra solo cuando detecta la conexión.
- **Tab Mensaje** → enviar texto a un número.
- **Tab Archivo** → subir archivo o pasar URL.
- **Tab Verificar numero** → comprueba si un número está en WhatsApp.
- **Tab Historial** → últimos mensajes con su estado (en cola, enviado, entregado, leído, fallido).

## API REST

Base URL: `https://<tu-dominio>/api`. Todas con `Authorization: Bearer <token>` salvo las marcadas 🔓.

| Método | Ruta                                | Descripción                        |
|--------|-------------------------------------|------------------------------------|
| POST 🔓 | `/user/login`                      | Devuelve el token JWT              |
| GET    | `/user/me`                          | Perfil propio                      |
| PATCH  | `/user/me`                          | Cambiar email/contraseña/nombre    |
| POST   | `/user` (admin)                     | Crear usuario (rol opcional)       |
| GET    | `/user` (admin)                     | Listar usuarios                    |
| PATCH  | `/user/:id` (admin)                 | Editar usuario, rol, isActive      |
| DELETE | `/user/:id` (admin)                 | Borrado lógico                     |
| POST   | `/session`                          | Crear sesión (queda a tu nombre)   |
| GET    | `/session?page=1&limit=10`          | Listar sesiones visibles           |
| GET    | `/session/:id`                      | Una sesión (UUID o sessionId)      |
| GET    | `/whatsapp/qr/:sessionId`           | Obtener QR para vincular           |
| GET    | `/whatsapp/status-sessions`         | Estado de las sesiones visibles    |
| GET    | `/whatsapp/session/:sessionId/info` | Info de la sesión conectada        |
| POST   | `/whatsapp/send`                    | Encolar mensaje de texto (202)     |
| POST   | `/whatsapp/send-media/url`          | Encolar archivo desde URL (202)    |
| POST   | `/whatsapp/send-media/file`         | Encolar archivos multipart (202)   |
| GET    | `/whatsapp/check-number`            | Verificar si un número existe      |
| DELETE | `/whatsapp/session/:sessionId`      | Cerrar sesión / logout             |
| GET    | `/messages?session=<id>`            | Historial (UUID o sessionId)       |
| GET    | `/messages/:id`                     | Estado de un envío                 |
| GET 🔓 | `/health`                           | Liveness (sin checks externos)     |
| GET 🔓 | `/ready`                            | Readiness (BD + Redis, sin detalles) |

### Envíos: aceptado no es entregado

Los tres endpoints de envío responden **202** con el mensaje creado en estado `queued`:

```json
{ "status": "queued", "messageId": "0b1f...", "jobId": "0b1f...", "message": "Mensaje aceptado para 5939..." }
```

El estado real se consulta en `GET /messages/:messageId`:

| `status` | Significado |
|---|---|
| `queued` | Aceptado, todavía en cola |
| `sent` | WhatsApp aceptó el mensaje (`waMessageId` relleno) |
| `delivered` / `read` / `played` | ACKs del destinatario |
| `failed` | El worker agotó los intentos; `lastError` dice por qué |
| `error` | WhatsApp reportó error para ese mensaje |

Los estados solo avanzan (un ACK tardío nunca baja `read` a `sent`). Los textos se encolan con
un único intento; los archivos con dos. Si WhatsApp ya aceptó el mensaje, nada de lo que falle
después (presencia, borrar el archivo temporal) provoca un reenvío.

Para enviar texto la sesión debe estar **conectada** (`open`); si no, la API responde 400 en vez
de aceptar un trabajo que iba a fallar.

### Idempotencia en `/whatsapp/send`

Para evitar mensajes duplicados ante reintentos del cliente, manda el header
`Idempotency-Key: <uuid>`. La respuesta (con su `messageId`) queda cacheada en Redis 24h:

```bash
curl -X POST https://<dominio>/api/whatsapp/send \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 7f3e9a2b-..." \
  -d '{"sessionId":"...","number":"5939...","message":"hola"}'
```

Si llega una segunda vez con la misma key se devuelve la respuesta original sin reencolar.
La clave va ligada a la sesión. Pendiente: hash del cuerpo (hoy una misma key con otro texto
devuelve la respuesta anterior) y cobertura de los endpoints de multimedia.

### Archivos: límites y política de URLs

- Subida multipart: máximo **10 archivos** por petición y **25 MB** por archivo (Caddy corta el
  cuerpo total en 25 MB). En disco se guardan con nombre UUID; el nombre original solo se usa
  como nombre visible para el destinatario. Los archivos de peticiones rechazadas se borran al
  momento; los que queden huérfanos se limpian a diario cuando tienen más de 24 h.
- Envío desde URL: solo `http`/`https`, sin credenciales en la URL y **sin redirecciones**
  (usa la URL final). El servidor resuelve el host y rechaza cualquier destino en redes
  privadas, loopback, link-local, CGNAT o nombres internos (`localhost`, `*.local`,
  `*.internal`). La descarga tiene timeout de 30 s y tope de tamaño por tipo
  (imagen 16 MB, audio 16 MB, video 64 MB, documento 100 MB).

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

Los reintentos del webhook (5, con backoff) viven en memoria: un reinicio del contenedor
pierde los pendientes. Diseña el receptor como idempotente por `messageId`.

## Backup

Hay un script en `scripts/backup.sh` que respalda Postgres (vía `pg_dump` dentro del
container) + la carpeta `data/sesiones/` (credenciales de Baileys, perderlas = re-escanear
todos los QR). Se guarda en `data/backups/<fecha>/` (solo root) y borra los > `BACKUP_RETENTION_DAYS`
(default 30). Es un respaldo local: cópialo fuera del host.

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

### Actualizar una instalación anterior a la autenticación

1. `git pull` y `sudo bash install.sh`. El instalador añade `ADMIN_EMAIL` / `ADMIN_PASSWORD`
   al `.env` existente y los imprime.
2. Pon `DB_SYNC=true` en `.env` para este arranque: hay columnas nuevas
   (`sessions.owner_id`, `messages.last_error`, índice en `wa_message_id`, `sessionId` único).
   Vuelve a `false` después.
3. Si la tabla `users` ya tenía filas, el admin inicial **no** se crea: entra con un usuario
   existente. Los usuarios antiguos conservan su rol; las sesiones anteriores no tienen dueño y
   solo las ven los administradores (asígnalas editando `owner_id` si hace falta).
4. Las integraciones deben añadir `Authorization: Bearer` y tratar el 202 como "en cola".

## Pruebas

```bash
cd api
npm test            # unitarias: guard de autenticación y validación anti-SSRF (sin red ni BD)
npm run test:e2e    # necesita Postgres y Redis: comprueba que las rutas exigen token
```

## Persistencia

| Qué | Dónde | Si se pierde |
|---|---|---|
| Credenciales WhatsApp | `./data/sesiones/<sessionId>/` | hay que re-escanear QR |
| Base de datos | volumen Docker `pgdata` | se pierden usuarios, sesiones e historial |
| Cola Bull | volumen Docker `redisdata` | se pierden envíos pendientes |
| Cert SSL | volumen Docker `caddydata` | Caddy lo re-emite solo |
| Archivos subidos | `./data/static/` | (es temporal, borrable) |
| Backups BD | `./data/backups/` | (los respaldos se pierden) |

## Variables de entorno (`.env`)

| Var | Descripción |
|---|---|
| `DOMAIN` | Tu dominio público (Caddy emite SSL para este). **Requerido.** |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Credenciales BD interna. |
| `DB_SYNC` | `true` solo en el primer boot y al actualizar entidades (no hay migrations). **Cambia a `false`** después. |
| `JWT_SECRET` | Mínimo 32 chars aleatorios. La API no arranca sin él. |
| `JWT_EXPIRES_IN` | Duración del token (default `8h`). |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Administrador inicial; solo se usa con la tabla de usuarios vacía. |
| `CORS_ORIGIN` | (opcional) Orígenes permitidos separados por coma. Vacío = CORS desactivado. |
| `WEBHOOK_URL` | (opcional) URL que recibe POST con eventos entrantes. |
| `WEBHOOK_SECRET` | (opcional) Firma HMAC-SHA256 del body en `X-Signature`. |
| `BACKUP_RETENTION_DAYS` | (opcional) Días que guarda `scripts/backup.sh` (default 30). |

Ver `.env.example`. El `install.sh` genera todo el resto automáticamente.

## Estructura del proyecto

```
whatsapp-gateway/
├── api/                  Servicio NestJS (Baileys)
│   ├── src/
│   │   ├── user/         Usuarios, login, AuthGuard global, roles
│   │   ├── session/      Sesiones de WhatsApp (con dueño)
│   │   ├── messages/     Historial y estados de envío
│   │   └── whatsapp/     Baileys, colas, webhook, anti-SSRF
│   ├── Dockerfile        Multi-stage build (node:20-bookworm-slim)
│   └── package.json
├── web/                  Frontend + reverse proxy
│   ├── index.html        Modal web con tabs (Bootstrap 5) + login
│   ├── app.js
│   ├── styles.css
│   ├── Caddyfile         Config Caddy (auto-SSL, CSP y cabeceras)
│   └── Dockerfile
├── data/                 (creado por install.sh, gitignored)
├── docker-compose.yml
├── install.sh            Instalador todo-en-uno
├── .env.example
└── README.md
```

## Pendientes conocidos

Tras la auditoría del 2026-10-19 quedó corregido el bloque P0 (autenticación y roles,
Baileys ≥ 7.0.0-rc.12, registro correcto de envíos, respuesta `queued`, aislamiento de
subidas, anti-SSRF, XSS y CSP). Sigue pendiente:

- Migraciones versionadas en lugar de `DB_SYNC`.
- Webhooks con cola persistente (hoy reintentos en memoria).
- Idempotencia con hash del cuerpo y para multimedia; outbox transaccional.
- Desactivar o borrar una sesión desde el CRUD no cierra el socket (sí lo hace `DELETE /whatsapp/session/:id`).
- Respaldos fuera del host, cifrados y con prueba de restauración.
- CI, `npm ci` en el Dockerfile y TypeScript estricto.

## Troubleshooting

**"HTTPS aun no responde"** después del install:
- Verifica DNS: `dig +short <tu-dominio>` debe devolver la IP del servidor.
- Verifica firewall: puertos 80 y 443 abiertos.
- Mira los logs de Caddy: `docker compose -p whatsapp-gateway logs web`.

**La API no arranca: "JWT_SECRET no definido o demasiado corto"**:
- `.env` debe tener `JWT_SECRET` de al menos 32 caracteres (`openssl rand -hex 32`).

**No puedo entrar: "Usuario o contraseña incorrectos"**:
- Si es la primera instalación, usa `ADMIN_EMAIL` / `ADMIN_PASSWORD` del `.env`.
- Si la BD ya tenía usuarios, el admin inicial no se creó: `docker compose -p whatsapp-gateway logs api | grep -i admin`.

**"Sesión no está conectada (estado: connecting)"**:
- Espera 10-15s tras escanear el QR.
- Si persiste, mira logs: `docker compose -p whatsapp-gateway logs api | grep Conectado`.

**El QR no aparece**:
- Comprueba que `data/sesiones/` tiene permisos `1000:1000` (UID node).
- `sudo chown -R 1000:1000 data/`.

## Licencia

Privado / uso interno.
