const API = '/api';

let pollTimer = null;
let qrTimer = null;
let activeSessionId = localStorage.getItem('wa.sessionId') || null;

// ---------- helpers ----------
function toast(msg, kind = 'info') {
  const id = 'toast-' + Date.now();
  const html = `
    <div id="${id}" class="toast align-items-center text-bg-${kind} border-0" role="alert">
      <div class="d-flex">
        <div class="toast-body">${msg}</div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
      </div>
    </div>`;
  document.getElementById('toastContainer').insertAdjacentHTML('beforeend', html);
  const t = new bootstrap.Toast(document.getElementById(id), { delay: 4000 });
  t.show();
  document.getElementById(id).addEventListener('hidden.bs.toast', () => document.getElementById(id).remove());
}

async function api(method, path, body, isForm = false) {
  const opts = { method, headers: {} };
  if (body && !isForm) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body && isForm) {
    opts.body = body;
  }
  const r = await fetch(API + path, opts);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
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

// ---------- estado de sesion ----------
async function refreshSessionState() {
  try {
    const states = await api('GET', '/whatsapp/status-sessions');
    let mySession = null;
    if (activeSessionId) {
      mySession = states.find(s => s.sessionId === activeSessionId);
    }
    if (!mySession && states.length > 0) {
      mySession = states[0];
      activeSessionId = mySession.sessionId;
      localStorage.setItem('wa.sessionId', activeSessionId);
    }

    if (!mySession) {
      setBadge('not_started');
      document.getElementById('sessionId').textContent = '-';
      document.getElementById('sessionNumber').textContent = '-';
      return;
    }

    setBadge(mySession.state);
    document.getElementById('sessionId').textContent = mySession.sessionId;

    if (mySession.state === 'open') {
      const info = await api('GET', `/whatsapp/session/${mySession.sessionId}/info`);
      document.getElementById('sessionNumber').textContent = info?.info?.number || info?.number || '-';

      // cierra modal QR si esta abierto
      const m = bootstrap.Modal.getInstance(document.getElementById('modalQr'));
      if (m) {
        m.hide();
        toast('WhatsApp vinculado correctamente', 'success');
      }
      if (qrTimer)   { clearInterval(qrTimer);   qrTimer = null; }
    }
  } catch (e) {
    console.warn('refreshSessionState', e);
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
    toast('Error vinculando: ' + JSON.stringify(e.data || e), 'danger');
  } finally {
    btn.disabled = false;
  }
}

async function loadQr(sid) {
  try {
    const r = await api('GET', `/whatsapp/qr/${sid}`);
    const wrap = document.getElementById('qrWrap');
    if (r.qr && r.qr.startsWith('data:image')) {
      wrap.innerHTML = `<img src="${r.qr}" alt="QR WhatsApp">`;
      document.getElementById('qrMsg').textContent = 'Escanea este QR';
    } else if (r.status === 'waiting') {
      document.getElementById('qrMsg').textContent = r.message || 'Conectado';
    } else {
      document.getElementById('qrMsg').textContent = r.message || 'Generando QR...';
    }
  } catch (e) {
    document.getElementById('qrMsg').textContent = 'Error: ' + JSON.stringify(e.data || e);
  }
}

async function desvincular() {
  if (!confirm('Cerrar sesion de WhatsApp?')) return;
  if (!activeSessionId) return;
  try {
    await api('DELETE', `/whatsapp/session/${activeSessionId}`);
    toast('Sesion cerrada', 'success');
    activeSessionId = null;
    localStorage.removeItem('wa.sessionId');
    refreshSessionState();
  } catch (e) {
    toast('Error: ' + JSON.stringify(e.data || e), 'danger');
  }
}

// ---------- envios ----------
function normalizeNumber(raw) {
  return String(raw || '').replace(/\D/g, '');
}

document.getElementById('formText').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!activeSessionId) { toast('Vincula WhatsApp primero', 'warning'); return; }
  const number = normalizeNumber(document.getElementById('textNumber').value);
  const message = document.getElementById('textMessage').value;
  const fastMode = document.getElementById('textFastMode').checked;
  try {
    const r = await api('POST', `/whatsapp/send?fastMode=${fastMode}`, { sessionId: activeSessionId, number, message });
    toast(r.message || 'Mensaje enviado', 'success');
    document.getElementById('textMessage').value = '';
  } catch (e) {
    toast('Error: ' + JSON.stringify(e.data || e), 'danger');
  }
});

document.getElementById('formMediaFile').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!activeSessionId) { toast('Vincula WhatsApp primero', 'warning'); return; }
  const number = normalizeNumber(document.getElementById('mediaFileNumber').value);
  const caption = document.getElementById('mediaFileCaption').value;
  const files = document.getElementById('mediaFileFiles').files;
  if (!files.length) { toast('Selecciona un archivo', 'warning'); return; }
  const fd = new FormData();
  fd.append('sessionId', activeSessionId);
  fd.append('number', number);
  if (caption) fd.append('caption', caption);
  for (const f of files) fd.append('files', f);
  try {
    const r = await api('POST', '/whatsapp/send-media/file', fd, true);
    toast(r.message || 'Archivo enviado', 'success');
    ev.target.reset();
  } catch (e) {
    toast('Error: ' + JSON.stringify(e.data || e), 'danger');
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
    toast(r.message || 'Archivo enviado', 'success');
    ev.target.reset();
  } catch (e) {
    toast('Error: ' + JSON.stringify(e.data || e), 'danger');
  }
});

document.getElementById('formCheck').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!activeSessionId) { toast('Vincula WhatsApp primero', 'warning'); return; }
  const number = normalizeNumber(document.getElementById('checkNumber').value);
  try {
    const r = await api('GET', `/whatsapp/check-number?sessionId=${activeSessionId}&number=${number}`);
    document.getElementById('checkResult').innerHTML =
      `<div class="alert alert-${r.exists ? 'success' : 'warning'}">
        ${r.exists ? '<i class="bi bi-check-circle"></i> Existe en WhatsApp' : '<i class="bi bi-exclamation-circle"></i> No existe en WhatsApp'}
        <pre class="mb-0 mt-2 small">${JSON.stringify(r, null, 2)}</pre>
      </div>`;
  } catch (e) {
    document.getElementById('checkResult').innerHTML =
      `<div class="alert alert-danger">Error: ${JSON.stringify(e.data || e)}</div>`;
  }
});

// ---------- historial ----------
async function refreshHistory() {
  if (!activeSessionId) return;
  try {
    const r = await api('GET', `/messages?session=${activeSessionId}&limit=50`);
    const rows = (r.data || []).map(m => `
      <tr>
        <td><small>${new Date(m.created_at).toLocaleString()}</small></td>
        <td><code>${m.receptor || '-'}</code></td>
        <td>${(m.message || '').substring(0, 80)}${(m.message || '').length > 80 ? '...' : ''}</td>
        <td>${m.sent ? '<span class="badge bg-success">enviado</span>' : '<span class="badge bg-warning">pendiente</span>'}</td>
      </tr>
    `).join('');
    document.getElementById('historyBody').innerHTML = rows ||
      '<tr><td colspan="4" class="text-center text-muted">Sin datos</td></tr>';
  } catch (e) {
    document.getElementById('historyBody').innerHTML =
      `<tr><td colspan="4" class="text-danger">Error: ${JSON.stringify(e.data || e)}</td></tr>`;
  }
}

document.getElementById('btnRefreshHistory').addEventListener('click', refreshHistory);

// ---------- bootstrap ----------
document.getElementById('btnVincular').addEventListener('click', vincularWhatsApp);
document.getElementById('btnDesvincular').addEventListener('click', desvincular);

document.getElementById('modalQr').addEventListener('hidden.bs.modal', () => {
  if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
});

// Polling cada 3s
refreshSessionState();
pollTimer = setInterval(refreshSessionState, 3000);
