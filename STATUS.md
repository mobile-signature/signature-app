# Mobile Signature — current state

Living summary. Update it as things change.

Last updated: 23 July 2026

---

## The app

| | |
| --- | --- |
| **Live URL** | <https://signature-app-n7vs.onrender.com> |
| **Hosting** | Render, free plan, auto-deploys on push to `main` |
| **Code** | <https://github.com/mobile-signature/signature-app> (**public**, since 23 July) |
| **Local folder** | `C:\Users\Ihab\Desktop\Mobile Signature` |
| **Open it** | `start.cmd`, or the `Start Mobile Signature` shortcut |

Same URL for phones and computers. Add to Home Screen on a phone, or Install
from Chrome/Edge on a desktop, and it behaves like an installed app.

---

## Keys and passwords

Nothing is hard-coded that matters. All of it lives in Render →
your service → **Environment**.

| Name | What it is |
| --- | --- |
| `API_KEY` | Administrator key. Activates any device, mints licence keys. |
| `STAFF_PASSWORD` | Guards Licences and Deactivate. **The repo is public and the code's hardcoded fallback value is visible in it — set this explicitly on Render and don't rely on the default.** |
| `PUBLIC_URL` | `https://signature-app-n7vs.onrender.com` — signing links are built from this. **Wrong value = every link you send is dead.** |
| `LICENSE_SECRET` | Optional. Signs licence keys; falls back to `API_KEY`. Changing it invalidates every issued key. |
| `REVOKED_LICENSES` | Optional. Comma-separated serials, for revocations that must survive a restart. |
| `LINK_TTL_HOURS` | `168` (7 days) before a signing link expires. |

---

## How people use it

**Sending** — open the app, pick a PDF/photo/screenshot, name the recipient,
optionally set an access code, create the link, share it. Images become a
one-page PDF automatically.

**Signing** — the recipient taps the link, enters the access code if set, taps
Sign, draws with a finger, ticks consent, submits. They install nothing.

**Activating a device** — first visit asks for a licence key, once. Issue keys
at `/admin` (needs the staff password, then the admin key). One key per person
so you can revoke one without touching the others; revoking takes effect on
the next request.

---

## Known limits

- **Free plan has no persistent disk.** Uploaded and signed documents are
  erased on every restart, redeploy and wake-from-sleep. Fine for testing;
  not safe for real client documents. Fix: Render Starter (~$7/mo) plus the
  `disk:` block in `render.yaml`, and set `DATA_DIR=/var/data`.
- **Free instances sleep** after ~15 min idle; the next visit takes ~50 s.
  Mitigated since 23 July by a GitHub Actions ping every 10 minutes
  (`.github/workflows/keepalive.yml`) — should mostly prevent this now, but
  is a workaround, not a guarantee. GitHub can delay scheduled workflows
  under load, and disables them automatically after 60 days with no repo
  activity.
- **Simple electronic signatures** — a stamped image plus an audit trail
  (time, name, IP, source-file hash). Not PKI/eIDAS-qualified.
- **Documents are stored unencrypted** on the server disk.
- **Anyone with the link and code can sign** — no identity verification.
- **Typed text fields are Latin-only.** Drawn signatures work in any script.
  See README, *Non-Latin text*, to embed a Unicode font.
- **The document title is visible in link previews** before any access code.
  Keep titles non-sensitive.
- **The `onrender.com` line in WhatsApp previews cannot be removed** — it comes
  from the URL. A custom domain is the only way to change it.
- **The repo is public.** Anyone can read the full source, including the
  gate.js fallback logic and this file. No `.env`, API keys, or licence
  secrets are in it — those only ever exist in Render's Environment tab —
  but don't add anything sensitive to the codebase now without remembering
  that it's world-readable.

---

## Two traps that already caused trouble

**Running a local copy by mistake.** `dev-local-server.cmd` and `setup.cmd`
start a copy on this PC whose links begin with `localhost` and are dead for
everyone else. That copy shows a red *LOCAL TEST COPY* bar. If you see it,
close it and use `start.cmd`.

**Stale service worker.** The app caches itself. It is network-first now, so
updates arrive on their own — but a device that installed the app during the
cache-first period may be stuck on an old version. Fix: delete the home-screen
icon, reopen the link, re-add it.

---

## Working on the code

```powershell
cd "C:\Users\Ihab\Desktop\Mobile Signature"
npm.cmd install          # note: npm.cmd, not npm, on Windows PowerShell
```

Test locally with `dev-local-server.cmd`. Push to `main` and Render deploys in
about a minute.

Rollback point: `git tag START-STEP` marks the state before the 22 July work.

---

## Built on 22 July 2026

- Per-device licence activation, admin page at `/admin`
- Staff password on Licences and Deactivate
- Document title in shared link previews (no image, no description)
- Consent box made a large tap target; error clears when ticked
- Signature draws a solid line (was dashed)
- Header reads *SAKA Trading Co. SAL*

## Built on 23 July 2026

- SAKA logo in the header and in shared link previews, sized to match the title
- Link previews show **Pending signature** / **Signed** as a separate status
  line, without lengthening the title itself
- Repo made **public** so GitHub Actions keep-alive pings run free of charge;
  a private repo at this ping frequency would exceed GitHub's free minutes
  within about two weeks
- Added `.github/workflows/keepalive.yml` — pings `/healthz` every 10 minutes
  so the app stays awake and link-preview crawlers stop hitting a sleeping
  instance
