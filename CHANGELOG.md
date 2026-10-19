# Changelog

Formato: una entrada por versión con lo que cambia para quien opera o integra el gateway.
La versión está en `api/package.json`.

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
