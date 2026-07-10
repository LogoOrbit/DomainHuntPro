'use strict';

// DomainHunt Pro — core lookup engine.
// Uses RDAP (Registration Data Access Protocol), the official, free,
// no-API-key registry protocol, to find real registrant orgs and contact
// emails for a domain name and its look-alikes across many TLDs.

const https = require('https');
const { enrichDomain } = require('./enrich');

// TLDs we scan for look-alike / related registrations. Ordered by how
// commonly a brand would care about them.
const SCAN_TLDS = [
  'com', 'net', 'org', 'io', 'co', 'ai', 'app', 'dev', 'me', 'info',
  'biz', 'us', 'xyz', 'online', 'store', 'tech', 'agency', 'company',
  'inc', 'llc', 'brand', 'shop', 'site', 'live', 'pro'
];

// Common role-based mailboxes to build an outreach list from when a related
// domain resolves to a brand but exposes no direct contact address.
const OUTREACH_PREFIXES = ['info', 'admin', 'contact', 'hello', 'sales', 'owner', 'domains'];

function httpsGetJson(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'Accept': 'application/rdap+json, application/json', 'User-Agent': 'DomainHuntPro/1.0' },
      timeout: 12000
    }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location && redirectsLeft > 0) {
        res.resume();
        const next = headers.location.startsWith('http') ? headers.location : new URL(headers.location, url).href;
        return resolve(httpsGetJson(next, redirectsLeft - 1));
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (statusCode === 404) return resolve({ __notFound: true });
        if (statusCode >= 400) return resolve({ __error: statusCode });
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ __error: 'parse' }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ __error: 'timeout' }); });
    req.on('error', () => resolve({ __error: 'network' }));
  });
}

// Parse a jCard (vCard in RDAP) array into readable fields.
function parseVcard(vcardArray) {
  const out = { name: '', org: '', email: '', kind: '' };
  if (!Array.isArray(vcardArray) || vcardArray[0] !== 'vcard') return out;
  for (const entry of vcardArray[1] || []) {
    if (!Array.isArray(entry)) continue;
    const [field, , , value] = entry;
    if (field === 'fn' && value) out.name = String(value);
    if (field === 'org' && value) out.org = Array.isArray(value) ? value.join(' ') : String(value);
    if (field === 'email' && value) out.email = String(value);
    if (field === 'kind' && value) out.kind = String(value);
  }
  return out;
}

function extractEntities(rdap) {
  const results = [];
  const walk = (entities) => {
    if (!Array.isArray(entities)) return;
    for (const ent of entities) {
      const roles = ent.roles || [];
      const card = parseVcard(ent.vcardArray);
      if (card.name || card.org || card.email) {
        results.push({ roles: roles.join(', '), ...card });
      }
      if (ent.entities) walk(ent.entities);
    }
  };
  walk(rdap.entities);
  return results;
}

// Look up a single fully-qualified domain via rdap.org (which routes to the
// authoritative registry). Returns a normalized record.
async function lookupOne(fqdn, opts = {}) {
  const rdap = await httpsGetJson(`https://rdap.org/domain/${encodeURIComponent(fqdn)}`);

  if (rdap.__notFound) {
    return { domain: fqdn, status: 'available', registered: false, note: 'Not registered — acquisition target', contacts: [] };
  }
  if (rdap.__error) {
    return { domain: fqdn, status: 'unknown', registered: null, note: `Lookup failed (${rdap.__error})`, contacts: [] };
  }

  const entities = extractEntities(rdap);
  const emails = [...new Set(entities.map((e) => e.email).filter(Boolean))];
  const orgs = [...new Set(entities.map((e) => e.org || e.name).filter(Boolean))];
  const events = (rdap.events || []).reduce((m, ev) => {
    if (ev.eventAction && ev.eventDate) m[ev.eventAction] = ev.eventDate;
    return m;
  }, {});

  let registrar = '';
  const reg = entities.find((e) => /registrar/i.test(e.roles));
  if (reg) registrar = reg.org || reg.name;

  // If the registry redacts contacts (common due to GDPR), synthesize an
  // outreach list from role-based mailboxes on the domain itself.
  let outreach = emails.slice();
  if (outreach.length === 0 && orgs.length) {
    outreach = OUTREACH_PREFIXES.map((p) => `${p}@${fqdn}`);
  }

  const record = {
    domain: fqdn,
    status: (rdap.status || []).join(', ') || 'registered',
    registered: true,
    owner: orgs[0] || '(redacted)',
    allOrgs: orgs,
    emails,
    outreach,
    registrar,
    created: events.registration || '',
    updated: events.lastChanged || events['last changed'] || '',
    expires: events.expiration || '',
    contacts: [],
    sources: ['rdap'],
    meta: {}
  };

  // Seed the unified contact list with what RDAP gave us.
  for (const e of emails) {
    record.contacts.push({ type: 'email', value: e, name: '', title: '', channel: '', source: 'rdap', confidence: 0.95 });
  }

  // Deep enrichment: crawl the site, enumerate subdomains, read DNS, pull
  // socials and (optionally) paid providers. This is where the bulk of the
  // contacts come from — RDAP is just the starting point.
  if (opts.enrich) {
    try {
      const enr = await enrichDomain(fqdn, opts.onStep || (() => {}));
      const seen = new Set(record.contacts.map((c) => c.type + '|' + String(c.value).toLowerCase()));
      for (const c of enr.contacts) {
        const key = c.type + '|' + String(c.value).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        record.contacts.push(c);
      }
      // Merge freshly discovered emails into the legacy fields too.
      const enrichedEmails = enr.contacts.filter((c) => c.type === 'email').map((c) => c.value);
      record.emails = [...new Set([...record.emails, ...enrichedEmails])];
      record.meta = enr.meta;
      record.sources = [...new Set([...record.sources, ...enr.sources])];
      if (!record.owner || record.owner === '(redacted)') {
        if (enr.meta && enr.meta.title) record.owner = enr.meta.title;
      }
    } catch (_) { /* enrichment best-effort */ }
  }

  return record;
}

// Given a user query (a domain or a bare keyword), scan the keyword across
// all SCAN_TLDS and return everyone related to the name.
async function hunt(query, onProgress, opts = {}) {
  const cleaned = String(query || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (!cleaned) return { keyword: '', results: [] };

  const enrichEnabled = opts.enrich !== false; // deep enrichment on by default
  const enrichCap = opts.enrichCap || 12;      // max domains to deep-enrich per hunt

  const keyword = cleaned.includes('.') ? cleaned.split('.')[0] : cleaned;
  const targets = SCAN_TLDS.map((tld) => `${keyword}.${tld}`);
  // Always include the exact domain the user typed, if it had a TLD.
  if (cleaned.includes('.') && !targets.includes(cleaned)) targets.unshift(cleaned);

  // Phase 1 — fast RDAP scan across all TLDs to find registered look-alikes.
  const results = [];
  let done = 0;
  const total = targets.length + (enrichEnabled ? enrichCap : 0);
  const report = (label) => { if (onProgress) onProgress(done, total, label); };

  const CONCURRENCY = 6;
  const queue = targets.slice();
  async function scanWorker() {
    while (queue.length) {
      const fqdn = queue.shift();
      try {
        results.push(await lookupOne(fqdn));
      } catch (e) {
        results.push({ domain: fqdn, status: 'unknown', registered: null, note: 'error', contacts: [] });
      }
      done += 1;
      report('Scanning registries');
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, scanWorker));

  // Phase 2 — deep contact enrichment on the registered domains. Prioritize the
  // exact domain the user typed, then the rest, capped to keep it responsive.
  if (enrichEnabled) {
    const registered = results.filter((r) => r.registered === true);
    registered.sort((a, b) => {
      if (a.domain === cleaned) return -1;
      if (b.domain === cleaned) return 1;
      return 0;
    });
    const toEnrich = registered.slice(0, enrichCap);

    const eq = toEnrich.slice();
    const ECONC = 3;
    async function enrichWorker() {
      while (eq.length) {
        const rec = eq.shift();
        try {
          const enr = await enrichDomain(rec.domain, () => report(`Enriching ${rec.domain}`));
          const seen = new Set(rec.contacts.map((c) => c.type + '|' + String(c.value).toLowerCase()));
          for (const c of enr.contacts) {
            const k = c.type + '|' + String(c.value).toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k);
            rec.contacts.push(c);
          }
          const enrichedEmails = enr.contacts.filter((c) => c.type === 'email').map((c) => c.value);
          rec.emails = [...new Set([...(rec.emails || []), ...enrichedEmails])];
          rec.meta = enr.meta;
          rec.sources = [...new Set([...(rec.sources || ['rdap']), ...enr.sources])];
          if ((!rec.owner || rec.owner === '(redacted)') && enr.meta && enr.meta.title) rec.owner = enr.meta.title;
        } catch (_) { /* best-effort */ }
        done += 1;
        report('Enriching contacts');
      }
    }
    await Promise.all(Array.from({ length: ECONC }, enrichWorker));
    // Account for any enrich slots we didn't use so the bar completes.
    done = total;
    report('Done');
  }

  // Sort: registered brands with the most contacts first, then available.
  results.sort((a, b) => {
    const score = (r) => (r.registered ? 1000 + ((r.contacts && r.contacts.length) || 0) : (r.registered === false ? 1 : 0));
    return score(b) - score(a);
  });

  return { keyword, results };
}

module.exports = { hunt, lookupOne, SCAN_TLDS };
