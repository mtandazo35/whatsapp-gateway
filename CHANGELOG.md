# Changelog

Formato: una entrada por versión con lo que cambia para quien opera o integra el gateway.
La versión está en `api/package.json`.

## 0.3.0 — 2026-10-19

Cierra el resto de la lista P1/P2 de la auditoría salvo multi-worker y TypeScript estricto.

### Requiere al actualizar

- Nada manual: la migración `WebhooksYAuditoria` añade `messages.kind`, `caption`, `fast_mode`,
  `requested_by` y la tabla `webhook_events`.
- Si usas webhook por `http://` (receptor en tu red) añade `WEBHOOK_ALLOW_HTTP=true`; por
  defecto ahora se exige `https://` y, si no se cumple, el webhook queda desactivado con un
  error en el log.
- La imagen se construye con `npm ci`: `package-lock.json` debe estar al día (lo está).

### Añadido

- **Webhooks persistentes**: cada evento se guarda en `webhook_events` antes de enviarse y
  se entrega por una cola Bull propia (10 intentos, backoff exponencial, ~34 min). Un
  reinicio no pierde nada. Cabeceras `X-Event-Id` y `X-Event-Type`; el cuerpo incluye
  `eventId`, `timestamp` y `attempt`. Administración: `GET /webhooks/events`,
  `GET /webhooks/events/counts`, `POST /webhooks/events/:id/replay`,
  `POST /webhooks/events/replay-failed`, `GET /webhooks/config`.
- **Idempotencia completa**: la `Idempotency-Key` guarda el hash del cuerpo. Misma clave con
  otro cuerpo → **409**. Cubre `/whatsapp/send` y `/whatsapp/send-media/url`. Una reserva
  abandonada caduca a los 2 min (antes 24 h).
- **Desactivar o borrar una sesión** (`PATCH/DELETE /session/:id`) cierra el socket, borra
  las credenciales, cancela los jobs en cola y marca sus mensajes `failed`.
- **Barrido cada 5 min** de mensajes `queued` con más de 15 min cuyo job ya no existe en
  Bull: pasan a `failed` con motivo "job perdido".
- **`GET /status`** (admin): sesiones por estado, colas (envío, webhook, mantenimiento),
  mensajes de las últimas 24 h, webhooks y alertas.
- **`POST /whatsapp/messages/:id/retry`**: reintenta un mensaje `failed` de texto o URL
  creando uno nuevo. Los archivos subidos no se reintentan (el temporal ya no existe).
- **Auditoría**: `messages.requested_by` guarda qué usuario pidió cada envío;
  `GET /messages` lo devuelve (`requestedBy.email`) y admite `?status=`.
- **Request-Id**: cada respuesta lleva `X-Request-Id` (se respeta el que mande el cliente) y
  la API escribe una línea por petición con método, ruta, código, ms, usuario e IP.
- **Respaldos**: `scripts/backup.sh` incluye Redis, genera `MANIFEST.sha256`, cifra con
  AES-256 si hay `BACKUP_ENCRYPT_PASSPHRASE` (el instalador la genera) y copia fuera del
  host con `BACKUP_REMOTE_DEST`. Nuevo `scripts/restore.sh <carpeta>` con verificación,
  respaldo previo y arranque comprobado.
- **CI** (`.github/workflows/ci.yml`): build, unitarias, lint, `npm audit`, e2e con Postgres
  y Redis, shellcheck y build de la imagen.
- **Dockerfile** con `npm ci` y poda de dependencias de desarrollo en lugar de una segunda
  instalación.
- **Frontend**: selector de sesión y botón de nueva sesión, filtro por estado en el
  historial, botón *Reintentar* en fallidos con el motivo visible, pestaña *Administración*
  (estado del servicio, webhooks con reenvío, alta y activación de usuarios), aviso de 429 y
  `Idempotency-Key` automática en cada envío.

## 0.2.0 — 2026-10-19

Primer bloque P1 de la auditoría: rate limiting y migraciones. Sin cambios en el contrato
de la API salvo las respuestas 429.

### Requiere al actualizar

- Nada manual. Al arrancar, la API aplica la migración `EsquemaInicial`, que es idempotente:
  sobre una base creada con `DB_SYNC=true` solo añade lo que falte; sobre una vacía crea todo.
- `DB_SYNC` pasa a `false` por defecto en `.env` nuevos. En `.env` existentes puedes dejarlo
  en `false` ya.

### Añadido

- **Rate limit por IP** con `@nestjs/throttler`: 600 peticiones/min en general,
  10 logins/min y 120 envíos/min. Configurable con `RATE_LIMIT_*_PER_MIN`. Responde 429
  con cabeceras `X-RateLimit-*`. `/health` y `/ready` quedan fuera. La API confía en un
  salto de proxy (Caddy) para leer la IP real.
- **Migraciones TypeORM** en `api/src/database/migrations`, aplicadas al arrancar
  (`DB_MIGRATIONS=true`). Scripts `npm run migration:generate --name=Nombre`,
  `migration:run`, `migration:revert`, `migration:show`.
- Índice compuesto `messages(session_id, created_at)` para el historial.
- `package-lock.json` regenerado: Baileys 7.0.0-rc14, throttler 6.7.1, sharp 0.33.5, axios
  1.20.0; desaparece el árbol de `baileys` 6.x.
- `install.sh` ya no se queja de los puertos 80/443 cuando quien escucha es su propio Caddy
  (re-deploy con el stack levantado).

## 0.1.0 — 2026-10-19

Cierra el bloque P0 de la auditoría del 2026-10-19. **Rompe compatibilidad** con las
integraciones anteriores: la API exige token y los envíos responden 202.

### Requiere al actualizar

- Arrancar una vez con `DB_SYNC=true`: nuevas columnas `sessions.owner_id`,
  `messages.last_error`, índice en `messages.wa_message_id`, `sessions.sessionId` único.
- `JWT_SECRET` de al menos 32 caracteres (la API no arranca sin él).
- Añadir `Authorization: Bearer <token>` en todas las llamadas (`install.sh` genera el admin
  inicial si la tabla de usuarios está vacía).
- Regenerar `package-lock.json` (`npm install`) por el cambio de dependencias.

### Seguridad

- Guard global de autenticación con denegación por defecto; públicas solo `POST /user/login`,
  `GET /health` y `GET /ready`. El guard verifica en BD que el usuario exista y siga activo.
- Roles aplicados en servidor (`USUARIO`, `ADMIN`, `SUPER_ADMIN`); nadie elige su rol.
- Sesiones con dueño: 403 al acceder a una sesión ajena.
- `@whiskeysockets/baileys` ≥ 7.0.0-rc.12 (GHSA-qvv5-jq5g-4cgg). Eliminado el paquete
  `baileys` 6.7.18 sin uso. `sharp` declarado como dependencia directa.
- Eliminadas las ramas del handler de entrantes que ejecutaban `requestPlaceholderResend` y
  `fetchMessageHistory` ante textos de cualquier contacto; se descartan `upsert` con `requestId`.
- Anti-SSRF en envío por URL: solo http/https, sin credenciales, sin redirecciones, DNS
  resuelto y rangos privados rechazados; revalidación en el worker; descarga con tope de tamaño.
- Subidas con nombre UUID, límites de 10 archivos y 25 MB, borrado al rechazar la petición.
- Frontend con login y todo texto externo escapado; Caddy añade CSP y cabeceras de seguridad.
- CORS desactivado salvo `CORS_ORIGIN`. `/ready` sin detalles internos y con timeout.
- `bcrypt` asíncrono; el login no revela si el correo existe.

### Envíos

- Los tres endpoints de envío responden **202** `{ status: "queued", messageId, jobId }`. El
  estado real está en `GET /messages/:id` (`queued`, `sent`, `delivered`, `read`, `played`,
  `failed` con `lastError`, `error`).
- La fila de `messages` se crea antes de encolar; `messages.sent` ya no es `true` por defecto.
- Corregido: el worker de texto guardaba el `sessionId` corto en la columna UUID y el fallo
  posterior se registraba como enviado.
- Corregido: hasta 6 envíos reales por un mismo mensaje (reintentos internos × Bull). Ahora
  reintenta solo Bull y nada de lo que falle tras el envío provoca otro.
- Corregido: el historial fallaba con error de tipo UUID al filtrar por `sessionId` corto.
- Los ACK solo avanzan el estado y solo dentro de su sesión.
- Enviar texto exige sesión conectada; antes se encolaba y se perdía.

### Sesiones

- Si el arranque falla antes de crear el socket, el siguiente intento es real (antes quedaba
  una promesa rechazada en memoria).
- `DELETE /whatsapp/session/:id` cancela reconexiones programadas; los eventos de sockets
  reemplazados se ignoran; cierre ordenado con `SIGTERM`.
- Al reiniciar solo se levantan sesiones activas y no borradas en BD.
- Los datos de perfil (`/info`) se cachean 5 min; el frontend ya no los pide cada 3 s.
- Reconexión con jitter.

### Operación

- Limpieza diaria de `static/` solo de archivos con más de 24 h y con `jobId` fijo (antes
  borraba todo y registraba un job nuevo por reinicio). Eliminados los jobs `restartAPI` y
  `backupsDB`, que no tenían handler.
- `install.sh` genera y muestra el administrador inicial; `data/backups` queda `700`.
- La API ya no monta `./data/backups`.
- Pruebas unitarias del guard y del validador de URLs; e2e que comprueba 401 sin token.
- Documentación: `docs/API.md`, `docs/SEGURIDAD.md`, `docs/OPERACION.md`.

### Pendiente (P1/P2 de la auditoría)

Migraciones versionadas, webhooks persistentes, idempotencia con hash del cuerpo y para
multimedia, cierre de socket al desactivar una sesión desde el CRUD, respaldos fuera del
host, CI con `npm ci` y TypeScript estricto.

## 0.0.1 — 2026-05

Versión inicial: NestJS + Baileys + Caddy, webhook saliente, `/health` y `/ready`,
idempotencia por cabecera, backoff de reconexión y `scripts/backup.sh`.
