# DomainHunt Pro

A dead-simple desktop app for domain buyer/lead research — built in the spirit of
tools like freevideocompressor.com: **one box, one button, instant results.**

Type a domain (or a bare brand name) and DomainHunt Pro scans the public domain
registries and shows you **who is connected to that name**:

- **Companies & individuals** who already own the domain or its look-alikes across
  ~25 TLDs (`.com`, `.io`, `.co`, `.ai`, `.app`, `.store`, `.agency`, `.company`, …)
- **Contact emails** for each owner (pulled from registry records; when a registry
  redacts them under GDPR, a role-based outreach list — `info@`, `owner@`,
  `domains@`, … — is generated so you always have a way in)
- **Available variants** flagged as acquisition targets
- **Registrar, status and dates** for every match

These are the real parties with an interest in the name — the people to email if you
want to buy the domain, and the brands to know if you own one they might want.

## How it works

DomainHunt Pro uses **RDAP** (Registration Data Access Protocol), the official,
free, no-API-key successor to WHOIS. There is nothing to sign up for and no key to
paste — it just works.

## Features

- 🔎 **One-box search** — a domain or a keyword is all it takes
- 📋 **Contact list** — clickable `mailto:` links for every lead
- 📥 **Import** — feed it a CSV / TXT / JSON list of domains and it hunts them all
- 📤 **Export** — save results to CSV or JSON for your CRM / outreach tool
- ⚡ **Fast** — TLDs are scanned in parallel with a live progress bar
- 🖥️ **Desktop** — Windows, macOS and Linux (Electron)
- 🗂️ **Portfolio Leads mode** — got a big list of domains to sell? Import the
  whole portfolio (hundreds or thousands) on the **Portfolio Leads** tab. It
  scans look-alikes for every domain and merges everyone it finds — owners,
  brands, contact emails — into one deduped, scored outreach list, ranked by
  who's most likely to be a buyer (real contact email, interested in
  multiple of your domains). Choose a **Quick scan** (8 TLDs, fast) or
  **Full scan** (25 TLDs, thorough) depending on portfolio size, and cancel
  mid-run any time — leads found so far are kept and exportable.
- 🏷️ **Trademark-owner leads (US trademarks)** — paste a RapidAPI key in the
  Portfolio Leads tab and every scan also matches your domain names against
  the US trademark register. Registered-brand owners (often the highest-intent
  buyers) are merged into the same ranked lead list, tagged **Trademark** vs
  **Domain** so you know where each lead came from. The key is validated with a
  **Test connection** button and stored locally; trademark lookups are
  best-effort and never block a scan.

## US trademark API key (optional)

Trademark-owner leads use the **USPTO Trademark API on RapidAPI**. Signup is
just an email — **no US identity verification** — so it works from any country:

1. Go to **[rapidapi.com/pentium10/api/uspto-trademark](https://rapidapi.com/pentium10/api/uspto-trademark)**
   and sign up (Google/GitHub/email).
2. **Subscribe** to the API (there is a free tier) — this activates your key.
3. Copy your **RapidAPI key** (the `X-RapidAPI-Key` value shown in the code
   snippets).
4. In DomainHunt Pro, open the **Portfolio Leads** tab, paste the key, click
   **Test connection**, then **Save**.

The key is stored locally in the app's user-data folder and sent only to
RapidAPI over HTTPS. Leave it blank to run RDAP-only scans. Because free tiers
are rate-limited, very large portfolios may need a paid RapidAPI plan or a
smaller batch per run.

## Run it

```bash
npm install      # downloads Electron (needs normal internet access)
npm start        # launches the app
```

## Build installers

```bash
npm run dist     # produces a .exe (Windows), .dmg (macOS) or .AppImage (Linux)
```

Output lands in `dist/`.

## Import file formats

- **CSV / TXT** — one domain per line (a `domain` header row is auto-detected)
- **JSON** — an array of strings, or an array of `{ "domain": "..." }` objects

A ready-made `sample-domains.csv` is included to try the Import button.

## Project layout

| File | Purpose |
|------|---------|
| `main.js` | Electron main process, window + import/export file dialogs |
| `preload.js` | Secure bridge between UI and Node (context-isolated) |
| `lookup.js` | RDAP hunt engine — TLD scan, contact extraction |
| `renderer/` | The UI (HTML/CSS/JS) |

## Note on results

Registry data varies by TLD and registrar. Many registries redact personal
contact details under privacy law; in those cases DomainHunt Pro shows the
owning organization plus a generated role-based outreach list. Availability
reflects registry status at lookup time.
