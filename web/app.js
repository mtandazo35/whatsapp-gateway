const API = '/api';

let pollTimer = null;
let qrTimer = null;
let refreshing = false;
let activeSessionId = localStorage.getItem('wa.sessionId') || null;
let token = localStorage.getItem('wa.token') || null;
let currentUser = null;
let lastInfoFor = null;   // sessionId para el que ya se pidio /info estando open
let sessionsCache = [];   // sesiones visibles (para el selector)

// ---------- helpers ----------

/** Escapa texto para meterlo en HTML. Todo lo que viene de la API o del usuario pasa por aqui. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function errText(e) {
  const d = e && e.data;
  if (d && typeof d === 'object') {
    if (Array.isArray(d.message)) return d.message.join('; ');
    if (d.message) return String(d.message);
  }
  if (typeof d === 'string' && d) return d;
  if (e && e.message) return e.message;
  return 'error desconocido';
}

function fecha(v) {
  try { return new Date(v).toLocaleString(); } catch { return String(v || ''); }
}

function isAdmin() {
  return !!currentUser && (currentUser.rol === 'ADMIN' || currentUser.rol === 'SUPER_ADMIN');
}

function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast align-items-center text-bg-${kind} border-0`;
  el.setAttribute('role', 'alert');
  el.innerHTML = `
      <div class="d-flex">
        <div class="toast-body"></div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
      </div>`;
  el.querySelector('.toast-body').textContent = msg;
  document.getElementById('toastContainer').appendChild(el);
  const t = new bootstrap.Toast(el, { delay: 4500 });
  t.show();
  el.addEventListener('hidden.bs.toast', () => el.remove());
}

async function api(method, path, body, isForm = false, extraHeaders = {}) {
  const opts = { method, headers: { ...extraHeaders } };
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (body && !isForm) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body && isForm) {
    opts.body = body;
  }
  const r = await fetch(API + path, opts);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (r.status === 401 && !path.startsWith('/user/login')) {
    setToken(null);
    showLogin();
  }
  if (r.status === 429) {
    const wait = r.headers.get('Retry-After');
    toast(`Demasiadas peticiones. Espera ${wait ? wait + ' s' : 'un momento'}.`, 'warning');
  }
  if (!r.ok) throw { status: r.status, data };
  return data;
}

/** Genera una Idempotency-Key por envio: un reintento del navegador no duplica el mensaje. */
function idemKey() {
  return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
}

function setBadge(state) {
  const map = {
    open:        ['bg-success', 'Conectado'],
    connecting:  ['bg-warning text-dark', 'Conectando...'],
    close:       ['bg-danger', 'Desconectado'],
    not_started: ['bg-secondary', 'Sin sesion'],
  };
  const [cls, txt] = map[state] || ['bg-secondary', state || 'cargando...'];
  const badge = document.getElementById('sessionBadge');
  badge.className = 'badge ' + cls;
  badge.textContent = txt;

  const stateBadge = document.getElementById('sessionState');
  stateBadge.className = 'badge ' + cls;
  stateBadge.textContent = txt;

  document.getElementById('btnVincular').classList.toggle('d-none', state === 'open');
  document.getElementById('btnDesvincular').classList.toggle('d-none', state !== 'open');
}

// ---------- autenticacion ----------

function setToken(value) {
  token = value;
  if (value) localStorage.setItem('wa.token', value);
  else localStorage.removeItem('wa.token');
}

function loginModal() {
  return bootstrap.Modal.getOrCreateInstance(document.getElementById('modalLogin'));
}

function showLogin() {
  currentUser = null;
  document.getElementById('userBadge').classList.add('d-none');
  document.getElementById('btnLogout').classList.add('d-none');
  document.getElementById('tabAdminLi').classList.add('d-none');
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  loginModal().show();
}

function onAuthenticated(user) {
  currentUser = user;
  const badge = document.getElementById('userBadge');
  badge.textContent = `${user.email} (${user.rol})`;
  badge.classList.remove('d-none');
  document.getElementById('btnLogout').classList.remove('d-none');
  document.getElementById('tabAdminLi').classList.toggle('d-none', !isAdmin());
  loginModal().hide();
  loadSessions().then(refreshSessionState);
  if (!pollTimer) pollTimer = setInterval(refreshSessionState, 3000);
}

async function bootstrapAuth() {
  if (!token) { showLogin(); return; }
  try {
    const me = await api('GET', '/user/me');
    onAuthenticated(me);
  } catch {
    if (token) showLogin();
  }
}

document.getElementById('formLogin').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = document.getElementById('btnLogin');
  const errBox = document.getElementById('loginError');
  errBox.classList.add('d-none');
  btn.disabled = true;
  try {
    const r = await api('POST', '/user/login', {
      email: document.getElementById('loginEmail').value.trim(),
      password: document.getElementById('loginPassword').value,
    });
    setToken(r.token);
    document.getElementById('loginPassword').value = '';
    onAuthenticated(r);
  } catch (e) {
    errBox.textContent = errText(e);
    errBox.classList.remove('d-none');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btnLogout').addEventListener('click', () => {
  setToken(null);
  activeSessionId = null;
  lastInfoFor = null;
  showLogin();
});

// ---------- sesiones: selector ----------

async function loadSessions() {
  try {
    const r = await api('GET', '/session?limit=100');
    sessionsCache = (r.data || []).filter(s => s.isActive !== false);
  } catch (e) {
    sessionsCache = [];
  }
  const sel = document.getElementById('sessionSelect');
  const btnNueva = document.getElementById('btnNuevaSesion');
  sel.replaceChildren();
  for (const s of sessionsCache) {
    const opt = document.createElement('option');
    opt.value = s.sessionId;
    opt.textContent = `${s.nameSession} (${s.sessionId})${s.numberSession ? ' · ' + s.numberSession : ''}`;
    sel.appendChild(opt);
  }
  // Mantener la elegida si sigue existiendo; si no, la unica o ninguna.
  if (!sessionsCache.some(s => s.sessionId === activeSessionId)) {
    activeSessionId = sessionsCache.length === 1 ? sessionsCache[0].sessionId : (sessionsCache[0]?.sessionId || null);
    if (activeSessionId) localStorage.setItem('wa.sessionId', activeSessionId);
    else localStorage.removeItem('wa.sessionId');
    lastInfoFor = null;
  }
  if (activeSessionId) sel.value = activeSessionId;
  sel.classList.toggle('d-none', sessionsCache.length < 2);
  btnNueva.classList.remove('d-none');
  const actual = sessionsCache.find(s => s.sessionId === activeSessionId);
  document.getElementById('sessionName').textContent = actual ? actual.nameSession : '-';
}

document.getElementById('sessionSelect').addEventListener('change', (ev) => {
  activeSessionId = ev.target.value || null;
  if (activeSessionId) localStorage.setItem('wa.sessionId', activeSessionId);
  lastInfoFor = null;
  const actual = sessionsCache.find(s => s.sessionId === activeSessionId);
  document.getElementById('sessionName').textContent = actual ? actual.nameSession : '-';
  refreshSessionState();
  refreshHistory();
});

document.getElementById('btnNuevaSesion').addEventListener('click', async () => {
  const nombre = prompt('Nombre de la nueva sesion (ej. ventas):', 'GATEWAY-' + Date.now());
  if (!nombre) return;
  try {
    const created = await api('POST', '/session', { nameSession: nombre });
    activeSessionId = created.sessionId;
    localStorage.setItem('wa.sessionId', activeSessionId);
    toast(`Sesion ${created.nameSession} creada. Vinculala con el boton verde.`, 'success');
    await loadSessions();
    refreshSessionState();
  } catch (e) {
    toast('Error creando la sesion: ' + errText(e), 'danger');
  }
});

// ---------- estado de sesion ----------
async function refreshSessionState() {
  if (!token || refreshing) return;
  refreshing = true;
  try {
    const states = await api('GET', '/whatsapp/status-sessions');
    const mySession = activeSessionId ? states.find(s => s.sessionId === activeSessionId) : null;

    document.getElementById('sessionId').textContent = activeSessionId || '-';

    if (!mySession) {
      // Sesion creada pero nunca arrancada desde el ultimo reinicio: "sin sesion" hasta pedir QR.
      setBadge(activeSessionId ? 'not_started' : 'not_started');
      document.getElementById('sessionNumber').textContent = '-';
      lastInfoFor = null;
      return;
    }

    setBadge(mySession.state);

    if (mySession.state === 'open') {
      if (lastInfoFor !== mySession.sessionId) {
        const info = await api('GET', `/whatsapp/session/${encodeURIComponent(mySession.sessionId)}/info`);
        document.getElementById('sessionNumber').textContent = info?.info?.number || '-';
        lastInfoFor = mySession.sessionId;
      }
      const m = bootstrap.Modal.getInstance(document.getElementById('modalQr'));
      if (m && document.getElementById('modalQr').classList.contains('show')) {
        m.hide();
        toast('WhatsApp vinculado correctamente', 'success');
      }
      if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
    } else {
      lastInfoFor = null;
      document.getElementById('sessionNumber').textContent = '-';
    }
  } catch (e) {
    console.warn('refreshSessionState', e);
  } finally {
    refreshing = false;
  }
}

// ---------- vincular ----------
async function vincularWhatsApp() {
  const btn = document.getElementById('btnVincular');
  btn.disabled = true;
  try {
    let sid = activeSessionId;

    if (!sid) {
      const created = await api('POST', '/session', { nameSession: 'GATEWAY-' + Date.now() });
      sid = created.sessionId;
      activeSessionId = sid;
      localStorage.setItem('wa.sessionId', sid);
      await loadSessions();
    }

    new bootstrap.Modal('#modalQr').show();
    await loadQr(sid);
    if (qrTimer) clearInterval(qrTimer);
    qrTimer = setInterval(() => loadQr(sid), 7000);
  } catch (e) {
    toast('Error vinculando: ' + errText(e), 'danger');
  } finally {
    btn.disabled = false;
  }
}

async function loadQr(sid) {
  try {
    const r = await api('GET', `/whatsapp/qr/${encodeURIComponent(sid)}`);
    const wrap = document.getElementById('qrWrap');
    if (r.qr && typeof r.qr === 'string' && r.qr.startsWith('data:image/png;base64,')) {
      wrap.replaceChildren();
      const img = document.createElement('img');
      img.src = r.qr;
      img.alt = 'QR WhatsApp';
      wrap.appendChild(img);
      const msg = document.createElement('div');
      msg.className = 'text-muted mt-2';
      msg.id = 'qrMsg';
      msg.textContent = 'Escanea este QR';
      wrap.appendChild(msg);
    } else {
      const msg = document.getElementById('qrMsg');
      if (msg) msg.textContent = r.message || (r.status === 'waiting' ? 'Conectado' : 'Generando QR...');
    }
  } catch (e) {
    const msg = document.getElementById('qrMsg');
    if (msg) msg.textContent = 'Error: ' + errText(e);
  }
}

async function desvincular() {
  if (!confirm('Cerrar sesion de WhatsApp? Habra que escanear el QR de nuevo.')) return;
  if (!activeSessionId) return;
  try {
    await api('DELETE', `/whatsapp/session/${encodeURIComponent(activeSessionId)}`);
    toast('Sesion cerrada', 'success');
    lastInfoFor = null;
    refreshSessionState();
  } catch (e) {
    toast('Error: ' + errText(e), 'danger');
  }
}

// ---------- envios ----------
function normalizeNumber(raw) {
  return String(raw || '').replace(/\D/g, '');
}

function describeQueued(r) {
  if (r && r.status === 'duplicate') return 'Peticion repetida: ya estaba en proceso.';
  if (r && r.messageId) return `En cola (id ${r.messageId.slice(0, 8)}…). Revisa el historial para ver el estado.`;
  if (r && Array.isArray(r.queued)) return `${r.queued.length} archivo(s) en cola. Revisa el historial para ver el estado.`;
  return (r && r.message) || 'Aceptado';
}

document.getElementById('formText').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!activeSessionId) { toast('Vincula WhatsApp primero', 'warning'); return; }
  const number = normalizeNumber(document.getElementById('textNumber').value);
  const message = document.getElementById('textMessage').value;
  const fastMode = document.getElementById('textFastMode').checked;
  try {
    const r = await api('POST', `/whatsapp/send?fastMode=${fastMode}`, { sessionId: activeSessionId, number, message }, false, { 'Idempotency-Key': idemKey() });
    toast(describeQueued(r), 'success');
    document.getElementById('textMessage').value = '';
  } catch (e) {
    toast('Error: ' + errText(e), 'danger');
  }
});

document.getElementById('formMediaFile').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!activeSessionId) { toast('Vincula WhatsApp primero', 'warning'); return; }
  const number = normalizeNumber(document.getElementById('mediaFileNumber').value);
  const caption = document.getElementById('mediaFileCaption').value;
  const files = document.getElementById('mediaFileFiles').files;
  if (!files.length) { toast('Selecciona un archivo', 'warning'); return; }
  if (files.length > 10) { toast('Maximo 10 archivos por envio', 'warning'); return; }
  const fd = new FormData();
  fd.append('sessionId', activeSessionId);
  fd.append('number', number);
  if (caption) fd.append('caption', caption);
  for (const f of files) fd.append('files', f);
  try {
    const r = await api('POST', '/whatsapp/send-media/file', fd, true);
    toast(describeQueued(r), 'success');
    ev.target.reset();
  } catch (e) {
    toast('Error: ' + errText(e), 'danger');
  }
});

document.getElementById('formMediaUrl').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!activeSessionId) { toast('Vincula WhatsApp primero', 'warning'); return; }
  const number = normalizeNumber(document.getElementById('mediaUrlNumber').value);
  const mediaUrl = document.getElementById('mediaUrlUrl').value;
  const caption = document.getElementById('mediaUrlCaption').value;
  try {
    const r = await api('POST', '/whatsapp/send-media/url', { sessionId: activeSessionId, number, mediaUrl, caption }, false, { 'Idempotency-Key': idemKey() });
    toast(describeQueued(r), 'success');
    ev.target.reset();
  } catch (e) {
    toast('Error: ' + errText(e), 'danger');
  }
});

document.getElementById('formCheck').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!activeSessionId) { toast('Vincula WhatsApp primero', 'warning'); return; }
  const number = normalizeNumber(document.getElementById('checkNumber').value);
  const box = document.getElementById('checkResult');
  try {
    const r = await api('GET', `/whatsapp/check-number?sessionId=${encodeURIComponent(activeSessionId)}&number=${encodeURIComponent(number)}`);
    box.innerHTML = `<div class="alert alert-${r.exists ? 'success' : 'warning'}">
        <i class="bi bi-${r.exists ? 'check-circle' : 'exclamation-circle'}"></i>
        <span class="result-text"></span>
        <pre class="mb-0 mt-2 small"></pre>
      </div>`;
    box.querySelector('.result-text').textContent = r.exists ? ' Existe en WhatsApp' : ' No existe en WhatsApp';
    box.querySelector('pre').textContent = JSON.stringify(r, null, 2);
  } catch (e) {
    box.innerHTML = '<div class="alert alert-danger"></div>';
    box.querySelector('div').textContent = 'Error: ' + errText(e);
  }
});

// ---------- historial ----------
const STATUS_BADGE = {
  queued:    ['bg-secondary', 'en cola'],
  pending:   ['bg-secondary', 'pendiente'],
  sent:      ['bg-primary', 'enviado'],
  delivered: ['bg-info text-dark', 'entregado'],
  read:      ['bg-success', 'leido'],
  played:    ['bg-success', 'reproducido'],
  failed:    ['bg-danger', 'fallido'],
  error:     ['bg-danger', 'error'],
};

async function refreshHistory() {
  if (!activeSessionId) return;
  const body = document.getElementById('historyBody');
  const status = document.getElementById('historyStatus').value;
  try {
    const r = await api('GET', `/messages?session=${encodeURIComponent(activeSessionId)}&limit=50${status ? '&status=' + encodeURIComponent(status) : ''}`);
    body.replaceChildren();
    const rows = r.data || [];
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Sin datos</td></tr>';
      return;
    }
    for (const m of rows) {
      const texto = String(m.message || '');
      const corto = texto.length > 80 ? texto.substring(0, 80) + '...' : texto;
      const [cls, label] = STATUS_BADGE[m.status] || ['bg-secondary', m.status || '-'];
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><small>${esc(fecha(m.created_at))}</small></td>
        <td><code>${esc(m.receptor || '-')}</code></td>
        <td title="${esc(m.kind || 'text')}">${esc(corto)}</td>
        <td><span class="badge ${cls}"${m.lastError ? ` title="${esc(m.lastError)}"` : ''}>${esc(label)}</span></td>
        <td class="text-end"></td>`;
      if (m.status === 'failed' && m.kind !== 'file') {
        const btn = document.createElement('button');
        btn.className = 'btn btn-sm btn-outline-primary';
        btn.innerHTML = '<i class="bi bi-arrow-repeat"></i> Reintentar';
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            const rr = await api('POST', `/whatsapp/messages/${encodeURIComponent(m.id)}/retry`);
            toast(describeQueued(rr), 'success');
            refreshHistory();
          } catch (e) {
            toast('No se pudo reintentar: ' + errText(e), 'danger');
            btn.disabled = false;
          }
        });
        tr.lastElementChild.appendChild(btn);
      }
      if (m.lastError) {
        const small = document.createElement('div');
        small.className = 'small text-danger';
        small.textContent = m.lastError.length > 90 ? m.lastError.slice(0, 90) + '…' : m.lastError;
        tr.children[2].appendChild(small);
      }
      body.appendChild(tr);
    }
  } catch (e) {
    body.innerHTML = '<tr><td colspan="5" class="text-danger"></td></tr>';
    body.querySelector('td').textContent = 'Error: ' + errText(e);
  }
}

document.getElementById('btnRefreshHistory').addEventListener('click', refreshHistory);
document.getElementById('historyStatus').addEventListener('change', refreshHistory);
document.getElementById('tabHistoryBtn').addEventListener('shown.bs.tab', refreshHistory);

// ---------- administracion ----------

async function refreshStatus() {
  const box = document.getElementById('statusBox');
  try {
    const s = await api('GET', '/status');
    const q = s.queues?.send || {};
    const w = s.webhook?.events || {};
    const m = s.messagesLast24h || {};
    box.replaceChildren();
    const add = (k, v) => { const d = document.createElement('div'); d.innerHTML = `<strong>${esc(k)}:</strong> `; d.appendChild(document.createTextNode(String(v))); box.appendChild(d); };
    add('Uptime', `${Math.floor(s.uptimeSeconds / 3600)} h ${Math.floor((s.uptimeSeconds % 3600) / 60)} min`);
    add('Memoria API', `${s.memory?.rssMb} MB`);
    add('Sesiones', `${s.sessions?.total} (${Object.entries(s.sessions?.byState || {}).map(([k, v]) => `${k}: ${v}`).join(', ') || 'ninguna arrancada'})`);
    add('Cola de envio', `esperando ${q.waiting ?? 0}, activos ${q.active ?? 0}, retrasados ${q.delayed ?? 0}, fallidos ${q.failed ?? 0}`);
    add('Mensajes 24 h', Object.entries(m).map(([k, v]) => `${k}: ${v}`).join(', ') || '0');
    add('Webhook', s.webhook?.enabled ? `activo (${s.webhook.signed ? 'firmado' : 'sin firma'}) — pendientes ${w.pending ?? 0}, enviados ${w.sent ?? 0}, fallidos ${w.failed ?? 0}` : 'desactivado');
    if (s.alerts?.length) {
      const al = document.createElement('div');
      al.className = 'alert alert-warning py-1 px-2 mt-2 mb-0 small';
      al.textContent = s.alerts.join(' · ');
      box.appendChild(al);
    }
  } catch (e) {
    box.textContent = 'Error: ' + errText(e);
  }
}

async function refreshWebhooks() {
  const cfgBox = document.getElementById('webhookConfig');
  const body = document.getElementById('webhookBody');
  try {
    const cfg = await api('GET', '/webhooks/config');
    cfgBox.textContent = cfg.enabled ? `Destino: ${cfg.url} · ${cfg.signed ? 'firmado HMAC' : 'SIN firma'} · ${cfg.attempts} intentos` : 'Desactivado (WEBHOOK_URL vacio o invalido)';
    const r = await api('GET', '/webhooks/events?limit=30');
    body.replaceChildren();
    if (!r.data?.length) { body.innerHTML = '<tr><td colspan="5" class="text-muted">Sin eventos</td></tr>'; return; }
    for (const ev of r.data) {
      const tr = document.createElement('tr');
      const cls = ev.status === 'sent' ? 'bg-success' : ev.status === 'failed' ? 'bg-danger' : 'bg-secondary';
      tr.innerHTML = `<td><small>${esc(fecha(ev.created_at))}</small></td><td><code>${esc(ev.event)}</code></td>
        <td><span class="badge ${cls}"${ev.lastError ? ` title="${esc(ev.lastError)}"` : ''}>${esc(ev.status)}</span></td>
        <td>${esc(ev.attempts)}</td><td class="text-end"></td>`;
      if (ev.status !== 'sent') {
        const b = document.createElement('button');
        b.className = 'btn btn-sm btn-outline-primary';
        b.textContent = 'Reenviar';
        b.addEventListener('click', async () => {
          b.disabled = true;
          try { await api('POST', `/webhooks/events/${encodeURIComponent(ev.id)}/replay`); toast('Evento reencolado', 'success'); setTimeout(refreshWebhooks, 1500); }
          catch (e) { toast('Error: ' + errText(e), 'danger'); b.disabled = false; }
        });
        tr.lastElementChild.appendChild(b);
      }
      body.appendChild(tr);
    }
  } catch (e) {
    cfgBox.textContent = 'Error: ' + errText(e);
  }
}

async function refreshUsers() {
  const body = document.getElementById('usersBody');
  try {
    const r = await api('GET', '/user?limit=100');
    body.replaceChildren();
    for (const u of r.data || []) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(u.email)}</td><td>${esc(u.usuario)}</td><td><span class="badge bg-dark">${esc(u.rol)}</span></td>
        <td>${u.isActive ? '<span class="badge bg-success">si</span>' : '<span class="badge bg-secondary">no</span>'}</td>
        <td><small>${esc(fecha(u.created_at))}</small></td><td class="text-end"></td>`;
      if (u.id !== currentUser.id) {
        const b = document.createElement('button');
        b.className = `btn btn-sm ${u.isActive ? 'btn-outline-danger' : 'btn-outline-success'}`;
        b.textContent = u.isActive ? 'Desactivar' : 'Activar';
        b.addEventListener('click', async () => {
          if (u.isActive && !confirm(`Desactivar a ${u.email}? Sus tokens dejaran de valer al instante.`)) return;
          b.disabled = true;
          try { await api('PATCH', `/user/${encodeURIComponent(u.id)}`, { isActive: !u.isActive }); toast('Usuario actualizado', 'success'); refreshUsers(); }
          catch (e) { toast('Error: ' + errText(e), 'danger'); b.disabled = false; }
        });
        tr.lastElementChild.appendChild(b);
      }
      body.appendChild(tr);
    }
    if (!body.children.length) body.innerHTML = '<tr><td colspan="6" class="text-muted">Sin usuarios</td></tr>';
  } catch (e) {
    body.innerHTML = '<tr><td colspan="6" class="text-danger"></td></tr>';
    body.querySelector('td').textContent = 'Error: ' + errText(e);
  }
}

document.getElementById('formNewUser').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await api('POST', '/user', {
      email: document.getElementById('nuEmail').value.trim(),
      usuario: document.getElementById('nuUsuario').value.trim(),
      password: document.getElementById('nuPassword').value,
      rol: document.getElementById('nuRol').value,
    });
    toast('Usuario creado', 'success');
    ev.target.reset();
    refreshUsers();
  } catch (e) {
    toast('No se pudo crear: ' + errText(e), 'danger');
  }
});

document.getElementById('btnReplayFailed').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/webhooks/events/replay-failed');
    toast(`${r.replayed} evento(s) reencolados`, 'success');
    setTimeout(refreshWebhooks, 1500);
  } catch (e) {
    toast('Error: ' + errText(e), 'danger');
  }
});

document.getElementById('btnRefreshStatus').addEventListener('click', refreshStatus);
document.getElementById('btnRefreshWebhooks').addEventListener('click', refreshWebhooks);
document.getElementById('btnRefreshUsers').addEventListener('click', refreshUsers);
document.getElementById('tabAdminBtn').addEventListener('shown.bs.tab', () => { refreshStatus(); refreshWebhooks(); refreshUsers(); });

// ---------- bootstrap ----------
document.getElementById('btnVincular').addEventListener('click', vincularWhatsApp);
document.getElementById('btnDesvincular').addEventListener('click', desvincular);

document.getElementById('modalQr').addEventListener('hidden.bs.modal', () => {
  if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
});

bootstrapAuth();
