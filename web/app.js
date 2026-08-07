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

// Alerts the sender when a background poll finds a document newly signed.
// Playing it needs an earlier user gesture on this page — the poll timer that
// actually notices the signature is not one — so the first tap or click
// anywhere primes it (play immediately paused, synchronously, so it makes no
// sound) and every later play() then goes through on both desktop and phone.
const notificationSound = new Audio('/notification.mp3');
notificationSound.preload = 'auto';
document.addEventListener('click', () => {
  notificationSound.play().catch(() => {});
  notificationSound.pause();
  notificationSound.currentTime = 0;
}, { once: true });

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
  if (activated) {
    // The send card has just become visible, which is the moment Chrome fills
    // the access code — so this is the only useful place to undo it.
    guardAccessCode();
    refreshList();
    startPolling();
  } else {
    stopPolling();
  }
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

/* ------------------------------------------------------ staff password */

// Licences and Deactivate sit behind a password. The password is checked by
// the server — putting it in this file would let anyone read it from the page
// source, and the server rejects the underlying requests without it anyway.
let gateResolve = null;

function askPassword({ title, why }) {
  $('gateTitle').textContent = title;
  $('gateWhy').textContent = why;
  $('gateMsg').innerHTML = '';
  $('gatePass').value = '';
  show($('gateSheet'), true);
  setTimeout(() => $('gatePass').focus(), 60);
  return new Promise((resolve) => { gateResolve = resolve; });
}

function closePassword(result) {
  show($('gateSheet'), false);
  const resolve = gateResolve;
  gateResolve = null;
  if (resolve) resolve(result);
}

$('gateCancel').addEventListener('click', () => closePassword(false));

$('gateGo').addEventListener('click', async () => {
  const password = $('gatePass').value;
  if (!password) return;
  $('gateGo').disabled = true;
  try {
    await api('/api/gate', {
      method: 'POST',
      body: JSON.stringify({ password }),
      headers: { 'Content-Type': 'application/json' },
    });
    closePassword(true);
  } catch (err) {
    $('gateMsg').innerHTML = `<div class="msg err">${escapeHtml(err.message)}</div>`;
    $('gatePass').value = '';
    $('gatePass').focus();
  } finally {
    $('gateGo').disabled = false;
  }
});

$('gatePass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('gateGo').click(); });

$('adminLink').addEventListener('click', async (e) => {
  e.preventDefault();
  const okToGo = await askPassword({
    title: 'Licences',
    why: 'Enter the staff password to manage licence keys.',
  });
  if (okToGo) window.location.href = '/admin';
});

$('signOut').addEventListener('click', async () => {
  const okToGo = await askPassword({
    title: 'Deactivate this device',
    why: 'Enter the staff password. You will need a licence key to use this device again.',
  });
  if (!okToGo) return;

  try {
    await api('/api/activation', { method: 'DELETE' });
  } catch (err) {
    return flash(err.message);
  }
  localStorage.removeItem('ms.apiKey'); // clear the pre-licensing leftover
  activated = false;
  isAdmin = false;
  flash('');
  render();
});

/* ----------------------------------------------------------------- send */

/* ------------------------------------------------ file / photo selection */

let picked = null; // { blob, name, kind }
let lastDocTitle = ''; // title of the most recently created link, for sharing

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

// Focus + briefly highlight a required field. Shared by Title (on choosing a
// file, since it's the very next thing to fill in) and both Title and
// Recipient name (on trying to send with either left empty).
function highlightField(id) {
  const el = $(id);
  el.focus({ preventScroll: true });
  el.select(); // so existing text can be typed straight over
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('highlight-field');
  void el.offsetWidth; // restart the animation if it is still running
  el.classList.add('highlight-field');
  clearTimeout(el._highlightTimer);
  el._highlightTimer = setTimeout(() => el.classList.remove('highlight-field'), 2400);
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
    // Deliberately NOT auto-filled from the filename: the title is what the
    // recipient sees in the chat preview before they open anything, so it
    // should be something chosen for them to read, not "scan_0043".
    // A title already typed is left alone rather than wiped — just send
    // focus there next, since it's the very next thing to fill in.
    highlightField('title');
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

// Clear the "enter a title" complaint as soon as it stops being true.
$('title').addEventListener('input', () => {
  if ($('title').value.trim()) flash('');
});
$('signerName').addEventListener('input', () => {
  if ($('signerName').value.trim()) flash('');
});

$('file').addEventListener('change', (e) => choose(e.target.files[0]));
$('cameraInput').addEventListener('change', (e) => choose(e.target.files[0]));

// Phones have a real camera app the OS already knows how to open — the
// `capture` attribute on cameraInput does that directly, and it is a better
// experience than reimplementing a camera UI in the page (flash, zoom, native
// controls all come for free). Laptops have no such app to hand off to, so
// that is the one case this needs to actually build a capture flow for.
const isMobileDevice = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

let webcamStream = null;

function stopWebcam() {
  webcamStream?.getTracks().forEach((t) => t.stop());
  webcamStream = null;
  $('webcamVideo').srcObject = null;
}

async function openWebcam() {
  $('webcamMsg').innerHTML = '';
  show($('webcamSheet'), true);
  try {
    webcamStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' }, // ignored on desktop, harmless
      audio: false,
    });
    $('webcamVideo').srcObject = webcamStream;
  } catch (err) {
    // No camera, permission denied, or already in use elsewhere — fall back
    // to the plain file picker exactly as before this feature existed.
    show($('webcamSheet'), false);
    flash('Could not open the webcam (' + (err.message || err.name) + '). Choose a file instead.');
    $('file').click();
  }
}

$('webcamCapture').addEventListener('click', () => {
  const video = $('webcamVideo');
  if (!video.videoWidth) return; // stream not ready yet; ignore a stray early tap
  const canvas = $('webcamCanvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  canvas.toBlob((blob) => {
    stopWebcam();
    show($('webcamSheet'), false);
    if (!blob) return flash('Could not capture that photo. Try again.');
    // Same object shape a real <input type=file> change event delivers, so
    // choose() needs no changes at all to handle it.
    choose(new File([blob], 'webcam-photo.jpg', { type: 'image/jpeg' }));
  }, 'image/jpeg', 0.92);
});

$('webcamCancel').addEventListener('click', () => {
  stopWebcam();
  show($('webcamSheet'), false);
});

// The camera is only requested when the user asks for it — no upfront prompt.
$('cameraBtn').addEventListener('click', () => {
  if (isMobileDevice) {
    $('cameraInput').click();
  } else if (navigator.mediaDevices?.getUserMedia) {
    openWebcam();
  } else {
    // Older/unsupported browser: same graceful fallback as a denied prompt.
    flash('This browser cannot open a camera here. Choose a file instead.');
    $('file').click();
  }
});

/**
 * Chrome fills the access code with a stored credential and ignores the
 * field's autocomplete="off" while doing it, so the attribute alone cannot be
 * relied on. The code is picked fresh per document, so anything sitting in the
 * box the sender did not type is wrong by definition and safe to wipe.
 *
 * The timing is the whole difficulty. Chrome fills the field when it becomes
 * visible, and this one starts hidden — it is revealed only once the activation
 * check comes back — so a clear at page load runs before the fill it is meant
 * to undo. Hence sweeping across a window after each reveal instead.
 */
// Keyed on real typing rather than `input`, because autofill raises `input` too
// — listening for that would let the very thing being guarded against mark the
// field as the sender's own work.
let accessCodeTyped = false;
$('accessCode').addEventListener('keydown', () => { accessCodeTyped = true; });
$('accessCode').addEventListener('paste', () => { accessCodeTyped = true; });

// Chrome fires no autofill event, but styles.css starts a no-op animation on
// :-webkit-autofill, and that does fire one — the only signal that catches a
// fill whenever it happens rather than whenever it was guessed at.
$('accessCode').addEventListener('animationstart', (e) => {
  if (e.animationName === 'autofill-detected') clearAccessCodeAutofill();
});

function clearAccessCodeAutofill() {
  const field = $('accessCode');
  if (!accessCodeTyped && field.value) field.value = '';
}

function guardAccessCode() {
  // Spread out because the fill can land a beat after the reveal, and there is
  // no event that fires when Chrome does it.
  for (const delay of [0, 50, 150, 400, 800, 1500]) {
    setTimeout(clearAccessCodeAutofill, delay);
  }
}

window.addEventListener('pageshow', guardAccessCode); // back/forward restore

$('send').addEventListener('click', async () => {
  if (!picked) return flash('Choose a PDF, photo or screenshot to send.');

  const title = $('title').value.trim();
  if (!title) {
    highlightField('title');
    return flash('Enter a title for this document.');
  }

  const signerName = $('signerName').value.trim();
  if (!signerName) {
    highlightField('signerName');
    return flash("Enter the recipient's name.");
  }

  const form = new FormData();
  form.append('file', picked.blob, picked.name);
  form.append('title', title);
  form.append('signerName', signerName);
  form.append('signerEmail', $('signerEmail').value.trim());
  form.append('accessCode', $('accessCode').value.trim());

  $('send').disabled = true;
  $('send').textContent = 'Uploading…';
  try {
    const doc = await api('/api/documents', { method: 'POST', body: form });
    flash('');
    lastDocTitle = doc.title || '';
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
  // The document's own title, so the share sheet and the resulting message say
  // what the document is rather than a generic phrase.
  const title = lastDocTitle || 'Please sign this document';
  const text = `Please sign: ${title}`;

  // Sharing is user-initiated here: the OS sheet lets them pick the recipient.
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
    } catch { /* user dismissed the sheet */ }
  } else {
    window.location.href =
      `mailto:?subject=${encodeURIComponent(text)}&body=${encodeURIComponent(url)}`;
  }
});

/* ----------------------------------------------------------------- list */

$('refresh').addEventListener('click', () => refreshList({ userInitiated: true }));

// Tracks each document's last-seen status, so a background refresh can tell
// "just signed" (worth a banner) apart from "was already signed" (a no-op).
let lastKnownStatus = new Map();
let firstLoadDone = false;

async function refreshList({ userInitiated = false } = {}) {
  try {
    const docs = await api('/api/documents');
    if (!docs.length) {
      $('list').innerHTML = '<p style="color:var(--muted);font-size:14px">Nothing sent yet.</p>';
      lastKnownStatus = new Map();
      firstLoadDone = true;
      return;
    }

    // Only announce a transition INTO "signed" — never on the very first load
    // of the page (that would announce every already-signed document at
    // once) and never merely for re-fetching the same status again.
    if (firstLoadDone) {
      const newlySigned = docs.filter((d) => {
        const was = lastKnownStatus.get(d.id);
        return was && was !== 'signed' && d.status === 'signed';
      });
      // One at a time, not all at once: several downloads fired in the same
      // instant is exactly the pattern browsers treat as suspicious, and
      // Chrome would interrupt with an "allow multiple downloads?" prompt.
      // Detached from this function so the list still renders immediately.
      if (newlySigned.length) {
        (async () => {
          for (const d of newlySigned) {
            await announceSigned(d);
            if (newlySigned.length > 1) await new Promise((r) => setTimeout(r, 900));
          }
        })();
      }
    }
    lastKnownStatus = new Map(docs.map((d) => [d.id, d.status]));
    firstLoadDone = true;

    $('list').innerHTML = docs
      .map((d) => `
        <div class="doc">
          <div style="flex:1;min-width:0">
            <div class="title">${escapeHtml(d.title)}
              <button class="del-link" data-del="${d.id}" data-title="${escapeHtml(d.title)}"
                      data-signed="${d.status === 'signed' ? '1' : ''}"
                      aria-label="Delete ${escapeHtml(d.title)}">Remove</button>
            </div>
            <div class="meta">${escapeHtml(d.signerName || 'No recipient')} ·
              ${new Date(d.createdAt).toLocaleDateString()} · ${d.pageCount}p</div>
          </div>
          <span class="pill ${d.status}">${d.status}</span>
          <button class="ghost" style="flex:none;padding:8px 10px;font-size:12px"
                  data-dl="${d.id}" data-title="${escapeHtml(d.title)}">Get</button>
        </div>`)
      .join('');
  } catch (err) {
    // A silent background poll failing (network blip, cold start) should not
    // interrupt whatever the person is doing — only surface the error for an
    // explicit click of the Refresh button.
    if (userInitiated) flash(err.message);
  }
}

// Documents already saved automatically in this session, so a re-detected
// transition can never write the same file twice.
const autoSaved = new Set();

function toastStack() {
  let stack = document.querySelector('.toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
  }
  return stack;
}

async function announceSigned(doc) {
  notificationSound.currentTime = 0;
  notificationSound.play().catch(() => {});

  const box = document.createElement('div');
  box.className = 'signed-toast';
  const heading = `<b>✓ Signed</b><br />${escapeHtml(doc.title)}` +
    (doc.signerName ? ` — ${escapeHtml(doc.signerName)}` : '');
  box.innerHTML = heading;
  toastStack().appendChild(box);

  // Tapping the toast always downloads; on desktop it also fires by itself.
  let dismissAfter = 8000;
  box.addEventListener('click', async () => {
    try {
      await downloadDocument(doc.id, doc.title);
      box.remove();
    } catch {
      box.innerHTML = `${heading}<br /><small>Download failed — use Get in the list.</small>`;
    }
  });

  /**
   * Auto-save, desktop only.
   *
   * This is allowed precisely because the page is already open and running —
   * the save happens in the same live context that just noticed the change,
   * not out of nowhere. Browsers block downloads that arrive without any
   * page activity behind them, which is why this cannot work when the app is
   * closed; then it is genuinely the browser refusing, not a bug.
   *
   * Deliberately skipped on phones: iOS Safari in particular will not write a
   * file without a tap, and a silent failure there would be worse than simply
   * leaving the toast tappable.
   */
  if (!isMobileDevice && !autoSaved.has(doc.id)) {
    autoSaved.add(doc.id);
    try {
      await downloadDocument(doc.id, doc.title);
      box.innerHTML = `${heading}<br /><small>Saved to your Downloads folder.</small>`;
    } catch {
      // Blocked, offline, or the file is gone from a restarted free instance.
      autoSaved.delete(doc.id); // let a tap retry it
      box.innerHTML = `${heading}<br /><small>Tap to download.</small>`;
      dismissAfter = 15000; // needs a tap, so give it longer to be noticed
    }
  } else if (isMobileDevice) {
    box.innerHTML = `${heading}<br /><small>Tap to download.</small>`;
  }

  setTimeout(() => box.remove(), dismissAfter);
}

// Polls in the background so a signed document appears without pressing
// Refresh. Paused while the tab is hidden — a phone in a pocket has no
// reason to keep waking the radio to ask "is it signed yet?" — and it
// refreshes once immediately whenever the tab becomes visible again, so
// switching back always shows the current state right away.
let pollTimer = null;

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => refreshList(), 20_000);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
document.addEventListener('visibilitychange', () => {
  if (!activated) return;
  if (document.hidden) {
    stopPolling();
  } else {
    refreshList();
    startPolling();
  }
});

/**
 * Saves a document to the machine's normal downloads location.
 *
 * Shared by the Get button and the auto-save on signing, so both name the
 * file the same way and any fix reaches both.
 *
 * Fetching the blob ourselves (rather than pointing a link at the download
 * route) means the browser never sees the server's Content-Disposition
 * filename — a.download is then the only thing deciding the saved name, so it
 * is built from the title here, with the same sanitisation the server applies.
 */
async function downloadDocument(id, title) {
  const res = await fetch(`/api/documents/${id}/download`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Could not download that document.');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safe = String(title || '').trim().replace(/[^\w.\- ]+/g, '_');
  a.download = `${safe || id}.pdf`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Custom stand-in for window.confirm(), so the dialog can carry the app's own
 * name and styling instead of the browser chrome ("<origin> says ..."), and
 * say more when the document is a signed agreement than when it is an
 * unsigned draft — those two carry very different consequences even though
 * the button that triggers them looks identical.
 */
function confirmDelete(title, signed) {
  $('deleteTitle').textContent = signed ? 'Delete Signed Document?' : 'Delete Document?';
  $('deleteMsg').innerHTML = signed
    ? `Are you sure you want to delete <b>${escapeHtml(title)}</b>?<br /><br />` +
      'Before continuing, make sure you have saved a copy of the signed PDF. ' +
      'Once deleted, the signed document and its audit trail cannot be recovered.'
    : `Are you sure you want to delete <b>${escapeHtml(title)}</b>?<br /><br />` +
      'Once deleted, it cannot be recovered and its link will stop working.';

  show($('deleteSheet'), true);

  return new Promise((resolve) => {
    const cancelBtn = $('deleteCancel');
    const goBtn = $('deleteGo');
    const done = (result) => {
      show($('deleteSheet'), false);
      cancelBtn.removeEventListener('click', onCancel);
      goBtn.removeEventListener('click', onGo);
      resolve(result);
    };
    const onCancel = () => done(false);
    const onGo = () => done(true);
    cancelBtn.addEventListener('click', onCancel);
    goBtn.addEventListener('click', onGo);
  });
}

/**
 * Deleting is the only action in the app with no undo: the record, the audit
 * trail and the PDF all go, from the durable store as well as this machine.
 */
async function deleteDocument(btn) {
  const { del: id, title, signed } = btn.dataset;
  if (!(await confirmDelete(title, Boolean(signed)))) return;

  btn.disabled = true;
  try {
    await api(`/api/documents/${id}`, { method: 'DELETE' });
    flash(`Deleted “${title}”.`, 'ok');
    await refreshList();
  } catch (err) {
    btn.disabled = false; // the row is still there, so the button must work again
    flash(err.message);
  }
}

$('list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;

  if (btn.dataset.del) return deleteDocument(btn);

  if (btn.dataset.dl) {
    try {
      await downloadDocument(btn.dataset.dl, btn.dataset.title);
    } catch (err) {
      flash(err.message);
    }
  }
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
