# Operación

Día a día del gateway: arranque, actualización, respaldo, diagnóstico.

## Arquitectura en un vistazo

```
Internet ──443──> web (Caddy: TLS, CSP, estáticos) ──/api/*──> api (NestJS :3005)
                                                                 ├── postgres (usuarios, sesiones, mensajes)
                                                                 ├── redis (colas Bull, idempotencia)
                                                                 └── WhatsApp (Baileys, un socket por sesión)
```

Volúmenes y carpetas:

| Ruta | Contenido | Si se pierde |
|---|---|---|
| `./data/sesiones/<sessionId>/` | Credenciales de WhatsApp | Volver a escanear QR |
| `./data/static/` | Archivos subidos, temporales | Nada (se regeneran) |
| `./data/backups/` | Respaldos de `scripts/backup.sh` | Los respaldos |
| volumen `pgdata` | PostgreSQL | Usuarios, sesiones e historial |
| volumen `redisdata` | Redis con AOF | Envíos en cola y claves de idempotencia |
| volumen `caddydata` | Certificados | Caddy los vuelve a emitir |

## Comandos habituales

```bash
P=whatsapp-gateway

docker compose -p $P ps                       # estado de los 4 contenedores
docker compose -p $P logs -f api              # logs de la API (sesiones, envíos, errores)
docker compose -p $P logs -f web              # accesos y TLS
docker compose -p $P restart api              # reinicio suave (las sesiones se reconectan solas)
docker compose -p $P down                     # parar todo, conserva volúmenes
docker compose -p $P down -v                  # ¡borra BD, colas y certificados!
```

Health desde el host:

```bash
curl -s https://<dominio>/api/health
curl -s https://<dominio>/api/ready      # 503 si BD o Redis fallan
```

## Primer arranque

`sudo bash install.sh` deja todo levantado e imprime el **usuario y contraseña del
administrador inicial**. Se crean solo si la tabla `users` está vacía. Primer paso tras
entrar: cambiar la contraseña con `PATCH /api/user/me` y crear los usuarios que hagan falta
con `POST /api/user`.

El esquema lo crea la API al arrancar aplicando las migraciones de
`api/src/database/migrations` (tabla `migrations` en Postgres). `DB_SYNC` debe quedarse en
`false`: con `true` TypeORM altera las tablas al vuelo y puede borrar columnas.

## Actualizar

```bash
cd /ruta/whatsapp-gateway
bash scripts/backup.sh                 # siempre antes
git pull
sudo bash install.sh                   # reconstruye imágenes y levanta
```

Las migraciones pendientes se aplican solas al arrancar la API. Para ver cuáles están
aplicadas:

```bash
docker compose -p whatsapp-gateway exec postgres psql -U whatsapp -d whatsapp -c 'SELECT name, timestamp FROM migrations'
```

Para crear una migración nueva tras cambiar una entidad (en desarrollo, con la BD alcanzable):

```bash
cd api && npm run migration:generate --name=NombreDelCambio   # genera src/database/migrations/<ts>-NombreDelCambio.ts
npm run migration:show                                          # [X] aplicadas, [ ] pendientes
```

### Desde una versión sin autenticación (anterior a 0.1.0)

1. `install.sh` añade `ADMIN_EMAIL` / `ADMIN_PASSWORD` al `.env` existente y los imprime.
2. Arranca normal: la migración `EsquemaInicial` añade `sessions.owner_id`,
   `messages.last_error`, el índice en `wa_message_id` y la restricción única en `sessionId`
   sobre las tablas que ya existían. Deja `DB_SYNC=false`.
3. Si `users` ya tenía filas, el admin inicial **no** se crea. Entra con un usuario
   existente. Si ninguno es administrador, promuévelo en la BD:
   ```bash
   docker compose -p whatsapp-gateway exec postgres \
     psql -U whatsapp -d whatsapp -c "UPDATE users SET rol='SUPER_ADMIN' WHERE email='tu@correo';"
   ```
4. Las sesiones anteriores no tienen dueño: solo las ven administradores. Para asignarlas:
   ```sql
   UPDATE sessions SET owner_id = (SELECT id FROM users WHERE email='ana@empresa.com')
   WHERE "sessionId" = '3fa85f64a1b2';
   ```
5. Las integraciones añaden `Authorization: Bearer` y tratan el 202 como "en cola".

## Respaldo y restauración

`scripts/backup.sh` genera `data/backups/<fecha>/` con `whatsapp.dump` (pg_dump custom),
`sesiones.tgz` (credenciales de Baileys), `redis.rdb` (colas e idempotencia), `INFO.txt` y
`MANIFEST.sha256`. Con `BACKUP_ENCRYPT_PASSPHRASE` (el instalador la genera en `.env`) cada
archivo se cifra con AES-256 y queda como `.enc`. Con `BACKUP_REMOTE_DEST=user@host:/ruta/`
se copia fuera del servidor por rsync/ssh. El instalador ofrece el cron diario a las 03:00;
retención local `BACKUP_RETENTION_DAYS` (30).

**Guarda `BACKUP_ENCRYPT_PASSPHRASE` fuera del servidor**: sin ella los `.enc` no se pueden
abrir. Y saca los respaldos del host: un respaldo que solo vive en el servidor muere con él.

Restaurar sobre el stack levantado (mismo host u otro con el mismo `.env`):

```bash
bash scripts/restore.sh data/backups/2026-10-19_0300            # pide escribir RESTAURAR
bash scripts/restore.sh data/backups/2026-10-19_0300 --sin-redis # solo BD y credenciales
```

El script verifica el manifiesto, descifra, guarda el estado actual en
`data/backups/pre-restore_<fecha>/`, para la API, hace `pg_restore --clean`, repone
`data/sesiones`, carga Redis y arranca comprobando `/api/health`. Si algo sale mal, el mismo
script restaura la carpeta `pre-restore_*`.

En un host nuevo: `git clone`, copiar el `.env` antiguo (mismos `JWT_SECRET`,
`POSTGRES_PASSWORD` y `BACKUP_ENCRYPT_PASSPHRASE`), `sudo bash install.sh` y después
`restore.sh` con la carpeta copiada. Las sesiones se reconectan solas si las credenciales
siguen vigentes en WhatsApp.

## Ciclo de vida de un envío

1. `POST /whatsapp/send*` valida usuario, sesión (propia, activa, conectada) y datos.
2. Se inserta la fila en `messages` con `status = queued`.
3. Se encola el job en Bull con `jobId = messages.id`.
4. El worker envía; al éxito marca `sent` con `waMessageId`. Lo que falle después del envío
   (presencia, borrado del temporal) no reintenta: evitar duplicados pesa más.
5. Los ACK de WhatsApp (`messages.update`) suben el estado a `delivered`, `read`, `played`.
   Nunca lo bajan.
6. Si el worker falla antes de enviar, Bull reintenta (texto: 1 intento; archivos: 2 con
   backoff). En el último intento la fila queda `failed` con `lastError`.

7. Un barrido cada 5 min marca `failed` ("job perdido") los `queued` con más de 15 min sin
   job vivo (reinicio con la cola vacía, Redis borrado).
8. Desactivar o borrar la sesión cancela sus jobs en espera y marca `failed` sus `queued`.
9. Un `failed` de texto o URL se reintenta con `POST /whatsapp/messages/:id/retry` (o el
   botón *Reintentar* del historial): crea un mensaje nuevo.

`GET /status` (admin) o la pestaña Administración resumen colas, sesiones, mensajes de las
últimas 24 h, webhooks y alertas. Jobs fallidos se conservan en Redis (hasta 1000):

```bash
docker compose -p whatsapp-gateway exec redis redis-cli KEYS 'bull:send-file:*' | head
```

### Webhook saliente

Los eventos viven en la tabla `webhook_events` (`pending`, `sent`, `failed`) y se entregan
por la cola `webhook` con 10 intentos. Si el receptor estuvo caído más de ~34 min, los
eventos quedan `failed`: `POST /webhooks/events/replay-failed` (o el botón *Reenviar
fallidos*) los vuelve a encolar. Para ver el último error de un evento:
`GET /webhooks/events?status=failed`.

## Diagnóstico

| Síntoma | Dónde mirar |
|---|---|
| 401 en todo | Token caducado (8 h) o usuario desactivado. `logs api` no lo registra; es el guard. |
| 429 `Demasiadas peticiones` | Rate limit por IP: 10 logins/min, 120 envíos/min, 600 en total. Cabecera `Retry-After`. Si varias integraciones salen por la misma IP, sube `RATE_LIMIT_SEND_PER_MIN`. |
| La API no arranca tras actualizar y el log dice `migration` | Una migración falló. `logs api` muestra el SQL; la BD queda como estaba (cada migración va en transacción). |
| 403 en una sesión | No eres dueño ni admin. `GET /session/:id` como admin muestra `owner`. |
| `Sesión no está conectada (estado: connecting)` | Esperar 15 s tras el QR. Si persiste: `logs api \| grep -E "Conectado\|Desconectado\|Reintento"`. |
| `Socket no disponible` | La sesión no se arrancó desde el último reinicio. Pedir el QR la levanta; si tiene credenciales conecta sin escanear. |
| Mensaje `failed` con `Archivo no encontrado` | El temporal se borró antes del reintento (reinicio entre intentos). Reenviar. |
| `La URL apunta a una dirección interna` | Anti-SSRF: el host resuelve a IP privada o es un nombre interno. Usar una URL pública sin redirecciones. |
| QR no aparece | Permisos de `data/sesiones` (`chown -R 1000:1000 data/`). |
| API no arranca | `JWT_SECRET` ausente o corto; `logs api` lo dice en la primera línea. |
| Webhook no llega | `GET /webhooks/config`: si `enabled:false`, la URL no es https (o falta `WEBHOOK_ALLOW_HTTP`). Si está activo, `GET /webhooks/events` muestra `lastError` del receptor (timeout 10 s, HTTP 5xx). |
| Mensaje `failed` con `job perdido` | La API se reinició con el job sin procesar o Redis se vació. Reintentar desde el historial. |
| Mensaje `failed` con `sesión desactivada` | Alguien desactivó o borró la sesión mientras había envíos en cola. |
| 409 en `/whatsapp/send` | Misma `Idempotency-Key` con otro cuerpo. Generar una clave por envío. |
| Buscar una petición concreta | `logs api \| grep rid=<X-Request-Id>` |

## Límites de capacidad conocidos

- Un proceso de API gestiona todas las sesiones: no se puede escalar a varios workers sin
  repartir sesiones entre procesos (pendiente).
- Las simulaciones de escritura ocupan al worker entre 3 y 20 s por mensaje. Con mucho
  volumen, usa `?fastMode=true` o acepta la latencia.
- Baileys consume ~100 MB de RAM por sesión conectada. Dimensiona el host en consecuencia.
