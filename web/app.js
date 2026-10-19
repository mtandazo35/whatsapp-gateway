const API = '/api';

let pollTimer = null;
let qrTimer = null;
let refreshing = false;
let activeSessionId = localStorage.getItem('wa.sessionId') || null;
let token = localStorage.getItem('wa.token') || null;
let currentUser = null;
let lastInfoFor = null; // sessionId para el que ya se pidio /info estando open

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

/** Convierte el error de api() en un texto legible y corto. */
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

function toast(msg, kind = 'info') {
  const id = 'toast-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  const el = document.createElement('div');
  el.id = id;
  el.className = `toast align-items-center text-bg-${kind} border-0`;
  el.setAttribute('role', 'alert');
  el.innerHTML = `
      <div class="d-flex">
        <div class="toast-body"></div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
      </div>`;
  el.querySelector('.toast-body').textContent = msg;
  document.getElementById('toastContainer').appendChild(el);
  const t = new bootstrap.Toast(el, { delay: 4000 });
  t.show();
  el.addEventListener('hidden.bs.toast', () => el.remove());
}

async function api(method, path, body, isForm = false) {
  const opts = { method, headers: {} };
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
  if (!r.ok) throw { status: r.status, data };
  return data;
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
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  loginModal().show();
}

function onAuthenticated(user) {
  currentUser = user;
  const badge = document.getElementById('userBadge');
  badge.textContent = `${user.email} (${user.rol})`;
  badge.classList.remove('d-none');
  document.getElementById('btnLogout').classList.remove('d-none');
  loginModal().hide();
  refreshSessionState();
  if (!pollTimer) pollTimer = setInterval(refreshSessionState, 3000);
}

async function bootstrapAuth() {
  if (!token) { showLogin(); return; }
  try {
    const me = await api('GET', '/user/me');
    onAuthenticated(me);
  } catch {
    // api() ya mostro el login si fue 401
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

// ---------- estado de sesion ----------
async function refreshSessionState() {
  if (!token || refreshing) return;
  refreshing = true;
  try {
    const states = await api('GET', '/whatsapp/status-sessions');
    let mySession = null;
    if (activeSessionId) {
      mySession = states.find(s => s.sessionId === activeSessionId);
    }
    // Solo se adopta otra sesion si el usuario tiene exactamente una visible.
    if (!mySession && states.length === 1) {
      mySession = states[0];
      activeSessionId = mySession.sessionId;
      localStorage.setItem('wa.sessionId', activeSessionId);
    }

    if (!mySession) {
      setBadge('not_started');
      document.getElementById('sessionId').textContent = activeSessionId || '-';
      document.getElementById('sessionNumber').textContent = '-';
      lastInfoFor = null;
      return;
    }

    setBadge(mySession.state);
    document.getElementById('sessionId').textContent = mySession.sessionId;

    if (mySession.state === 'open') {
      // El numero y la foto no cambian: se piden una vez por sesion conectada.
      if (lastInfoFor !== mySession.sessionId) {
        const info = await api('GET', `/whatsapp/session/${encodeURIComponent(mySession.sessionId)}/info`);
        document.getElementById('sessionNumber').textContent = info?.info?.number || '-';
        lastInfoFor = mySession.sessionId;
      }

      // cierra modal QR si esta abierto
      const m = bootstrap.Modal.getInstance(document.getElementById('modalQr'));
      if (m && document.getElementById('modalQr').classList.contains('show')) {
        m.hide();
        toast('WhatsApp vinculado correctamente', 'success');
      }
      if (qrTimer)   { clearInterval(qrTimer);   qrTimer = null; }
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
    } else if (r.status === 'waiting') {
      document.getElementById('qrMsg').textContent = r.message || 'Conectado';
    } else {
      document.getElementById('qrMsg').textContent = r.message || 'Generando QR...';
    }
  } catch (e) {
    const msg = document.getElementById('qrMsg');
    if (msg) msg.textContent = 'Error: ' + errText(e);
  }
}

async function desvincular() {
  if (!confirm('Cerrar sesion de WhatsApp?')) return;
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
    const r = await api('POST', `/whatsapp/send?fastMode=${fastMode}`, { sessionId: activeSessionId, number, message });
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
    const r = await api('POST', '/whatsapp/send-media/url', { sessionId: activeSessionId, number, mediaUrl, caption });
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
  try {
    const r = await api('GET', `/messages?session=${encodeURIComponent(activeSessionId)}&limit=50`);
    const rows = (r.data || []).map(m => {
      const texto = String(m.message || '');
      const corto = texto.length > 80 ? texto.substring(0, 80) + '...' : texto;
      const [cls, label] = STATUS_BADGE[m.status] || ['bg-secondary', m.status || '-'];
      const title = m.lastError ? ` title="${esc(m.lastError)}"` : '';
      return `
      <tr>
        <td><small>${esc(new Date(m.created_at).toLocaleString())}</small></td>
        <td><code>${esc(m.receptor || '-')}</code></td>
        <td>${esc(corto)}</td>
        <td><span class="badge ${cls}"${title}>${esc(label)}</span></td>
      </tr>`;
    }).join('');
    body.innerHTML = rows ||
      '<tr><td colspan="4" class="text-center text-muted">Sin datos</td></tr>';
  } catch (e) {
    body.innerHTML = '<tr><td colspan="4" class="text-danger"></td></tr>';
    body.querySelector('td').textContent = 'Error: ' + errText(e);
  }
}

document.getElementById('btnRefreshHistory').addEventListener('click', refreshHistory);

// ---------- bootstrap ----------
document.getElementById('btnVincular').addEventListener('click', vincularWhatsApp);
document.getElementById('btnDesvincular').addEventListener('click', desvincular);

document.getElementById('modalQr').addEventListener('hidden.bs.modal', () => {
  if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
});

bootstrapAuth();
