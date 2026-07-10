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
