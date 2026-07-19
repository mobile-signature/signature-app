# Putting this in front of real people

Three ways to reach recipients, in order of seriousness.

| | `setup.cmd` (tunnel) | Render **free** | Render **starter** (~$7/mo) |
| --- | --- | --- | --- |
| Reachable worldwide | Yes | Yes | Yes |
| URL survives a restart | **No** | Yes | Yes |
| Works with your PC off | **No** | Yes | Yes |
| Documents survive a restart | Yes (local disk) | **No** | Yes |
| First load speed | Instant | ~30s if asleep | Instant |
| Good for | Testing on your phone | Testing with others | Real clients |

---

## Option 1 — Phone testing today (`setup.cmd`)

Double-click **`setup.cmd`**. Say yes when it offers to install cloudflared.
You get a link like `https://tender-moon-abc123.trycloudflare.com` and a QR code.

Scan it, then Add to Home Screen. Anyone in the world can open the signing links
you generate — **while the black window stays open**.

Close the window and every link you sent stops working, permanently. The next
run gives a different URL. Do not send these links to a client.

---

## Option 2 — Deploy to Render

### Step 1: Put the code on GitHub

```powershell
cd "C:\Users\Ihab\Desktop\Mobile Signature"
git init
git add .
git commit -m "Mobile Signature"
```

Create an empty repo at <https://github.com/new> (private is fine), then:

```powershell
git remote add origin https://github.com/YOUR-USERNAME/mobile-signature.git
git branch -M main
git push -u origin main
```

`.gitignore` already excludes `.env`, `data/` and `node_modules/`, so your API
key and uploaded documents are not published.

### Step 2: Create the service

1. Sign up at <https://render.com> (free, GitHub login)
2. **New → Blueprint** → select your repo → Apply
3. Render reads `render.yaml` and builds. First build takes ~2 minutes.

### Step 3: Tell it its own address

This step is mandatory — signing links are built from `PUBLIC_URL`, and if it is
wrong every link you send points somewhere useless.

1. Copy the URL Render assigned, e.g. `https://mobile-signature.onrender.com`
2. Dashboard → your service → **Environment**
3. Set `PUBLIC_URL` to that exact URL (no trailing slash)
4. **Manual Deploy → Deploy latest commit**

### Step 4: Get your API key

Dashboard → **Environment** → reveal the generated `API_KEY`. Open your Render
URL on your phone, paste the key, Add to Home Screen. Done.

### Step 5: Before real documents — attach a disk

On the free plan your documents live in memory that Render wipes on every
restart, redeploy, and wake-from-sleep. A client who opens a link the next
morning may find nothing there.

In `render.yaml`: change `plan: free` to `plan: starter`, uncomment the `disk:`
block, commit, push. Render redeploys with storage that persists.

---

## Before you send anything legally binding

- **Set an access code** on important documents and share it by a different
  channel than the link (text the link, phone them the code).
- **The signature is a "simple electronic signature"** — a stamped image plus an
  audit trail of time, name, IP, and a hash of the original file. That satisfies
  ESIGN and eIDAS *simple* tier. It is not a qualified/PKI signature.
- **Documents are stored unencrypted** on the server disk. Anyone with access to
  that disk or the Render dashboard can read them.
- **Anyone with the link and code can sign** — there is no identity check.
- Have a lawyer confirm this meets requirements in your jurisdiction before
  relying on it for anything consequential.
