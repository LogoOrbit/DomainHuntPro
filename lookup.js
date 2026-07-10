'use strict';

// DomainHunt Pro — core lookup engine.
// Uses RDAP (Registration Data Access Protocol), the official, free,
// no-API-key registry protocol, to find real registrant orgs and contact
// emails for a domain name and its look-alikes across many TLDs.

const https = require('https');

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
async function lookupOne(fqdn) {
  const rdap = await httpsGetJson(`https://rdap.org/domain/${encodeURIComponent(fqdn)}`);

  if (rdap.__notFound) {
    return { domain: fqdn, status: 'available', registered: false, note: 'Not registered — acquisition target' };
  }
  if (rdap.__error) {
    return { domain: fqdn, status: 'unknown', registered: null, note: `Lookup failed (${rdap.__error})` };
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

  return {
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
    expires: events.expiration || ''
  };
}

// Given a user query (a domain or a bare keyword), scan the keyword across
// all SCAN_TLDS and return everyone related to the name.
async function hunt(query, onProgress, tlds) {
  const cleaned = String(query || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (!cleaned) return { keyword: '', results: [] };

  const scanList = (tlds && tlds.length ? tlds : SCAN_TLDS);
  const keyword = cleaned.includes('.') ? cleaned.split('.')[0] : cleaned;
  const targets = scanList.map((tld) => `${keyword}.${tld}`);
  // Always include the exact domain the user typed, if it had a TLD.
  if (cleaned.includes('.') && !targets.includes(cleaned)) targets.unshift(cleaned);

  const results = [];
  let done = 0;
  const CONCURRENCY = 6;
  const queue = targets.slice();

  async function worker() {
    while (queue.length) {
      const fqdn = queue.shift();
      try {
        const rec = await lookupOne(fqdn);
        results.push(rec);
      } catch (e) {
        results.push({ domain: fqdn, status: 'unknown', registered: null, note: 'error' });
      }
      done += 1;
      if (onProgress) onProgress(done, targets.length);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Sort: registered brands with contacts first, then registered, then available.
  results.sort((a, b) => {
    const score = (r) => (r.registered ? (r.emails && r.emails.length ? 2 : 1) : 0);
    return score(b) - score(a);
  });

  return { keyword, results };
}

module.exports = { hunt, lookupOne, SCAN_TLDS };
