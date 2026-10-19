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

`scripts/backup.sh` genera `data/backups/<fecha>/` con el `pg_dump` (formato custom) y un
`sesiones.tgz`. El instalador ofrece el cron diario a las 03:00. Retención
`BACKUP_RETENTION_DAYS` (30).

El respaldo se queda en el mismo host: cópialo fuera (rsync/scp a otro servidor o a un
bucket) y cifra `sesiones.tgz`, que equivale a tener los teléfonos.

Restaurar en un host nuevo:

```bash
git clone https://github.com/mtandazo35/whatsapp-gateway.git && cd whatsapp-gateway
# copiar el .env antiguo (mismo JWT_SECRET y POSTGRES_PASSWORD)
sudo bash install.sh                                   # levanta vacío
docker compose -p whatsapp-gateway stop api
docker compose -p whatsapp-gateway exec -T postgres \
  pg_restore -U whatsapp -d whatsapp --clean --if-exists < data/backups/<fecha>/whatsapp.dump
tar -xzf data/backups/<fecha>/sesiones.tgz -C data/
chown -R 1000:1000 data/sesiones
docker compose -p whatsapp-gateway start api
```

Las sesiones se reconectan solas si las credenciales siguen vigentes en WhatsApp.

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

Jobs fallidos se conservan en Redis (hasta 1000) para inspección:

```bash
docker compose -p whatsapp-gateway exec redis redis-cli KEYS 'bull:send-file:*' | head
```

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
| Webhook no llega | `WEBHOOK_URL` vacío o el receptor tarda más de 10 s. Los reintentos viven en memoria. |

## Límites de capacidad conocidos

- Un proceso de API gestiona todas las sesiones: no se puede escalar a varios workers sin
  repartir sesiones entre procesos (pendiente).
- Las simulaciones de escritura ocupan al worker entre 3 y 20 s por mensaje. Con mucho
  volumen, usa `?fastMode=true` o acepta la latencia.
- Baileys consume ~100 MB de RAM por sesión conectada. Dimensiona el host en consecuencia.
