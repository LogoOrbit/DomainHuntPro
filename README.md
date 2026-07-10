# DomainHunt Pro

**An AI-powered premium domain brokerage tool with one mission: find the companies
most likely to BUY the domains you already own.**

This is not a domain search engine, not a registrar, and it never suggests domains
to purchase. You enter a premium domain **you own** (e.g. `swiftpay.com`) and
DomainHunt Pro scans public registries for real businesses operating on weaker
look-alike domains — `swiftpay.io`, `getswiftpay.com`, `swift-pay.net`,
`swiftpayonline.com`, and dozens more — the companies whose brand would be
significantly improved by owning your domain.

For every prospect it produces:

| Output | Detail |
|--------|--------|
| **Company** | The business behind the look-alike domain (registrant org from RDAP) |
| **Contact** | Best available email first — registry-verified registrant emails, then guessed decision-maker mailboxes (`ceo@`, `founder@`, `owner@`), then generic inboxes last. Each is labeled **Verified / Likely Valid / Unknown** |
| **Prospect score** | 0–100 with a tier (Perfect / Excellent / Good / Possible Buyer) and the exact reasons behind the score |
| **AI recommendation** | A short explanation of why buying your domain helps this specific company |
| **Outreach** | A personalized cold email, LinkedIn message, and two follow-ups, referencing their company, their current domain, and yours |

## How prospects are found

For your domain's brand name, the engine generates the look-alike patterns real
businesses register when the premium name is taken:

- The same name across ~19 commercial TLDs (`.io`, `.co`, `.net`, `.ai`, `.app`, …)
- Prefix variants: `get…`, `my…`, `the…`, `best…`, `try…`, `use…`
- Suffix variants: `…online`, `…group`, `…world`, `…sales`, `…hq`, `…global`, `…solutions`, …
- Hyphenated variants

Every candidate is checked via **RDAP** (the official, free, no-API-key successor
to WHOIS). Only **registered** domains — actual operating businesses — become
prospects. Available domains are irrelevant to selling and are never shown.

## Guiding principle

> "Does this help the user sell a domain they already own?" If no, it's not in the app.

Success is measured in qualified buyer companies, verified decision-maker contacts,
and ready-to-send outreach — not in domains found.

## Run it

```bash
npm install      # downloads Electron (needs normal internet access)
npm start        # launches the app
```

## Build installers

```bash
npm run dist     # produces a .exe (Windows), .dmg (macOS) or .AppImage (Linux)
```

## Bulk processing

Import a CSV / TXT / JSON list of domains you own and the app hunts buyers for
all of them, deduplicates, and ranks the combined prospect list by score.
Export everything — company, contacts, scores, reasoning, and all four outreach
messages per lead — to CSV or JSON for your CRM or outreach tool
(HubSpot, Apollo, Instantly, Smartlead, Lemlist, etc. all import CSV).

- **CSV / TXT** — one domain per line (a `domain` header row is auto-detected)
- **JSON** — an array of strings, or an array of `{ "domain": "..." }` objects

A ready-made `sample-domains.csv` is included.

## Project layout

| File | Purpose |
|------|---------|
| `main.js` | Electron main process, window + import/export file dialogs |
| `preload.js` | Secure bridge between UI and Node (context-isolated) |
| `lookup.js` | Buyer-hunt engine — variant generation, RDAP lookups, scoring, outreach |
| `renderer/` | The UI (HTML/CSS/JS) |

## Note on contact data

Many registries redact registrant details under privacy law. When a direct email
is exposed in the registry record it is labeled **Verified**; when redacted, the
app generates decision-maker mailboxes on the company's own domain (**Likely
Valid**) and generic inboxes (**Unknown**) so you always have an outreach path —
with decision-makers always prioritized over `info@`-style inboxes.
