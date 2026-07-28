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

// Two doors: the staff password, then the administrator key. The password stops
// a borrowed device wandering in here; the key authorises the actual changes.
let passedGate = false;

function renderUnlocked(on) {
  show($('pwGate'), !passedGate);
  show($('gate'), passedGate && !on);
  show($('mainCard'), passedGate && on);
  show($('listCard'), passedGate && on);
  if (passedGate && on) load();
}

$('pwGo').addEventListener('click', async () => {
  const password = $('pwPass').value;
  if (!password) return;
  $('pwGo').disabled = true;
  try {
    await api('/api/gate', { method: 'POST', body: { password } });
    passedGate = true;
    $('pwPass').value = '';
    $('pwMsg').innerHTML = '';
    // The gate may be all that was missing if this device is already admin.
    try {
      const state = await api('/api/activation');
      return renderUnlocked(Boolean(state.activated && state.admin));
    } catch {
      return renderUnlocked(false);
    }
  } catch (err) {
    $('pwMsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
    $('pwPass').value = '';
    $('pwPass').focus();
  } finally {
    $('pwGo').disabled = false;
  }
});

$('pwPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pwGo').click(); });

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
    const lic = await api('/api/licenses', {
      method: 'POST',
      body: {
        label: $('label').value.trim(),
        ttl: $('ttl').value.trim(),        // blank => never expires
        ttlUnit: $('ttlUnit').value,
      },
    });
    $('label').value = '';
    $('ttl').value = '';
    const until = lic.expiresAt
      ? ` (valid until ${new Date(lic.expiresAt).toLocaleString()})`
      : ' (never expires)';
    flash(`New key: ${lic.key}${until}`, 'ok');
    load();
  } catch (err) {
    flash(err.message);
  } finally {
    $('create').disabled = false;
  }
});

$('refresh').addEventListener('click', load);

let lastLicences = []; // so the expiry dialog can show the current setting

async function load() {
  try {
    const licences = await api('/api/licenses');
    lastLicences = licences;
    if (!licences.length) {
      $('list').innerHTML = '<p style="color:var(--muted);font-size:14px">No keys issued yet.</p>';
      return;
    }
    $('list').innerHTML = licences.map((l) => `
      <div class="lic ${l.revoked || l.expired ? 'dead' : ''}">
        <code>${esc(l.key)}</code>
        <div class="row">
          <span class="meta">${esc(l.label || 'No label')} ·
            ${l.devices} device${l.devices === 1 ? '' : 's'} ·
            ${l.documents} doc${l.documents === 1 ? '' : 's'} ·
            ${l.expired
              ? '<b style="color:var(--danger)">expired</b>'
              : l.expiresAt
                ? `expires ${new Date(l.expiresAt).toLocaleString()}`
                : 'never expires'}</span>
          <button class="secondary" data-copy="${esc(l.key)}">Copy</button>
          <button class="secondary" data-expiry="${esc(l.serial)}">Expiry</button>
          ${l.revoked
            ? `<button class="secondary" data-restore="${esc(l.serial)}">Restore</button>`
            : `<button class="danger" data-revoke="${esc(l.serial)}">Revoke</button>`}
        </div>
      </div>`).join('');
  } catch (err) {
    flash(err.message);
  }
}

/* ------------------------------------------------------- expiry dialog */

let expiryTarget = null; // serial currently being edited

function openExpiry(serial) {
  const lic = lastLicences.find((l) => l.serial === serial);
  expiryTarget = serial;
  $('expiryFor').textContent = lic
    ? `${lic.label || 'No label'} — ${lic.expired
        ? 'currently expired'
        : lic.expiresAt
          ? `currently expires ${new Date(lic.expiresAt).toLocaleString()}`
          : 'currently never expires'}`
    : serial;
  $('expiryMsg').innerHTML = '';
  $('newTtl').value = '';
  show($('expirySheet'), true);
  setTimeout(() => $('newTtl').focus(), 60);
}

function closeExpiry() {
  show($('expirySheet'), false);
  expiryTarget = null;
}

async function saveExpiry(body) {
  if (!expiryTarget) return;
  $('expirySave').disabled = true;
  $('expiryNever').disabled = true;
  try {
    const out = await api(`/api/licenses/${expiryTarget}/expiry`, { method: 'PATCH', body });
    closeExpiry();
    flash(out.expiresAt
      ? `Expiry updated — now valid until ${new Date(out.expiresAt).toLocaleString()}`
      : 'Expiry removed — this key no longer expires', 'ok');
    load();
  } catch (err) {
    $('expiryMsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
  } finally {
    $('expirySave').disabled = false;
    $('expiryNever').disabled = false;
  }
}

$('expiryCancel').addEventListener('click', closeExpiry);
$('expiryNever').addEventListener('click', () => saveExpiry({ never: true }));
$('expirySave').addEventListener('click', () => {
  const ttl = $('newTtl').value.trim();
  if (!ttl) {
    $('expiryMsg').innerHTML = '<div class="msg err">Enter how long it should stay valid.</div>';
    return $('newTtl').focus();
  }
  saveExpiry({ ttl, ttlUnit: $('newTtlUnit').value });
});
$('newTtl').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('expirySave').click(); });

$('list').addEventListener('click', async (e) => {
  const { copy, revoke, restore, expiry } = e.target.dataset || {};

  if (expiry) return openExpiry(expiry);

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

// Arriving with the gate cookie still valid (e.g. clicked through from the app)
// skips straight past the password.
(async () => {
  try {
    await api('/api/licenses');
    passedGate = true;
    return renderUnlocked(true);
  } catch { /* needs the password, the key, or both */ }
  renderUnlocked(false);
})();
