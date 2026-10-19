# Modelo de seguridad

Qué protege el gateway, cómo, y qué queda fuera. Escrito para quien lo despliega o lo
integra; las decisiones de diseño van con el motivo para que no se deshagan por accidente.

## Superficie expuesta

Solo el contenedor `web` (Caddy) publica puertos: 80 y 443. La API (`3005`), PostgreSQL y
Redis viven en la red interna de Docker sin puertos en el host. Caddy reenvía `/api/*` a la
API y sirve el frontend estático para el resto.

## Autenticación

- **Deny by default.** `AuthGuard` está registrado como `APP_GUARD`: se ejecuta en todas las
  rutas sin que cada controlador tenga que acordarse. Solo `@Public()` abre una ruta, y hay
  tres: `POST /user/login`, `GET /health`, `GET /ready`.
- **JWT HS256** firmado con `JWT_SECRET` (la API no arranca si falta o tiene menos de 32
  caracteres). Caducidad `JWT_EXPIRES_IN`, 8 h por defecto.
- **El token no basta.** En cada petición el guard carga el usuario de la BD y exige que
  exista, no esté borrado y tenga `isActive = true`. Es la revocación: desactivar o borrar un
  usuario lo deja fuera en la siguiente petición sin lista negra de tokens.
- Contraseñas con bcrypt (10 rondas, asíncrono). El login responde lo mismo para correo
  inexistente y contraseña incorrecta.
- El frontend guarda el token en `localStorage` y lo manda como `Bearer`. No hay cookies, así
  que no hay CSRF; a cambio un XSS robaría el token, por eso la CSP y el escape (abajo).

## Autorización

Tres roles, decididos siempre en el servidor:

| Rol | Alcance |
|---|---|
| `USUARIO` | Sus sesiones y sus mensajes. Su perfil. |
| `ADMIN` | Todas las sesiones y mensajes. Gestiona `USUARIO` y `ADMIN`. |
| `SUPER_ADMIN` | Todo. Único que crea o edita `SUPER_ADMIN`. |

- `@Roles()` en la ruta; el guard compara con el rol cargado de la BD, no con el del token.
- Un usuario nunca elige su rol: el alta pública no existe; crea usuarios un administrador y
  `PATCH /user/me` no admite `rol` ni `isActive`.
- **Propiedad de sesiones.** `sessions.owner_id` se fija al crear. `SessionService.assertAccess`
  responde 403 a quien no sea dueño ni admin. Todas las rutas de `/whatsapp/*` y los
  mensajes pasan por ahí: conocer un `sessionId` no da acceso.
- El administrador inicial nace de `ADMIN_EMAIL` / `ADMIN_PASSWORD` **solo si la tabla está
  vacía**. Después esas variables no hacen nada.

## Anti-SSRF

`POST /whatsapp/send-media/url` descarga en nombre del cliente. Sin controles, un usuario
autenticado podría hacer que el servidor consultara `http://169.254.169.254/` o
`http://redis:6379/` y recibiera el resultado como documento. Controles en
`api/src/whatsapp/utils/url-guard.ts`:

1. Solo `http:` y `https:`. Sin usuario ni contraseña en la URL.
2. Nombres prohibidos: `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.lan`,
   `*.home.arpa`, `metadata.google.internal`.
3. El host se resuelve (todas las A/AAAA) y se rechaza si alguna dirección es privada,
   loopback, link-local, CGNAT, multicast, documentación o IPv6 mapeada a esos rangos.
4. `HEAD` con timeout de 10 s y `redirect: 'manual'`: cualquier 3xx se rechaza. Así un
   dominio público no puede rebotar hacia dentro.
5. El worker vuelve a validar la URL antes del `GET` y descarga con `maxRedirects: 0`,
   timeout 30 s y `maxContentLength` según el tipo.

Límite conocido: DNS rebinding entre la validación y la conexión. Mitigarlo del todo exige
fijar la IP resuelta en el agente HTTP; queda anotado como mejora.

## Subida de archivos

- Multer escribe en `./static` con nombre `UUID + extensión saneada`. El nombre original solo
  viaja como metadato. Dos subidas con el mismo nombre no se pisan y un job no puede borrar
  el archivo de otro.
- Límites: 10 archivos por petición, 25 MB por archivo, 10 campos. Caddy corta el cuerpo
  total en 25 MB.
- Si la petición se rechaza después de que multer escribió (sesión ajena, número inválido),
  el controlador borra los archivos.
- El worker borra el archivo al enviar y, si falla, solo en el último intento. La limpieza
  diaria (`00:01`) borra lo que tenga más de 24 h, nunca lo recién subido.
- No se inspecciona el contenido: el gateway reenvía documentos arbitrarios por diseño. El
  destinatario los recibe por WhatsApp, no se sirven desde este servidor.

## Frontend: XSS y cabeceras

- `web/app.js` no interpola nunca texto externo en HTML sin pasar por `esc()` o
  `textContent`. Los mensajes de error de la API también.
- Caddy añade a todas las respuestas:
  - `Content-Security-Policy`: scripts solo propios y de `cdn.jsdelivr.net`; `connect-src 'self'`;
    `frame-ancestors 'none'`; `object-src 'none'`. Los estilos inline están permitidos porque
    Bootstrap los necesita.
  - `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
    `Permissions-Policy` sin cámara, micrófono ni geolocalización. Se quita `Server`.
- CORS desactivado salvo `CORS_ORIGIN`. El frontend va por el mismo origen.

## Mensajes entrantes

El handler `messages-upsert` solo reenvía al webhook. Se eliminaron dos ramas heredadas del
ejemplo de Baileys que, ante los textos literales `requestPlaceholder` y `onDemandHistSync`
enviados por **cualquier contacto**, pedían reenvíos de placeholder y sincronización de
historial. Ese mecanismo es el vector del aviso
[GHSA-qvv5-jq5g-4cgg](https://github.com/WhiskeySockets/Baileys/security/advisories/GHSA-qvv5-jq5g-4cgg)
(mensajes y historial falsificados). Además se descartan los `upsert` con `requestId`,
porque el gateway nunca los solicita.

## Dependencias

- `@whiskeysockets/baileys` ≥ 7.0.0-rc.12 (versión parcheada del aviso anterior).
- El paquete `baileys` 6.7.18 se eliminó: no se importaba en ningún archivo y arrastraba su
  propio árbol vulnerable.
- `sharp` es dependencia directa porque el código lo usa directamente.
- Pendiente: `npm audit` en CI y `npm ci` en el Dockerfile para builds reproducibles.

## Secretos y datos en reposo

- `.env` se crea con `chmod 600` y está en `.gitignore`.
- Las credenciales de WhatsApp (`data/sesiones/<sessionId>/`) son equivalentes a tener el
  teléfono: quien las copie puede enviar como ese número. Protege el host y los respaldos.
- `data/backups/` queda `700` para root. El respaldo es local y sin cifrar: cópialo fuera del
  host por un canal cifrado.
- Los logs no imprimen contraseñas ni tokens. Sí imprimen números de teléfono de remitentes
  (`Mensaje entrante de 5939...`): trátalos como dato personal.

## Lo que este modelo no cubre

- **Rate limiting** de login y de envíos: no hay. Ponlo en Caddy o en un WAF delante si la
  API es pública.
- **Rotación de `JWT_SECRET`** invalida todos los tokens; no hay versión de token por usuario.
- **Auditoría de acciones** (quién envió qué): el historial guarda la sesión, no el usuario
  que pidió el envío.
- **Bloqueo del número por WhatsApp**: es un cliente no oficial. Las simulaciones de escritura
  y la caché de perfil reducen la señal, no la eliminan.
