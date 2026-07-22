const $ = (id) => document.getElementById(id);

// The licence key is exchanged once for an httpOnly activation cookie and is
// never kept in the browser. `activated` only mirrors what the server reports.
let activated = false;
let isAdmin = false;

function show(el, on) {
  el.classList.toggle('hidden', !on);
}

function flash(text, kind = 'err') {
  $('msg').innerHTML = text ? `<div class="msg ${kind}">${escapeHtml(text)}</div>` : '';
  if (text) window.scrollTo({ top: 0, behavior: 'smooth' });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  // same-origin credentials so the activation cookie travels automatically.
  const res = await fetch(path, { method, body, headers, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A revoked or expired activation drops straight back to the licence screen.
    if (data.needsActivation) {
      activated = false;
      render();
    }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function render() {
  show($('authCard'), !activated);
  show($('sendCard'), activated);
  show($('listCard'), activated);
  show($('signOut'), activated);
  show($('adminLink'), activated && isAdmin);
  if (activated) refreshList();
}

/* ----------------------------------------------------------- activation */

// Formats as the user types: MSIG-XXXXX-XXXXX-XXXXX-XXXXX
$('apiKey').addEventListener('input', (e) => {
  const raw = e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!raw.startsWith('MSIG') || raw.length > 24) return; // admin keys pass through untouched
  const body = raw.slice(4);
  const groups = body.match(/.{1,5}/g) || [];
  e.target.value = groups.length ? `MSIG-${groups.join('-')}` : 'MSIG';
});

async function activate() {
  const key = $('apiKey').value.trim();
  if (!key) return flash('Enter your licence key.');
  $('unlock').disabled = true;
  $('unlock').textContent = 'Activating…';
  try {
    const out = await api('/api/activation', {
      method: 'POST',
      body: JSON.stringify({ licenseKey: key }),
      headers: { 'Content-Type': 'application/json' },
    });
    $('apiKey').value = ''; // never leave the key sitting in the field
    activated = true;
    isAdmin = Boolean(out.admin);
    flash('');
    render();
  } catch (err) {
    flash(err.message);
  } finally {
    $('unlock').disabled = false;
    $('unlock').textContent = 'Activate';
  }
}

$('unlock').addEventListener('click', activate);
$('apiKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') activate(); });

$('signOut').addEventListener('click', async () => {
  if (!confirm('Deactivate this device? You will need your licence key to use it again.')) return;
  try { await api('/api/activation', { method: 'DELETE' }); } catch { /* already gone */ }
  localStorage.removeItem('ms.apiKey'); // clear the pre-licensing leftover
  activated = false;
  isAdmin = false;
  flash('');
  render();
});

/* ----------------------------------------------------------------- send */

/* ------------------------------------------------ file / photo selection */

let picked = null; // { blob, name, kind }

const MAX_IMAGE_EDGE = 2400; // plenty for signing; keeps uploads small

// Re-encodes any image the browser can decode into a JPEG the server accepts.
// This is what makes iPhone HEIC photos work: Safari decodes HEIC natively, so
// by the time it leaves the phone it is already a JPEG.
async function normalizeImage(file) {
  let bitmap;
  try {
    // `from-image` applies the EXIF rotation, so photos taken sideways are
    // upright in the PDF instead of lying on their side.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }

  const w = bitmap.width || bitmap.naturalWidth;
  const h = bitmap.height || bitmap.naturalHeight;
  if (!w || !h) throw new Error('That image could not be read.');

  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // flatten transparency; a signed page is opaque
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
  if (!blob) throw new Error('That image could not be converted.');
  return blob;
}

async function choose(file) {
  if (!file) return;
  flash('');
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const baseName = file.name.replace(/\.[^.]+$/, '') || 'Document';

  try {
    if (isPdf) {
      picked = { blob: file, name: file.name, kind: 'pdf' };
      preview(`📄 ${file.name} · ${fmtSize(file.size)}`);
    } else {
      preview('⏳ Preparing image…');
      const blob = await normalizeImage(file);
      picked = { blob, name: `${baseName}.jpg`, kind: 'image' };
      preview(`🖼️ ${baseName}.jpg · ${fmtSize(blob.size)} — will be signed as a one-page document`);
    }
    if (!$('title').value) $('title').value = baseName;
  } catch {
    picked = null;
    preview('');
    flash('That file could not be read. Try a PDF, JPEG or PNG.');
  }
}

function preview(text) {
  const el = $('filePreview');
  el.textContent = text;
  show(el, Boolean(text));
  el.style.cssText = text
    ? 'margin-top:10px;font-size:13px;color:var(--muted);padding:10px 12px;background:var(--surface-2);border-radius:10px'
    : '';
}

function fmtSize(bytes) {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

$('file').addEventListener('change', (e) => choose(e.target.files[0]));
$('cameraInput').addEventListener('change', (e) => choose(e.target.files[0]));

// The camera is only requested when the user asks for it — no upfront prompt.
$('cameraBtn').addEventListener('click', () => $('cameraInput').click());

$('send').addEventListener('click', async () => {
  if (!picked) return flash('Choose a PDF, photo or screenshot to send.');

  const form = new FormData();
  form.append('file', picked.blob, picked.name);
  form.append('title', $('title').value.trim() || picked.name);
  form.append('signerName', $('signerName').value.trim());
  form.append('signerEmail', $('signerEmail').value.trim());
  form.append('accessCode', $('accessCode').value.trim());

  $('send').disabled = true;
  $('send').textContent = 'Uploading…';
  try {
    const doc = await api('/api/documents', { method: 'POST', body: form });
    flash('');
    $('linkOut').value = doc.signUrl;
    show($('sendCard'), false);
    show($('resultCard'), true);
    warnIfLocalLink(doc.signUrl);
    loadQr(doc.signUrl);
    refreshList();
  } catch (err) {
    flash(err.message);
  } finally {
    $('send').disabled = false;
    $('send').textContent = 'Upload & create signing link';
  }
});

$('newDoc').addEventListener('click', () => {
  for (const id of ['file', 'cameraInput', 'title', 'signerName', 'signerEmail', 'accessCode']) {
    $(id).value = '';
  }
  picked = null;
  preview('');
  show($('resultCard'), false);
  show($('sendCard'), true);
});

// A link built from localhost only resolves on the machine that made it. Sent
// to anyone else it is dead on arrival, and nothing about the link itself says
// so — hence the warning here rather than a silent copy button.
function warnIfLocalLink(url) {
  const box = $('localWarn');
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
  if (!isLocal) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML =
    '<div class="msg err"><b>This link only works on this computer.</b><br />' +
    '"localhost" means "this device", so sending it to someone else will not ' +
    'work. Create the link from your deployed address instead.</div>';
}

async function loadQr(url) {
  const box = $('linkQr');
  box.innerHTML = '';
  try {
    const res = await fetch(`/api/qr?text=${encodeURIComponent(url)}`);
    if (!res.ok) throw new Error('qr');
    box.innerHTML = await res.text();
    const svg = box.querySelector('svg');
    if (svg) {
      svg.style.display = 'block';
      svg.style.width = '100%';
      svg.style.height = 'auto';
    }
  } catch {
    box.style.display = 'none'; // the link itself still works; QR is a bonus
  }
}

$('copyLink').addEventListener('click', async () => {
  const link = $('linkOut').value;
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    $('linkOut').select();
    document.execCommand('copy');
  }
  $('copyLink').textContent = 'Copied';
  setTimeout(() => ($('copyLink').textContent = 'Copy'), 1500);
});

$('shareLink').addEventListener('click', async () => {
  const url = $('linkOut').value;
  // Sharing is user-initiated here: the OS sheet lets them pick the recipient.
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Please sign this document', url });
    } catch { /* user dismissed the sheet */ }
  } else {
    window.location.href = `mailto:?subject=${encodeURIComponent('Please sign this document')}&body=${encodeURIComponent(url)}`;
  }
});

/* ----------------------------------------------------------------- list */

$('refresh').addEventListener('click', refreshList);

async function refreshList() {
  try {
    const docs = await api('/api/documents');
    if (!docs.length) {
      $('list').innerHTML = '<p style="color:var(--muted);font-size:14px">Nothing sent yet.</p>';
      return;
    }
    $('list').innerHTML = docs
      .map((d) => `
        <div class="doc">
          <div style="flex:1;min-width:0">
            <div class="title">${escapeHtml(d.title)}</div>
            <div class="meta">${escapeHtml(d.signerName || 'No recipient')} ·
              ${new Date(d.createdAt).toLocaleDateString()} · ${d.pageCount}p</div>
          </div>
          <span class="pill ${d.status}">${d.status}</span>
          <button class="ghost" style="flex:none;padding:8px 10px;font-size:12px"
                  data-dl="${d.id}">Get</button>
        </div>`)
      .join('');
  } catch (err) {
    flash(err.message); // api() already drops to the licence screen if needed
  }
}

$('list').addEventListener('click', async (e) => {
  const id = e.target.dataset?.dl;
  if (!id) return;
  // The activation cookie authenticates this; then hand the blob to the OS.
  const res = await fetch(`/api/documents/${id}/download`, { credentials: 'same-origin' });
  if (!res.ok) return flash('Could not download that document.');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${id}.pdf`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
});

/* ------------------------------------------------------------------ boot */

// An unmissable, always-visible marker when this is the local copy. Both
// copies look identical otherwise, and a link made here is dead for everyone
// but this machine — that must be obvious before uploading, not after sharing.
if (/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname)) {
  const bar = document.createElement('div');
  bar.textContent = 'LOCAL TEST COPY — links made here only work on this computer';
  bar.style.cssText =
    'position:sticky;top:0;z-index:999;background:#c0392b;color:#fff;' +
    'font-size:12px;font-weight:700;text-align:center;padding:9px 12px;' +
    'letter-spacing:0.02em;line-height:1.3';
  document.body.prepend(bar);
  document.title = `[LOCAL] ${document.title}`;
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

$('serverSub').textContent = location.host;

// Ask the server whether this device is already activated, so a returning user
// goes straight to the app instead of the licence screen.
(async () => {
  try {
    const state = await api('/api/activation');
    activated = Boolean(state.activated);
    isAdmin = Boolean(state.admin);
    if (!activated && state.reason) flash(state.reason);
  } catch {
    activated = false;
  }

  // One-time migration for devices that unlocked before licensing existed:
  // trade the stored key for an activation, then delete it.
  if (!activated) {
    const legacy = localStorage.getItem('ms.apiKey');
    if (legacy) {
      try {
        const out = await api('/api/activation', {
          method: 'POST',
          body: JSON.stringify({ licenseKey: legacy }),
          headers: { 'Content-Type': 'application/json' },
        });
        activated = true;
        isAdmin = Boolean(out.admin);
        flash('');
      } catch { /* stale key — fall through to the licence screen */ }
      localStorage.removeItem('ms.apiKey');
    }
  }

  render();
})();
