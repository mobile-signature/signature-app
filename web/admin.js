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
          <button class="secondary" data-remove="${esc(l.serial)}">Remove</button>
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

/* --------------------------------------------------- bulk-delete dialog */

let removeTarget = null; // serial currently being cleared

function openRemove(serial) {
  const lic = lastLicences.find((l) => l.serial === serial);
  removeTarget = serial;
  $('removeFor').textContent = lic
    ? `${lic.label || 'No label'} — ${lic.documents} doc${lic.documents === 1 ? '' : 's'} on this key`
    : serial;
  $('removeMsg').innerHTML = '';
  $('removeFrom').value = '';
  $('removeTo').value = '';
  show($('removeSheet'), true);
  setTimeout(() => $('removeFrom').focus(), 60);
}

function closeRemove() {
  show($('removeSheet'), false);
  removeTarget = null;
}

$('removeCancel').addEventListener('click', closeRemove);
$('removeGo').addEventListener('click', async () => {
  if (!removeTarget) return;
  const from = $('removeFrom').value;
  const to = $('removeTo').value;
  if (!from || !to) {
    $('removeMsg').innerHTML = '<div class="msg err">Choose both a From date and a To date.</div>';
    return;
  }
  if (!confirm('Delete every document on this key created in that date range? This cannot be undone.')) {
    return;
  }
  $('removeGo').disabled = true;
  try {
    const out = await api(`/api/licenses/${removeTarget}/documents/delete`, {
      method: 'POST',
      body: { from, to },
    });
    closeRemove();
    flash(`Deleted ${out.deleted} document${out.deleted === 1 ? '' : 's'}.`, 'ok');
    load();
  } catch (err) {
    $('removeMsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
  } finally {
    $('removeGo').disabled = false;
  }
});

/* ------------------------------------------------- delete-all-files dialog */

function openPurgeAll() {
  $('purgeMsg').innerHTML = '';
  $('purgeFrom').value = '';
  $('purgeTo').value = '';
  $('purgeGo').disabled = true;
  show($('purgeSheet'), true);
  setTimeout(() => $('purgeFrom').focus(), 60);
}

function closePurgeAll() {
  show($('purgeSheet'), false);
}

function refreshPurgeGoState() {
  $('purgeGo').disabled = !($('purgeFrom').value && $('purgeTo').value);
}

$('purgeAll').addEventListener('click', openPurgeAll);
$('purgeCancel').addEventListener('click', closePurgeAll);
$('purgeFrom').addEventListener('input', refreshPurgeGoState);
$('purgeTo').addEventListener('input', refreshPurgeGoState);

$('purgeGo').addEventListener('click', async () => {
  const from = $('purgeFrom').value;
  const to = $('purgeTo').value;
  if (!from || !to) return;
  if (!confirm('Are you sure you want to permanently remove all document files stored in MongoDB between the selected dates?')) {
    return;
  }
  $('purgeGo').disabled = true;
  try {
    const out = await api('/api/documents/purge-files', { method: 'POST', body: { from, to } });
    closePurgeAll();
    flash(`Removed ${out.purged} document file${out.purged === 1 ? '' : 's'} from MongoDB.`, 'ok');
    load();
  } catch (err) {
    $('purgeMsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
    $('purgeGo').disabled = false;
  }
});

$('list').addEventListener('click', async (e) => {
  const { copy, revoke, restore, expiry, remove } = e.target.dataset || {};

  if (expiry) return openExpiry(expiry);
  if (remove) return openRemove(remove);

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
