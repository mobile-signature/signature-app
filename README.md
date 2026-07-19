# Mobile Signature

Upload a **PDF, photo, or screenshot** from your phone, send a secure link, and
let the recipient sign or edit it in their mobile browser. No installs on the
recipient side.

---

## Quick start — one click

**Just this computer:** double-click **`start.cmd`**. Runs locally, nothing is
exposed to the internet, no tunnel installed. Best for trying it out first.

**On your phone:** double-click **`setup.cmd`**.

It checks for Node.js and installs it if missing, installs the app's packages,
creates your configuration, starts the server, opens a public HTTPS tunnel so
your phone can reach it, and opens a page with a **QR code to scan**.

Windows will ask permission during the Node.js install — that prompt is the
installer, and it is the only elevation the setup needs. Everything else runs as
your normal user.

Leave the window open while you use the app; closing it shuts everything down.

> **Why a script and not an installer?** The parts that need installing are
> developer tools (Node, a tunnel client). Once deployed to a server (see
> *Deploying*), none of this is needed — you just visit a URL.

---

## The distribution reality (read this first)

You asked for a standalone app installable via a direct link on both iOS and
Android. Here is what is actually possible:

| Path | Android | iOS | Notes |
| --- | --- | --- | --- |
| **PWA** (this repo's default) | ✅ Direct link → "Add to Home Screen" | ✅ Direct link → Share → "Add to Home Screen" | Real home-screen icon, standalone window, no store, no review. **This is the only true install-from-link option on iOS.** |
| **`.apk` direct download** | ✅ Works | ❌ Impossible | Included via the Expo wrapper. |
| **App Store / TestFlight** | ✅ | ✅ | Apple requires this for native apps. TestFlight is still a link, but testers need the TestFlight app first. |

Apple does not allow sideloading signed native apps outside the store (except
enterprise/ad-hoc provisioning, which needs a paid programme and device UDIDs).
So the architecture here is **PWA-first**, with an optional Expo/React Native
wrapper in `mobile/` for when you want store presence.

The recipient never installs anything either way — they get a plain HTTPS URL.

---

## Architecture

```
┌─────────────────┐         ┌──────────────────────────────┐
│  Sender (PWA)   │         │  Node + Express server       │
│  web/index.html │──POST──▶│  /api/documents              │
│  installable    │         │    multer → data/uploads     │
└─────────────────┘         │    pdf-lib → page count      │
        │                   │    db.json → record + token  │
        │ signUrl           └──────────────┬───────────────┘
        ▼                                  │
   share sheet / SMS / email               │
        │                                  │
        ▼                                  ▼
┌────────────────────────────┐   ┌──────────────────────────┐
│ Recipient's mobile browser │   │ POST /api/sign/:t/open   │
│ web/sign.html + sign.js    │──▶│   access code → ticket   │
│  · pdf.js renders pages    │   │ GET  /api/sign/:t/file   │
│  · tap to place fields     │   │   streams PDF (ticket)   │
│  · canvas signature pad    │   │ POST /api/sign/:t/complete│
│  · drag / resize / delete  │──▶│   pdf-lib stamps + audit │
└────────────────────────────┘   └──────────────────────────┘
```

### Files

```
start.cmd                 run on this computer only (no tunnel)
setup.cmd / setup.ps1     one-click installer + launcher (with tunnel)
package.json              server deps + scripts
.env.example              copy to .env
server/src/
  index.js                express app, QR endpoint, /s/:token and /setup routes
  config.js               env, paths, first-boot API key generation
  db.js                   atomic JSON store (no native modules)
  tickets.js              short-lived capability tokens
  convert.js              images -> single-page PDF, magic-byte sniffing
  pdf.js                  coordinate conversion + pdf-lib stamping
  routes/documents.js     sender API + recipient signing API
web/
  index.html app.js       sender PWA (file picker, camera, QR)
  sign.html  sign.js      recipient signing page
  setup.html              localhost-only setup page with QR code
  styles.css              shared, light + dark
  manifest.webmanifest sw.js icon.svg icon-*.png
mobile/                   optional Expo wrapper (WebView shell)
```

### Signing photos and screenshots

Anything that is not a PDF becomes a **one-page PDF at upload time**, so the
renderer, field placement, stamping and audit trail never need a second code
path.

The conversion happens in two stages:

1. **In the browser** (`web/app.js`) the image is decoded to a canvas and
   re-encoded as JPEG. This is what makes **iPhone HEIC photos work** — Safari
   decodes HEIC natively, so what leaves the phone is already a JPEG. It also
   applies the EXIF rotation (`imageOrientation: 'from-image'`), so a photo shot
   sideways is upright in the document, and downscales anything over 2400px.
2. **On the server** (`server/src/convert.js`) the bytes are sniffed for their
   real format — the filename and Content-Type are not trusted — and wrapped in
   a page that preserves the aspect ratio. Portrait images take A4's width,
   landscape images take A4's height as their width, so a wide screenshot is not
   squeezed into a sliver.

Accepted: **PDF, JPEG, PNG**, plus anything else your browser can decode (HEIC,
WebP, GIF) since those are converted before upload. A **Take a photo** button
uses `capture="environment"` to open the camera directly for paper documents.

### Design decisions worth knowing

- **Field coordinates are normalised 0–1 with a top-left origin.** That is how
  the browser overlay measures them. `server/src/pdf.js` flips to pdf-lib's
  bottom-left origin in exactly one place, so the phone's screen size and zoom
  level never affect where the signature lands.
- **The access code never travels in a URL.** It is POSTed, exchanged for a
  30-minute ticket, and the ticket is what fetches the PDF.
- **The service worker deliberately does not cache `/api/` or `/s/`.** A cached
  signing page or a stale PDF would be a security bug, not a speed win.
- **Storage is a JSON file** so `npm install` never needs a C++ toolchain on
  Windows. It is fine to a few thousand documents. Past that, swap `db.js` for
  Postgres — the interface is six functions.
- **The setup page is loopback-only.** It displays the API key, so it refuses
  any request carrying forwarding headers. This matters because a tunnel client
  runs on your own machine — its traffic looks like localhost at the socket
  level, and only the `X-Forwarded-For` header distinguishes it from your
  browser.

---

## Running it locally

### 1. Install Node.js 20+

```powershell
winget install OpenJS.NodeJS.LTS
```

…or download from <https://nodejs.org>. **Close and reopen your terminal
afterwards** so `node` lands on your PATH.

### 2. Install dependencies

```powershell
cd "C:\Users\Ihab\Desktop\Mobile Signature"
npm.cmd install
```

> **Windows note — use `npm.cmd`, not `npm`.** PowerShell's default execution
> policy blocks `npm.ps1` and you get
> *"running scripts is disabled on this system"*. Adding `.cmd` runs npm's batch
> version instead and needs no security changes. This applies to every npm
> command: `npm.cmd install`, `npm.cmd start`.

### 3. Configure

```powershell
Copy-Item .env.example .env
```

Leave `API_KEY` blank on the first run — the server generates one, prints it,
and saves it to `data/api-key.txt`.

### 4. Start

```powershell
npm.cmd start
```

Open <http://localhost:3000>, paste the printed API key, and send a test PDF.

### 5. Test from a real phone

Signing links must be HTTPS for the camera/clipboard/service-worker APIs and for
"Add to Home Screen" to work. Use a tunnel:

```powershell
npx ngrok http 3000
```

Then set `PUBLIC_URL` in `.env` to the `https://…ngrok-free.app` URL it prints
and restart. Every link generated from then on will be reachable from any phone.

---

## Deploying

### Render (simplest)

1. Push this folder to a GitHub repo.
2. New → Web Service → connect the repo.
3. Build: `npm install` · Start: `npm start`
4. Environment: `PUBLIC_URL=https://your-app.onrender.com`, `API_KEY=<a long random string>`
5. Add a **persistent disk** mounted at `/data` and set `DATA_DIR=/data`.
   Without this, uploaded PDFs vanish on every redeploy.

### Fly.io / Railway / a VPS

Same three things matter everywhere:

- `PUBLIC_URL` must be the real HTTPS origin.
- `DATA_DIR` must point at storage that survives restarts.
- `API_KEY` must be set explicitly in production.

Behind nginx, make sure `X-Forwarded-For` is passed through — `app.set('trust
proxy', true)` relies on it for the audit trail's IP.

### Installing the PWA

Send anyone the root URL.

- **Android/Chrome** — an "Install app" prompt appears, or Menu → Add to Home screen.
- **iOS/Safari** — Share → Add to Home Screen. (Safari only; Chrome on iOS
  cannot install PWAs.)

### Building the native app (optional)

```powershell
cd mobile
npm install
# set expo.extra.serverUrl in app.json to your deployed HTTPS URL first
npx eas-cli build --platform android --profile preview   # → downloadable .apk link
npx eas-cli build --platform ios --profile preview       # → TestFlight / ad-hoc
```

---

## API

All sender routes need `Authorization: Bearer <API_KEY>`.

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/documents` | multipart upload — PDF, JPEG or PNG (`file`, `title`, `signerName`, `signerEmail`, `accessCode`) → returns `signUrl` |
| GET | `/api/documents` | list |
| GET | `/api/documents/:id` | detail + audit events |
| GET | `/api/documents/:id/download` | signed PDF if present, else original |
| POST | `/api/documents/:id/revoke` | kill the link immediately |
| POST | `/api/sign/:token/open` | `{code}` → `{ticket, title, pageCount}` |
| GET | `/api/sign/:token/file?ticket=` | stream the PDF |
| POST | `/api/sign/:token/complete` | `{ticket, signerName, consent, fields[]}` → stamps |
| GET | `/api/qr?text=` | SVG QR code; restricted to this server's own URLs |
| GET | `/api/setup-info` | public URL + API key — **loopback only** |

---

## Non-Latin text (Arabic, etc.)

The typed **Text** and **Date** fields use pdf-lib's built-in Helvetica, which is
WinAnsi-encoded — Latin characters only. Typing Arabic into a text field returns
a clear error rather than a crash. Drawn signatures are images, so **signing in
any script works fine**; only *typed* fields are affected.

To support Arabic text fields, embed a Unicode font:

```powershell
npm.cmd install @pdf-lib/fontkit
```

Download a TTF with Arabic coverage (e.g. Noto Sans Arabic), drop it in
`server/assets/`, then in `server/src/pdf.js`:

```js
import fontkit from '@pdf-lib/fontkit';
pdf.registerFontkit(fontkit);
const font = await pdf.embedFont(await fs.readFile('server/assets/NotoSansArabic.ttf'), { subset: true });
```

Then delete the `unencodableChars` guard in `validateFields`. Note that pdf-lib
does not do bidirectional reordering or Arabic glyph shaping — for
production-quality Arabic you will want a shaping step first.

---

## What has been tested

Verified on this machine (Node 24.18, Windows 11) — 40 automated checks:

**Documents**
- Upload → link generation → access-code gate → signing → stamped download
- Auth rejection on bad API key; wrong/missing access code; bogus ticket
- Server-side field validation (out-of-range page rejected)
- Double-signing blocked (409); audit trail records created/opened/signed
- Stamped output re-opens cleanly, keeps its page count, and every field lands
  at the requested coordinate (checked by extracting text positions)

**Images**
- PNG screenshot → one-page PDF, aspect ratio preserved (595×893pt)
- Landscape image stays landscape (842×351pt), not squeezed
- A PNG renamed `.pdf` is still handled correctly (magic-byte sniffing)
- Corrupt image, text-file-as-PNG and executables all rejected with 400
- Converted screenshot signs successfully; output contains the screenshot,
  the signature image, the check strokes and the audit footer
- Browser-side conversion verified live: PNG → JPEG, title auto-filled,
  full upload → link → QR flow driven through the real UI

**Setup**
- `setup.ps1` parses clean; `.env` rewrite handles both an existing
  `PUBLIC_URL` line and a missing one; tunnel URL regex matches real output
- `/api/setup-info` returns data on loopback, 403 when forwarded
- `/api/qr` refuses URLs outside this server

**Not tested on a physical phone** — touch drag/resize of placed fields, pdf.js
rendering on real mobile Safari/Chrome, the camera capture button, and HEIC
decoding (needs a real iPhone). `setup.cmd` has not been run end-to-end, since
that installs cloudflared and opens a public tunnel.

---

## Security posture

Implemented:

- Unguessable 32-char link tokens, separate from the document ID
- Optional access code, SHA-256 hashed, timing-safe compared, 8 attempts per 15 min
- Link expiry (`LINK_TTL_HOURS`) and manual revoke
- Short-lived tickets keep codes out of URLs and referrers
- Signed documents are immutable — a second signing attempt is rejected
- Audit footer stamped on the last page: timestamp, signer, IP, source hash
- Server-side field validation; a malicious client cannot draw outside the page
- `no-store` on PDF responses, `noindex` on signing pages
- Uploads identified by magic bytes, not filename or Content-Type; anything not
  a real PDF/JPEG/PNG is refused
- Setup page and API key endpoint refuse any request arriving through a tunnel
- The QR endpoint only encodes this server's own URLs, so it cannot be abused
  to generate QR codes pointing at someone else's site

Deliberately **not** implemented — decide whether you need them:

- **Cryptographic PKI signatures.** This applies a visible signature image plus
  an audit trail, which satisfies ESIGN/eIDAS *simple* electronic signatures.
  Qualified signatures (eIDAS QES) need a certificate authority.
- **Encryption at rest.** PDFs sit unencrypted in `DATA_DIR`. Use an encrypted
  volume, or encrypt in `pdf.js` before writing.
- **Identity verification.** Anyone with the link and code can sign. Add SMS OTP
  or ID checks if the documents warrant it.
- **Rate limiting on upload.** Add `express-rate-limit` if the API key is ever
  shared beyond a small team.
- **Multi-signer / sequential routing.** The schema supports one signer per
  document today.

Before using this for anything legally consequential, have counsel confirm it
meets the requirements in your jurisdiction.
