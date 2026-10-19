# Referencia de la API

Base URL: `https://<dominio>/api`. Todas las respuestas son JSON.

Salvo las tres rutas públicas (`POST /user/login`, `GET /health`, `GET /ready`), **toda
petición lleva** `Authorization: Bearer <token>`. El token se obtiene en el login y caduca
según `JWT_EXPIRES_IN` (8 h por defecto). No hay refresh token: se vuelve a hacer login.

## Convenciones

### Identificadores de sesión

Cada sesión tiene dos identificadores:

| Campo | Forma | Dónde se usa |
|---|---|---|
| `id` | UUID | `PATCH/DELETE /session/:id`, relación en BD |
| `sessionId` | 12 caracteres hex | Todas las rutas de `/whatsapp/*`, carpeta de credenciales, filtro `?session=` |

`GET /session/:id` y `GET /messages?session=` aceptan cualquiera de los dos.

### Números

Se envían como texto con código de país y sin `+`: `593987654321`. El servidor elimina
cualquier carácter no numérico y exige entre 10 y 15 dígitos.

### Errores

| Código | Cuándo | Cuerpo |
|---|---|---|
| 400 | Validación del cuerpo, sesión inactiva o no conectada, URL rechazada, número inválido | `{ "statusCode": 400, "message": "..." \| ["..."], "error": "Bad Request" }` |
| 401 | Sin token, token caducado, usuario borrado o desactivado | `{ "statusCode": 401, "message": "Token no enviado" }` |
| 403 | Rol insuficiente o sesión de otro usuario | `{ "statusCode": 403, "message": "No tienes acceso a esta sesión" }` |
| 404 | Recurso inexistente (o mensaje de otro usuario) | `{ "statusCode": 404, "message": "..." }` |
| 409 | `Idempotency-Key` reutilizada con otro cuerpo | `{ "statusCode": 409, "message": "Esta Idempotency-Key ya se usó con otro cuerpo..." }` |
| 413 | Cuerpo mayor de 25 MB (lo corta Caddy) | texto plano |
| 429 | Rate limit por IP: 10 logins/min, 120 envíos/min, 600 peticiones/min en total | `{ "statusCode": 429, "message": "Demasiadas peticiones, espera un momento" }` + `Retry-After` |
| 503 | `/ready` con BD o Redis caídos | `{ "status": "degraded", "checks": { "db": "ok", "redis": "fail" } }` |

Los errores de validación (`ValidationPipe` con `whitelist` y `forbidNonWhitelisted`)
devuelven `message` como lista: un campo desconocido en el cuerpo también es 400.

### Request-Id

Toda respuesta lleva `X-Request-Id`. Si el cliente manda uno (hasta 64 caracteres) se
respeta; si no, la API lo genera. La línea de acceso del log lo incluye (`rid=`), así que
un soporte puede localizar una petición concreta con ese valor.

### Paginación

Las listas aceptan `?page=1&limit=10&filter=texto`. `limit` tiene tope (100 en usuarios y
sesiones, 200 en mensajes). Devuelven:

```json
{ "data": [ ... ], "meta": { "total": 42, "page": 1, "lastPage": 5 } }
```

---

## Autenticación y usuarios

### `POST /user/login` 🔓

```bash
curl -s -X POST https://<dominio>/api/user/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@<dominio>","password":"Wa0123456789abcdef0123!"}'
```

```json
{
  "id": "4f1c...",
  "email": "admin@<dominio>",
  "usuario": "admin",
  "celular": null,
  "rol": "SUPER_ADMIN",
  "isActive": true,
  "created_at": "2026-10-19T20:00:00.000Z",
  "updated_at": "2026-10-19T20:00:00.000Z",
  "deleted_at": null,
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

Credenciales incorrectas y correo inexistente devuelven el mismo 401 ("Usuario o contraseña
incorrectos"). Usuario desactivado: 401 "Usuario desactivado".

### `GET /user/me`

Perfil del usuario del token (sin contraseña).

### `PATCH /user/me`

Cambia el propio perfil. Campos opcionales: `email`, `password`, `usuario`, `celular`.
No admite `rol` ni `isActive` (400 por campo no permitido).

```bash
curl -s -X PATCH https://<dominio>/api/user/me \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"password":"Nueva.Clave.2026"}'
```

Política de contraseñas (alta y cambio): mínimo 8 caracteres con mayúscula, minúscula,
número y símbolo.

### `POST /user` — ADMIN, SUPER_ADMIN

```json
{ "email": "ana@empresa.com", "password": "Clave.Fuerte1", "usuario": "ana.perez", "celular": "5939...", "rol": "USUARIO" }
```

`rol` es opcional (por defecto `USUARIO`). Un `ADMIN` no puede asignar `SUPER_ADMIN` (403).
Responde 201 con el usuario creado, **sin token**: el nuevo usuario hace su propio login.

### `GET /user`, `GET /user/:id` — ADMIN, SUPER_ADMIN

Listado paginado y detalle. Nunca incluyen el hash de contraseña.

### `PATCH /user/:id` — ADMIN, SUPER_ADMIN

Mismos campos que el alta más `isActive`. Reglas:

- Un `ADMIN` no puede tocar a un `SUPER_ADMIN` (403).
- Nadie puede desactivarse ni cambiarse el rol a sí mismo (400).
- `isActive: false` deja fuera al usuario en la siguiente petición, aunque su token siga vigente.

### `DELETE /user/:id`, `PUT /user/restore/:id` — ADMIN, SUPER_ADMIN

Borrado lógico y restauración. No puedes borrarte a ti mismo. El correo sigue reservado
mientras el usuario esté en la papelera: para reutilizarlo, restáuralo o cámbiale el correo
antes de dar de alta otro.

---

## Sesiones

Una sesión es un número de WhatsApp vinculado. Pertenece al usuario que la crea; los
administradores ven todas.

### `POST /session`

```bash
curl -s -X POST https://<dominio>/api/session \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"nameSession":"ventas"}'
```

```json
{
  "id": "9d2e...-uuid",
  "sessionId": "3fa85f64a1b2",
  "nameSession": "VENTAS",
  "numberSession": null,
  "status": "not_started",
  "isActive": true,
  "owner": { "id": "4f1c...", "email": "admin@<dominio>" },
  "created_at": "...", "updated_at": "...", "deleted_at": null
}
```

### `GET /session`

Paginado. `filter` busca en nombre, número y `sessionId`.

### `GET /session/:id`

Por UUID o `sessionId`. 403 si no es tuya y no eres admin.

### `PATCH /session/:id` (UUID)

`{ "nameSession": "...", "isActive": false }`. Con `isActive: false` la sesión se cierra en
caliente (logout, credenciales borradas, jobs cancelados), la API rechaza nuevos envíos
(400 "se encuentra inactiva") y no se levanta al reiniciar el servicio.

### `DELETE /session/:id`, `PUT /session/restore/:id` (UUID)

Borrado lógico. También cierra el socket y cancela los envíos pendientes.

---

## WhatsApp

### `GET /whatsapp/qr/:sessionId`

Arranca la sesión si hace falta y espera hasta 10 s a que haya QR.

| Respuesta | Significado |
|---|---|
| `{ "status": "ok", "qr": "data:image/png;base64,..." }` | Mostrar el QR; se renueva cada ~20 s, volver a pedir |
| `{ "status": "waiting", "message": "..." }` | Ya conectada o QR aún no generado |
| `{ "status": "disconnected", "message": "..." }` | Sesión cerrada; repetir la llamada |

Tras 6 QR sin escanear la sesión se cierra sola; una nueva llamada reinicia el contador.

### `GET /whatsapp/status-sessions`

Estado en memoria de las sesiones visibles para el usuario. Solo aparecen las que se han
arrancado desde el último reinicio del servicio.

```json
[ { "sessionId": "3fa85f64a1b2", "state": "open" }, { "sessionId": "77aa...", "state": "connecting" } ]
```

Estados: `open`, `connecting`, `close`, `not_started`.

### `GET /whatsapp/session/:sessionId/info`

```json
{
  "sessionId": "3fa85f64a1b2",
  "state": "open",
  "connected": true,
  "info": { "jid": "5939...@s.whatsapp.net", "number": "5939...", "pushName": "Ventas", "profilePicUrl": "https://...", "businessProfile": null }
}
```

`info` es `null` si no está conectada. Foto y perfil comercial se cachean 5 minutos en el
servidor: no sirve hacer polling de esta ruta para ver cambios de perfil.

### `POST /whatsapp/send`

Encola un texto. Query opcional `?fastMode=true` para saltarse la simulación de escritura.
Cabecera opcional `Idempotency-Key`.

```bash
curl -s -X POST "https://<dominio>/api/whatsapp/send" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: 7f3e9a2b-1c2d-4e5f-8a9b-0c1d2e3f4a5b" \
  -d '{"sessionId":"3fa85f64a1b2","number":"593987654321","message":"Hola, tu pedido salió"}'
```

Respuesta **202**:

```json
{
  "status": "queued",
  "message": "Mensaje aceptado para 593987654321; consulta /api/messages/0b1f... para ver el estado",
  "messageId": "0b1f...-uuid",
  "jobId": "0b1f...-uuid"
}
```

Requisitos: sesión tuya, activa y **conectada** (`open`); si no, 400 y nada se encola.

Con la misma `Idempotency-Key` (máx. 128 caracteres) dentro de 24 h se devuelve la
respuesta original sin reencolar. Si la primera petición aún está en curso:
`{ "status": "duplicate", ... }`. Si la clave se reutiliza con **otro cuerpo** (número,
texto o `fastMode` distintos) la API responde **409**: cada envío distinto necesita su clave.
Una reserva que quedó a medias (caída entre aceptar y responder) caduca a los 2 minutos.
La clave va ligada a la sesión. También vale en `/whatsapp/send-media/url`; la subida
multipart no la soporta.

### `POST /whatsapp/send-media/url`

```json
{ "sessionId": "3fa85f64a1b2", "number": "593987654321", "mediaUrl": "https://cdn.empresa.com/factura-001.pdf", "caption": "Tu factura" }
```

Antes de aceptar, el servidor valida la URL (ver [SEGURIDAD.md](SEGURIDAD.md#anti-ssrf)) y
hace un `HEAD`: debe responder 2xx sin redirigir. El tipo (imagen, audio, video, documento)
sale del `Content-Type`. Respuesta 202 igual que el texto. La descarga la hace el worker, con
timeout de 30 s y tope por tipo.

### `POST /whatsapp/send-media/file`

`multipart/form-data` con campos `sessionId`, `number`, `caption` (opcional) y uno o varios
`files`. Máximo 10 archivos y 25 MB por archivo.

```bash
curl -s -X POST https://<dominio>/api/whatsapp/send-media/file \
  -H "Authorization: Bearer $TOKEN" \
  -F sessionId=3fa85f64a1b2 -F number=593987654321 -F caption="Adjunto" \
  -F files=@factura.pdf -F files=@foto.jpg
```

```json
{
  "status": "queued",
  "message": "2 archivo(s) en cola de envío",
  "queued": [
    { "messageId": "0b1f...", "jobId": "0b1f...", "file": "factura.pdf" },
    { "messageId": "7c2a...", "jobId": "7c2a...", "file": "foto.jpg" }
  ]
}
```

Las imágenes de más de 500 KB se recomprimen a JPEG. El nombre que ve el destinatario es el
original; en disco se guarda con UUID y se borra tras el envío.

### `POST /whatsapp/messages/:id/retry`

Reintenta un mensaje en estado `failed` creando **un mensaje nuevo** (el fallido se queda
en el historial con su `lastError`). Vale para `kind` `text` y `media_url`; un `file` ya no
existe en disco (400 "vuelve a subirlo"). Responde 202 con `messageId`, `jobId` y `retryOf`.

### `GET /whatsapp/check-number?sessionId=...&number=...`

```json
{ "exists": true, "jid": "593987654321@s.whatsapp.net" }
```

### `DELETE /whatsapp/session/:sessionId`

Cierra la sesión en WhatsApp (logout), cancela reconexiones pendientes, borra las
credenciales, retira de la cola los envíos pendientes de esa sesión y los marca `failed`.
Para volver a usarla hay que escanear QR de nuevo. `PATCH /session/:id` con
`isActive:false` y `DELETE /session/:id` hacen lo mismo.

```json
{ "status": "ok", "sessionId": "3fa85f64a1b2", "result": { "status": "closed", "cancelled": 0 } }
```

---

## Mensajes

### `GET /messages`

Paginado. Filtros: `session` (UUID o `sessionId`), `status` (`queued`, `sent`, `delivered`,
`read`, `played`, `failed`, `error`) y `filter` (texto, receptor o nombre de la sesión). Un
usuario normal solo ve mensajes de sus sesiones. Cada fila trae `kind` (`text`, `media_url`,
`file`), `caption`, `fastMode`, `lastError` y `requestedBy` (`id`, `email` de quien lo pidió).

```json
{
  "data": [
    {
      "id": "0b1f...",
      "message": "Hola, tu pedido salió",
      "receptor": "593987654321",
      "sent": true,
      "waMessageId": "3EB0A1B2C3D4",
      "status": "delivered",
      "lastError": null,
      "created_at": "...", "updated_at": "...", "deleted_at": null,
      "session": { "id": "9d2e...", "sessionId": "3fa85f64a1b2", "nameSession": "VENTAS", "owner": { "id": "4f1c..." } }
    }
  ],
  "meta": { "total": 1, "page": 1, "lastPage": 1 }
}
```

### `GET /messages/:id`

Estado de un envío. Es la ruta que debe consultar una integración tras el 202.

| `status` | `sent` | Significado |
|---|---|---|
| `queued` | false | Aceptado, en cola |
| `sent` | true | WhatsApp lo aceptó; `waMessageId` relleno |
| `delivered` | true | Llegó al dispositivo |
| `read` | true | Leído |
| `played` | true | Audio reproducido |
| `failed` | false | Agotados los intentos; `lastError` explica |
| `error` | false | WhatsApp devolvió error para ese mensaje |

Los estados solo avanzan. Un envío que lleve más de 15 minutos en `queued` sin job vivo en
la cola lo marca `failed` un barrido automático cada 5 minutos (`lastError`: "job perdido").

### `DELETE /messages/:id` — ADMIN, SUPER_ADMIN

Borrado lógico del registro (no retira el mensaje de WhatsApp).

---

## Operación (administradores)

### `GET /status`

```json
{
  "uptimeSeconds": 3600, "memory": { "rssMb": 110, "heapUsedMb": 60 },
  "sessions": { "total": 2, "byState": { "open": 1, "connecting": 1 }, "list": [ ... ] },
  "queues": { "send": { "waiting": 0, "active": 0, "delayed": 0, "failed": 3 }, "webhook": { ... }, "maintenance": { ... } },
  "messagesLast24h": { "sent": 120, "delivered": 100, "failed": 2 },
  "webhook": { "enabled": true, "signed": true, "events": { "pending": 0, "sent": 300, "failed": 0 } },
  "alerts": [ "3 trabajos de envío fallidos conservados en Redis" ]
}
```

### `GET /webhooks/config`, `GET /webhooks/events?status=&page=&limit=`, `GET /webhooks/events/counts`

Configuración efectiva del webhook y listado de eventos (`pending`, `sent`, `failed`) con
`attempts`, `lastError` y `sentAt`.

### `POST /webhooks/events/:id/replay`, `POST /webhooks/events/replay-failed`

Reencolan un evento concreto o todos los fallidos. El receptor debe ser idempotente por
`eventId`: un replay entrega el mismo evento otra vez.

## Salud

### `GET /health` 🔓

`{ "status": "ok", "uptime": 1234.5, "timestamp": "..." }`. No toca BD ni Redis.

### `GET /ready` 🔓

`{ "status": "ok", "checks": { "db": "ok", "redis": "ok" } }` o 503 con `"fail"` en el que
esté caído. Cada check tiene 3 s de timeout. No revela mensajes de error internos.

---

## Webhook saliente

Si `WEBHOOK_URL` está definido, el gateway hace `POST` con `Content-Type: application/json`
y `User-Agent: whatsapp-gateway-webhook/1.0`. Con `WEBHOOK_SECRET`, añade
`X-Signature: sha256=<hmac-sha256-hex del cuerpo exacto>`.

| `event` | `data` |
|---|---|
| `message.incoming` | `sessionId, messageId, from, fromJid, fromMe, pushName, timestamp, type, text` |
| `message.update` | `sessionId, messageId, remoteJid, status` |
| `session.open` | `sessionId, number` |
| `session.close` | `sessionId, statusCode, shouldReconnect` |

Cada evento se guarda en `webhook_events` antes del primer intento y se entrega por una cola
persistente: 10 intentos con backoff exponencial desde 2 s (unos 34 min). Un reinicio no
pierde nada. Pasados los 10 intentos queda `failed` y se reenvía con
`POST /webhooks/events/:id/replay` o `replay-failed`. El receptor debe responder 2xx en
menos de 10 s y ser **idempotente por `eventId`** (cabecera `X-Event-Id` y campo del cuerpo):
reintentos y replays entregan el mismo evento más de una vez.

Cabeceras: `Content-Type: application/json`, `X-Event-Id`, `X-Event-Type` y, con secreto,
`X-Signature: sha256=<hmac del cuerpo exacto>`. Cuerpo:

```json
{ "eventId": "7c2a...", "event": "message.incoming", "timestamp": "2026-10-19T20:00:00.000Z", "attempt": 1, "data": { ... } }
```

La URL debe ser `https://`; con `WEBHOOK_ALLOW_HTTP=true` se admite `http://` para un
receptor en tu red (p. ej. `http://host.docker.internal:9000/hook`).

Verificación de firma en Node:

```js
const esperado = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')
if (!crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(req.headers['x-signature'] || ''))) {
  return res.status(401).end()
}
```
