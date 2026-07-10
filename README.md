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

DomainHunt Pro runs a **multi-source contact-discovery engine**. RDAP registry
data is only the starting point — most registries redact contacts under GDPR, so
a registry-only lookup returns almost nothing. With **Deep enrichment** enabled
(on by default) each registered domain is fanned out across many *public*
sources and every contact is merged, de-duplicated and confidence-scored:

| Source | What it finds |
|--------|---------------|
| **Website crawl** | Homepage + `/contact`, `/about`, `/team`, `/careers`, `/imprint`, `/legal`, … scraped for emails (including `[at]/[dot]` obfuscation and Cloudflare-protected addresses), phone numbers and social profile links |
| **Certificate transparency** (crt.sh) | Enumerates subdomains (`mail.`, `careers.`, `support.`, …) — each one another crawl surface |
| **DNS (MX / TXT)** | Mail infrastructure and platform fingerprints (Google Workspace, Microsoft 365, HubSpot, Salesforce, Mailchimp, …) from verification tokens |
| **Social handles** | LinkedIn, X/Twitter, Facebook, Instagram, YouTube, GitHub profiles as direct outreach channels |
| **RDAP registry** | Registrant org and any exposed contact emails |
| **Email-pattern synthesis** | Once a real person's name is found, common corporate patterns (`first.last@`, `f.last@`, `first@`, …) are generated as candidate addresses |
| **Paid providers** *(optional)* | Hunter.io, Apollo, Clearbit — auto-activate when their API key is set (see below) |

Everything the engine reads is what a browser visiting the public site would
see. It does **not** log in, bypass authentication, or scrape behind paywalls or
social-network logins.

### Optional paid enrichment providers

Set any of these environment variables before launching and the matching
provider is queried automatically, adding verified business emails on top of the
free sources:

```bash
export HUNTER_API_KEY=...     # Hunter.io domain search (wired up)
export APOLLO_API_KEY=...     # Apollo people search (stub — add your query)
export CLEARBIT_API_KEY=...   # Clearbit Prospector (stub — add your query)
```

### A note on volume

Yield depends entirely on the target's public footprint. A large company with a
staff directory, many subdomains and active social presence can produce
hundreds of contacts; a parked domain or a privacy-locked one-pager may produce
only a handful of role-based addresses. There is no honest way to manufacture
thousands of real, reachable contacts for a domain that simply does not have
them — the engine surfaces everything that genuinely exists and clearly marks
synthesized/candidate addresses with a lower confidence score so you can filter.

## Features

- 🔎 **One-box search** — a domain or a keyword is all it takes
- 🕸️ **Deep enrichment** — crawls the site, subdomains, DNS and socials for every contact
- 📋 **Unified contact list** — emails, phones and social channels, each tagged with source + confidence, expandable per domain
- 📥 **Import** — feed it a CSV / TXT / JSON list of domains and it hunts them all
- 📤 **Export** — **Export Contacts** (one row per lead, CRM-ready), plus full CSV / JSON
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
| `lookup.js` | RDAP hunt engine — TLD scan, orchestrates enrichment |
| `enrich.js` | Multi-source contact-discovery engine (crawl, crt.sh, DNS, socials, patterns, providers) |
| `renderer/` | The UI (HTML/CSS/JS) |

## Note on results

Registry data varies by TLD and registrar. Many registries redact personal
contact details under privacy law; in those cases DomainHunt Pro shows the
owning organization plus a generated role-based outreach list. Availability
reflects registry status at lookup time.
