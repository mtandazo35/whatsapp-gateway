FROM caddy:2-alpine

# Caddy lee este Caddyfile en /etc/caddy/Caddyfile
COPY Caddyfile /etc/caddy/Caddyfile

# Frontend estatico
COPY index.html /srv/index.html
COPY app.js /srv/app.js
COPY styles.css /srv/styles.css

EXPOSE 80 443
