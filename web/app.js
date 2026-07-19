const $ = (id) => document.getElementById(id);
const KEY_STORE = 'ms.apiKey';

let apiKey = localStorage.getItem(KEY_STORE) || '';

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
  const res = await fetch(path, {
    method,
    body,
    headers: { Authorization: `Bearer ${apiKey}`, ...headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function render() {
  const unlocked = Boolean(apiKey);
  show($('authCard'), !unlocked);
  show($('sendCard'), unlocked);
  show($('listCard'), unlocked);
  show($('signOut'), unlocked);
  if (unlocked) refreshList();
}

/* --------------------------------------------------------------- unlock */

$('unlock').addEventListener('click', async () => {
  const key = $('apiKey').value.trim();
  if (!key) return flash('Enter the API key first.');
  apiKey = key;
  try {
    await api('/api/documents');
    localStorage.setItem(KEY_STORE, key);
    flash('');
    render();
  } catch (err) {
    apiKey = '';
    flash(err.message);
  }
});

$('signOut').addEventListener('click', () => {
  localStorage.removeItem(KEY_STORE);
  apiKey = '';
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
    if (/API key/i.test(err.message)) {
      localStorage.removeItem(KEY_STORE);
      apiKey = '';
      render();
    }
    flash(err.message);
  }
}

$('list').addEventListener('click', async (e) => {
  const id = e.target.dataset?.dl;
  if (!id) return;
  // Fetch with the auth header, then hand the blob to the OS.
  const res = await fetch(`/api/documents/${id}/download`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
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

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

$('serverSub').textContent = location.host;
render();
