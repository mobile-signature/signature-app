import * as pdfjs from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const token = location.pathname.split('/').pop();

let ticket = null;
let doc = null;
let activeTool = null;
let pendingSpot = null;   // { pageIndex, x, y } captured on tap
let lastSignature = null; // reuse the drawn signature for repeat placements
const fields = [];        // { id, type, page, x, y, w, h, value, el }

const DEFAULT_SIZE = {
  signature: { w: 0.34, h: 0.075 },
  text: { w: 0.3, h: 0.035 },
  date: { w: 0.22, h: 0.035 },
  check: { w: 0.05, h: 0.028 },
};

function show(el, on) { el.classList.toggle('hidden', !on); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function toast(text, ms = 2200) {
  $('hint').textContent = text;
  show($('hint'), true);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => show($('hint'), false), ms);
}

function fatal(text, retryable = false) {
  show($('loading'), false);
  show($('gate'), false);
  show($('viewer'), false);
  $('fatalText').textContent = text;
  show($('fatalRetry'), retryable);
  show($('fatal'), true);
}

$('fatalRetry').addEventListener('click', () => window.location.reload());

// Rendering is driven by requestAnimationFrame, which browsers pause while a
// tab is in the background. Waiting for the tab to be visible avoids a render
// that silently never finishes.
function whenVisible() {
  if (!document.hidden) return Promise.resolve();
  $('loading').lastChild.textContent = ' Tap to continue loading…';
  return new Promise((resolve) => {
    const onShow = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', onShow);
      resolve();
    };
    document.addEventListener('visibilitychange', onShow);
  });
}

/* ------------------------------------------------------------------ open */

async function open(code) {
  let res;
  try {
    res = await fetch(`/api/sign/${encodeURIComponent(token)}/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(code ? { code } : {}),
    });
  } catch {
    return fatal('Could not reach the server. Check your connection and try again.', true);
  }
  const data = await res.json().catch(() => ({}));

  if (res.status === 401 && data.error === 'code_required') {
    show($('loading'), false);
    show($('gate'), true);
    $('code').focus();
    return;
  }
  if (res.status === 401) {
    show($('loading'), false);
    show($('gate'), true);
    $('gateMsg').innerHTML = `<div class="msg err">${esc(data.error)}</div>`;
    return;
  }
  if (!res.ok) return fatal(data.error || 'This link could not be opened.');

  doc = data;
  ticket = data.ticket;
  $('docTitle').textContent = doc.title;
  $('docSub').textContent = `${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'}`;
  $('fullName').value = doc.signerName || '';

  if (doc.alreadySigned) {
    show($('loading'), false);
    $('doneSub').textContent = 'This document has already been signed.';
    show($('done'), true);
    return;
  }

  try {
    await whenVisible();
    await renderPdf();
  } catch (err) {
    // Never leave the signer staring at a spinner with no explanation.
    fatal(`The document could not be displayed. ${err?.message || ''}`.trim(), true);
  }
}

$('codeGo').addEventListener('click', () => {
  const code = $('code').value.trim();
  if (!code) return;
  $('gateMsg').innerHTML = '';
  $('codeGo').disabled = true;
  open(code).finally(() => ($('codeGo').disabled = false));
});
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('codeGo').click(); });

/* ---------------------------------------------------------------- render */

// Rejects if a step hangs, so a stalled network or renderer becomes a visible
// error with a Retry button rather than an endless spinner.
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out.`)), ms);
    }),
  ]);
}

async function renderPdf() {
  const url = `/api/sign/${encodeURIComponent(token)}/file?ticket=${encodeURIComponent(ticket)}`;
  const pdf = await withTimeout(
    pdfjs.getDocument({ url, withCredentials: false }).promise,
    30000,
    'Downloading the document',
  );

  const container = $('pages');
  container.innerHTML = '';
  const cssWidth = Math.min(window.innerWidth - 16, 820);
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5); // cap: 3x on a 20-page PDF eats memory

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });

    const wrap = document.createElement('div');
    wrap.className = 'page';
    wrap.style.width = `${cssWidth}px`;
    wrap.dataset.page = String(i - 1);

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    wrap.appendChild(canvas);

    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    wrap.appendChild(overlay);

    container.appendChild(wrap);
    await withTimeout(
      page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise,
      30000,
      `Rendering page ${i}`,
    );
  }

  show($('loading'), false);
  show($('viewer'), true);
  toast('Pick a tool below, then tap where it goes.', 3400);
}

/* ------------------------------------------------------------- placement */

for (const btn of document.querySelectorAll('.tool')) {
  btn.addEventListener('click', () => {
    const tool = btn.dataset.tool;
    const turningOff = activeTool === tool;
    activeTool = turningOff ? null : tool;
    document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b === btn && !turningOff));
    if (activeTool) toast(`Tap the page to place your ${activeTool}.`);
  });
}

$('pages').addEventListener('click', (e) => {
  if (!activeTool) return;
  const pageEl = e.target.closest('.page');
  if (!pageEl || e.target.closest('.field')) return;

  const rect = pageEl.getBoundingClientRect();
  const size = DEFAULT_SIZE[activeTool];
  pendingSpot = {
    pageEl,
    page: Number(pageEl.dataset.page),
    // Centre the field on the tap, then clamp so it stays on the page.
    x: clamp((e.clientX - rect.left) / rect.width - size.w / 2, 0, 1 - size.w),
    y: clamp((e.clientY - rect.top) / rect.height - size.h / 2, 0, 1 - size.h),
    ...size,
  };

  if (activeTool === 'signature') {
    lastSignature ? placeField('signature', lastSignature) : openPad();
  } else if (activeTool === 'date') {
    placeField('date', new Date().toLocaleDateString());
  } else if (activeTool === 'check') {
    placeField('check', '✓');
  } else {
    $('textInput').value = '';
    show($('textSheet'), true);
    setTimeout(() => $('textInput').focus(), 50);
  }
});

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function placeField(type, value) {
  const spot = pendingSpot;
  if (!spot) return;
  pendingSpot = null;

  const field = {
    id: `f${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
    type,
    page: spot.page,
    x: spot.x, y: spot.y, w: spot.w, h: spot.h,
    value,
  };

  const el = document.createElement('div');
  el.className = 'field';
  el.dataset.id = field.id;
  if (type === 'signature') {
    const img = document.createElement('img');
    img.src = value;
    el.appendChild(img);
  } else {
    el.appendChild(document.createTextNode(value));
  }

  const del = document.createElement('button');
  del.className = 'del';
  del.textContent = '×';
  del.setAttribute('aria-label', 'Remove');
  el.appendChild(del);

  const grip = document.createElement('button');
  grip.className = 'grip';
  grip.setAttribute('aria-label', 'Resize');
  el.appendChild(grip);

  field.el = el;
  paint(field);
  spot.pageEl.querySelector('.overlay').appendChild(el);
  fields.push(field);

  del.addEventListener('click', (ev) => {
    ev.stopPropagation();
    el.remove();
    fields.splice(fields.indexOf(field), 1);
  });

  makeDraggable(field, el, spot.pageEl);
  makeResizable(field, grip, spot.pageEl);
}

function paint(f) {
  Object.assign(f.el.style, {
    left: `${f.x * 100}%`,
    top: `${f.y * 100}%`,
    width: `${f.w * 100}%`,
    height: `${f.h * 100}%`,
  });
}

function makeDraggable(field, el, pageEl) {
  let start = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('del') || e.target.classList.contains('grip')) return;
    el.setPointerCapture(e.pointerId);
    start = { px: e.clientX, py: e.clientY, x: field.x, y: field.y, rect: pageEl.getBoundingClientRect() };
  });
  el.addEventListener('pointermove', (e) => {
    if (!start) return;
    e.preventDefault();
    field.x = clamp(start.x + (e.clientX - start.px) / start.rect.width, 0, 1 - field.w);
    field.y = clamp(start.y + (e.clientY - start.py) / start.rect.height, 0, 1 - field.h);
    paint(field);
  });
  const end = () => { start = null; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

function makeResizable(field, grip, pageEl) {
  let start = null;
  grip.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    grip.setPointerCapture(e.pointerId);
    start = { px: e.clientX, py: e.clientY, w: field.w, h: field.h, rect: pageEl.getBoundingClientRect() };
  });
  grip.addEventListener('pointermove', (e) => {
    if (!start) return;
    e.preventDefault();
    field.w = clamp(start.w + (e.clientX - start.px) / start.rect.width, 0.03, 1 - field.x);
    field.h = clamp(start.h + (e.clientY - start.py) / start.rect.height, 0.015, 1 - field.y);
    paint(field);
  });
  const end = () => { start = null; };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
}

/* ---------------------------------------------------------- text sheet */

$('textDone').addEventListener('click', () => {
  const v = $('textInput').value.trim();
  if (!v) return;
  show($('textSheet'), false);
  placeField('text', v);
});
$('textCancel').addEventListener('click', () => {
  show($('textSheet'), false);
  pendingSpot = null;
});

/* ----------------------------------------------------- signature pad */

const pad = $('pad');
const ctx = pad.getContext('2d');
let drawing = false;
let hasInk = false;
let lastPt = null;
let lastMid = null; // where the previous curve segment ended

function openPad() {
  show($('padSheet'), true);
  // Size the backing store to the laid-out canvas so strokes are not blurry.
  requestAnimationFrame(() => {
    const rect = pad.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    pad.width = rect.width * dpr;
    pad.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0b1730';
    clearPad();
  });
}

function clearPad() {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pad.width, pad.height);
  ctx.restore();
  hasInk = false;
}

function padPoint(e) {
  const r = pad.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

pad.addEventListener('pointerdown', (e) => {
  pad.setPointerCapture(e.pointerId);
  drawing = true;
  lastPt = padPoint(e);
  lastMid = lastPt;
  // A dot, so a simple tap still leaves a mark.
  ctx.beginPath();
  ctx.arc(lastPt.x, lastPt.y, ctx.lineWidth / 2, 0, Math.PI * 2);
  ctx.fillStyle = '#0b1730';
  ctx.fill();
  hasInk = true;
});

function drawTo(p) {
  // Quadratic smoothing: each segment runs from the previous midpoint, through
  // the last raw point as the control, to the new midpoint. Starting at
  // lastMid (not lastPt) is what makes the segments join — starting at lastPt
  // leaves half of every segment undrawn, which renders as a dashed line.
  const mid = { x: (lastPt.x + p.x) / 2, y: (lastPt.y + p.y) / 2 };
  ctx.beginPath();
  ctx.moveTo(lastMid.x, lastMid.y);
  ctx.quadraticCurveTo(lastPt.x, lastPt.y, mid.x, mid.y);
  ctx.stroke();
  lastMid = mid;
  lastPt = p;
  hasInk = true;
}

pad.addEventListener('pointermove', (e) => {
  if (!drawing) return;
  e.preventDefault();
  // Fast strokes deliver several positions per frame; using them all keeps a
  // quick flick smooth instead of angular.
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of events.length ? events : [e]) drawTo(padPoint(ev));
});

function endStroke() {
  if (!drawing) return;
  // Close the gap between the final midpoint and where the finger actually
  // lifted, otherwise every stroke ends slightly short.
  ctx.beginPath();
  ctx.moveTo(lastMid.x, lastMid.y);
  ctx.lineTo(lastPt.x, lastPt.y);
  ctx.stroke();
  drawing = false;
}

// No pointerleave here: the pad captures the pointer, so a finger straying
// outside the box should keep drawing rather than cutting the stroke short.
for (const ev of ['pointerup', 'pointercancel']) {
  pad.addEventListener(ev, endStroke);
}

$('padClear').addEventListener('click', clearPad);
$('padCancel').addEventListener('click', () => {
  show($('padSheet'), false);
  pendingSpot = null;
});

$('padDone').addEventListener('click', () => {
  if (!hasInk) return toast('Draw your signature first.');
  const trimmed = trimTransparent(pad);
  lastSignature = trimmed;
  show($('padSheet'), false);
  placeField('signature', trimmed);
  toast('Tap again to place the same signature elsewhere.');
});

// Crop the transparent margin so the signature fills its box on the PDF.
function trimTransparent(canvas) {
  const c = canvas.getContext('2d');
  const { width, height } = canvas;
  const data = c.getImageData(0, 0, width, height).data;
  let top = height, left = width, right = 0, bottom = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (right <= left || bottom <= top) return canvas.toDataURL('image/png');

  const pad10 = 10;
  const out = document.createElement('canvas');
  out.width = right - left + pad10 * 2;
  out.height = bottom - top + pad10 * 2;
  out.getContext('2d').drawImage(
    canvas,
    left - pad10, top - pad10, out.width, out.height,
    0, 0, out.width, out.height,
  );
  return out.toDataURL('image/png');
}

/* ----------------------------------------------------------- submit */

$('finish').addEventListener('click', () => {
  if (!fields.length) return toast('Add at least your signature first.');
  if (!fields.some((f) => f.type === 'signature')) return toast('A signature is required.');
  $('finishMsg').innerHTML = '';
  show($('finishSheet'), true);
});

$('finishCancel').addEventListener('click', () => show($('finishSheet'), false));

$('finishGo').addEventListener('click', async () => {
  const signerName = $('fullName').value.trim();
  if (!signerName) return err('Please type your full name.');
  if (!$('consent').checked) return err('Please tick the consent box.');

  $('finishGo').disabled = true;
  $('finishGo').textContent = 'Submitting…';
  try {
    const res = await fetch(`/api/sign/${encodeURIComponent(token)}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticket,
        signerName,
        consent: true,
        fields: fields.map(({ type, page, x, y, w, h, value }) => ({ type, page, x, y, w, h, value })),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Submission failed.');

    show($('finishSheet'), false);
    show($('viewer'), false);
    $('doneSub').textContent = `Signed ${new Date(data.signedAt).toLocaleString()}. The sender has been notified.`;
    show($('done'), true);
  } catch (e2) {
    err(e2.message);
  } finally {
    $('finishGo').disabled = false;
    $('finishGo').textContent = 'Sign & submit';
  }

  function err(text) {
    $('finishMsg').innerHTML = `<div class="msg err">${esc(text)}</div>`;
  }
});

$('downloadCopy').addEventListener('click', async () => {
  // The signing ticket is spent, so re-open to get a fresh one for the copy.
  const res = await fetch(`/api/sign/${encodeURIComponent(token)}/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return alert('This link is no longer active. Ask the sender for a copy.');
  window.location.href =
    `/api/sign/${encodeURIComponent(token)}/file?ticket=${encodeURIComponent(data.ticket)}`;
});

open();
