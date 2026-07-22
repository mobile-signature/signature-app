const $ = (id) => document.getElementById(id);

// Held in memory for this page only, never persisted. Once the admin key is
// accepted the server sets an activation cookie, so subsequent calls need it
// only until the page reloads.
let adminKey = '';

function show(el, on) { el.classList.toggle('hidden', !on); }

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function flash(text, kind = 'err') {
  $('msg').innerHTML = text ? `<div class="msg ${kind}">${esc(text)}</div>` : '';
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (adminKey) headers.Authorization = `Bearer ${adminKey}`;
  const res = await fetch(path, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function renderUnlocked(on) {
  show($('gate'), !on);
  show($('mainCard'), on);
  show($('listCard'), on);
  if (on) load();
}

async function tryUnlock(key) {
  adminKey = key;
  try {
    await api('/api/licenses');
    flash('');
    renderUnlocked(true);
    return true;
  } catch (err) {
    adminKey = '';
    flash(err.message);
    renderUnlocked(false);
    return false;
  }
}

$('adminGo').addEventListener('click', () => {
  const key = $('adminKey').value.trim();
  if (!key) return flash('Enter the administrator key.');
  $('adminGo').disabled = true;
  tryUnlock(key).finally(() => {
    $('adminKey').value = '';
    $('adminGo').disabled = false;
  });
});
$('adminKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('adminGo').click(); });

$('create').addEventListener('click', async () => {
  $('create').disabled = true;
  try {
    const lic = await api('/api/licenses', { method: 'POST', body: { label: $('label').value.trim() } });
    $('label').value = '';
    flash(`New key: ${lic.key}`, 'ok');
    load();
  } catch (err) {
    flash(err.message);
  } finally {
    $('create').disabled = false;
  }
});

$('refresh').addEventListener('click', load);

async function load() {
  try {
    const licences = await api('/api/licenses');
    if (!licences.length) {
      $('list').innerHTML = '<p style="color:var(--muted);font-size:14px">No keys issued yet.</p>';
      return;
    }
    $('list').innerHTML = licences.map((l) => `
      <div class="lic ${l.revoked ? 'dead' : ''}">
        <code>${esc(l.key)}</code>
        <div class="row">
          <span class="meta">${esc(l.label || 'No label')} ·
            ${l.devices} device${l.devices === 1 ? '' : 's'} ·
            ${new Date(l.createdAt).toLocaleDateString()}</span>
          <button class="secondary" data-copy="${esc(l.key)}">Copy</button>
          ${l.revoked
            ? `<button class="secondary" data-restore="${esc(l.serial)}">Restore</button>`
            : `<button class="danger" data-revoke="${esc(l.serial)}">Revoke</button>`}
        </div>
      </div>`).join('');
  } catch (err) {
    flash(err.message);
  }
}

$('list').addEventListener('click', async (e) => {
  const { copy, revoke, restore } = e.target.dataset || {};

  if (copy) {
    try {
      await navigator.clipboard.writeText(copy);
      e.target.textContent = 'Copied';
      setTimeout(() => (e.target.textContent = 'Copy'), 1500);
    } catch {
      flash('Could not copy — select the key and copy it manually.');
    }
    return;
  }

  if (revoke) {
    if (!confirm('Revoke this key? Every device using it loses access immediately.')) return;
    try { await api(`/api/licenses/${revoke}/revoke`, { method: 'POST' }); flash(''); load(); }
    catch (err) { flash(err.message); }
    return;
  }

  if (restore) {
    try { await api(`/api/licenses/${restore}/restore`, { method: 'POST' }); flash(''); load(); }
    catch (err) { flash(err.message); }
  }
});

// An admin device that is already activated skips the key prompt.
(async () => {
  try {
    const state = await api('/api/activation');
    if (state.activated && state.admin) return renderUnlocked(true);
  } catch { /* fall through to the prompt */ }
  renderUnlocked(false);
})();
