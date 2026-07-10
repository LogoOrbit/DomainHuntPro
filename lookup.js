'use strict';

// DomainHunt Pro — buyer-hunt engine.
//
// Mission: given a premium domain the user ALREADY OWNS, find companies
// operating on weaker look-alike domains (longer, hyphenated, prefixed,
// non-.com) who would benefit from upgrading to the user's domain — and
// surface the best contact for each, with a prospect score and ready-made
// outreach.
//
// Uses RDAP (Registration Data Access Protocol) — the official, free,
// no-API-key registry protocol — to find real registrant orgs and emails.

const https = require('https');

// TLDs scanned for look-alike registrations, ordered by commercial relevance.
const SCAN_TLDS = [
  'com', 'net', 'org', 'io', 'co', 'ai', 'app', 'dev', 'me', 'info',
  'biz', 'us', 'online', 'store', 'tech', 'agency', 'company', 'shop', 'pro'
];

// Name variants a real business would register when the exact .com is taken.
// These are the "weaker domain" patterns the spec calls out
// (getswiftpay.com, swift-payments.com, luxurycarsonline.net, …).
const PREFIXES = ['get', 'my', 'the', 'best', 'try', 'use'];
const SUFFIXES = ['online', 'group', 'world', 'sales', 'hq', 'app', 'pro', 'global', 'solutions'];

// Role-based mailboxes used only as a fallback when no direct email exists.
const FALLBACK_PREFIXES = ['info', 'hello', 'contact', 'sales'];
// Decision-maker mailboxes guessed on the company's own domain (higher value
// than generic inboxes, still unverified).
const DM_PREFIXES = ['ceo', 'founder', 'owner', 'marketing'];

function httpsGetJson(url, redirectsLeft = 5) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'Accept': 'application/rdap+json, application/json', 'User-Agent': 'DomainHuntPro/2.0' },
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
  const out = { name: '', org: '', email: '', kind: '', title: '' };
  if (!Array.isArray(vcardArray) || vcardArray[0] !== 'vcard') return out;
  for (const entry of vcardArray[1] || []) {
    if (!Array.isArray(entry)) continue;
    const [field, , , value] = entry;
    if (field === 'fn' && value) out.name = String(value);
    if (field === 'org' && value) out.org = Array.isArray(value) ? value.join(' ') : String(value);
    if (field === 'email' && value) out.email = String(value);
    if (field === 'title' && value) out.title = String(value);
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

function titleCase(s) {
  return s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// --- Contact building --------------------------------------------------------
// Returns { contacts: [{email, label, confidence}], bestContact }
// Confidence: Verified (came from the registry record) > Likely Valid
// (decision-maker guess on their own domain) > Unknown (generic inbox).
function buildContacts(fqdn, entities) {
  const contacts = [];
  const seen = new Set();
  const add = (email, label, confidence) => {
    const key = email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    contacts.push({ email, label, confidence });
  };

  // Direct emails straight from registry records — best possible source.
  for (const e of entities) {
    if (!e.email || /abuse|registrar|privacy|proxy|redacted/i.test(e.email + ' ' + e.roles)) continue;
    const who = [e.name, e.title].filter(Boolean).join(', ') ||
      (/registrant/i.test(e.roles) ? 'Registrant (owner)' : titleCase(e.roles || 'Contact'));
    add(e.email, who, 'Verified');
  }

  // Decision-maker guesses on the company's own domain.
  if (contacts.length === 0) {
    for (const p of DM_PREFIXES) add(`${p}@${fqdn}`, titleCase(p) + ' (guessed)', 'Likely Valid');
    for (const p of FALLBACK_PREFIXES) add(`${p}@${fqdn}`, 'Generic inbox', 'Unknown');
  }

  return { contacts, bestContact: contacts[0] || null };
}

// --- Prospect scoring ---------------------------------------------------------
// 0–100 with human-readable reasons, per the spec's rubric.
function scoreProspect(rec, ownedDomain) {
  let score = 0;
  const reasons = [];

  score += 35; reasons.push('Active business registered on a look-alike domain');

  const theirName = rec.domain.split('.')[0];
  const yourName = ownedDomain.split('.')[0];
  if (theirName.length > yourName.length) {
    score += 15; reasons.push(`Uses a longer domain (${rec.domain}) — clear upgrade to ${ownedDomain}`);
  }
  if (theirName.includes('-')) {
    score += 8; reasons.push('Hyphenated domain — loses type-in traffic to yours');
  }
  if (!rec.domain.endsWith('.com') && ownedDomain.endsWith('.com')) {
    score += 10; reasons.push('Non-.com TLD — your .com is the natural brand home');
  }
  if (rec.verifiedEmails > 0) {
    score += 20; reasons.push('Direct registry-verified contact email available');
  } else {
    score += 5; reasons.push('Only guessed/generic contact available');
  }
  if (rec.owner && rec.owner !== '(redacted)') {
    score += 7; reasons.push(`Company identified: ${rec.owner}`);
  }
  // Recent registry activity signals an active, invested brand.
  const recent = (d) => d && (Date.now() - Date.parse(d)) < 2 * 365 * 24 * 3600 * 1000;
  if (recent(rec.created)) {
    score += 5; reasons.push('Recently registered — new brand still forming its identity');
  } else if (recent(rec.updated)) {
    score += 5; reasons.push('Recent registry activity — domain actively maintained');
  }

  score = Math.max(0, Math.min(100, score));
  const tier = score >= 90 ? 'Perfect Buyer' : score >= 75 ? 'Excellent Buyer'
    : score >= 60 ? 'Good Buyer' : 'Possible Buyer';
  return { score, tier, reasons };
}

// --- AI recommendation + outreach ---------------------------------------------
function buildRecommendation(rec, ownedDomain) {
  const company = rec.owner && rec.owner !== '(redacted)' ? rec.owner : `The operator of ${rec.domain}`;
  const bits = [`${company} currently operates on ${rec.domain}.`];
  bits.push(`Acquiring ${ownedDomain} would sharpen their branding, improve email credibility and ad performance, and capture type-in traffic they currently lose.`);
  if (rec.scoreDetail && rec.scoreDetail.reasons.length) {
    bits.push('Key signals: ' + rec.scoreDetail.reasons.slice(0, 3).join('; ') + '.');
  }
  return bits.join(' ');
}

function buildOutreach(rec, ownedDomain) {
  const company = rec.owner && rec.owner !== '(redacted)' ? rec.owner : `the team behind ${rec.domain}`;
  const name = titleCase(ownedDomain.split('.')[0]);
  return {
    coldEmail:
`Subject: ${ownedDomain} — a natural upgrade for ${company}

Hi,

I noticed ${company} is building on ${rec.domain}. I own ${ownedDomain} — the exact-match, easier-to-remember version of your brand's name.

Moving to ${ownedDomain} would strengthen ${name}'s branding, boost email deliverability and trust, and capture the type-in and search traffic that currently leaks away from ${rec.domain}.

I'm exploring a sale and wanted to give you first look before approaching others in the space. Open to a quick chat?

Best regards`,
    linkedin:
`Hi — I own ${ownedDomain} and noticed you're operating on ${rec.domain}. The exact-match domain could be a meaningful brand upgrade for ${company}. Happy to share details if you're the right person to speak with.`,
    followUp1:
`Subject: Re: ${ownedDomain} — a natural upgrade for ${company}

Hi,

Just following up on my note about ${ownedDomain}. Exact-match domains like this rarely change hands, and I'd rather it end up with the brand it fits best — which is ${company}.

Would a short call this week work?`,
    followUp2:
`Subject: Last note on ${ownedDomain}

Hi,

Closing the loop: I'll be opening conversations about ${ownedDomain} to other parties shortly. If upgrading from ${rec.domain} is on your roadmap, now is the best moment to talk. Either way, wishing ${company} continued growth.`
  };
}

// --- Single-domain lookup -----------------------------------------------------
async function lookupOne(fqdn) {
  const rdap = await httpsGetJson(`https://rdap.org/domain/${encodeURIComponent(fqdn)}`);
  if (rdap.__notFound) return { domain: fqdn, registered: false };
  if (rdap.__error) return { domain: fqdn, registered: null, note: `Lookup failed (${rdap.__error})` };

  const entities = extractEntities(rdap);
  const orgs = [...new Set(entities.map((e) => e.org || e.name).filter((v) => v && !/redacted|privacy|proxy|not disclosed/i.test(v)))];
  const events = (rdap.events || []).reduce((m, ev) => {
    if (ev.eventAction && ev.eventDate) m[ev.eventAction] = ev.eventDate;
    return m;
  }, {});
  let registrar = '';
  const reg = entities.find((e) => /registrar/i.test(e.roles));
  if (reg) registrar = reg.org || reg.name;

  const nonRegistrarEntities = entities.filter((e) => !/registrar/i.test(e.roles));
  const { contacts, bestContact } = buildContacts(fqdn, nonRegistrarEntities);

  return {
    domain: fqdn,
    registered: true,
    owner: orgs.filter((o) => o !== registrar)[0] || orgs[0] || '(redacted)',
    contacts,
    bestContact,
    verifiedEmails: contacts.filter((c) => c.confidence === 'Verified').length,
    registrar,
    website: `https://${fqdn}`,
    created: events.registration || '',
    updated: events.lastChanged || events['last changed'] || '',
    expires: events.expiration || ''
  };
}

// --- Variant generation ---------------------------------------------------------
function buildTargets(ownedDomain) {
  const keyword = ownedDomain.split('.')[0];
  const names = new Set();
  // Same name on other TLDs.
  for (const tld of SCAN_TLDS) names.add(`${keyword}.${tld}`);
  // Hyphenated version (split camel-ish / at word-ish boundaries is hard
  // without a dictionary; a simple full-hyphen variant covers "swift-pay").
  const hyphen = keyword.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  // Prefix/suffix variants on the big-three TLDs.
  for (const tld of ['com', 'net', 'io', 'co']) {
    for (const p of PREFIXES) names.add(`${p}${keyword}.${tld}`);
    for (const s of SUFFIXES) names.add(`${keyword}${s}.${tld}`);
    if (hyphen !== keyword) names.add(`${hyphen}.${tld}`);
  }
  names.delete(ownedDomain); // the user already owns this one
  return [...names];
}

// --- Main hunt -----------------------------------------------------------------
// query: a domain the user OWNS. Returns companies likely to buy it.
async function hunt(query, onProgress) {
  const cleaned = String(query || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (!cleaned) return { ownedDomain: '', results: [] };

  const ownedDomain = cleaned.includes('.') ? cleaned : `${cleaned}.com`;
  const targets = buildTargets(ownedDomain);

  const found = [];
  let done = 0;
  const CONCURRENCY = 8;
  const queue = targets.slice();

  async function worker() {
    while (queue.length) {
      const fqdn = queue.shift();
      try {
        const rec = await lookupOne(fqdn);
        // Buyers only: a company must actually exist on the domain.
        if (rec.registered === true) found.push(rec);
      } catch (e) { /* skip failed lookups — they are not buyers */ }
      done += 1;
      if (onProgress) onProgress(done, targets.length);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Score, explain, and generate outreach for every prospect.
  for (const rec of found) {
    rec.scoreDetail = scoreProspect(rec, ownedDomain);
    rec.score = rec.scoreDetail.score;
    rec.tier = rec.scoreDetail.tier;
    rec.recommendation = buildRecommendation(rec, ownedDomain);
    rec.outreach = buildOutreach(rec, ownedDomain);
    rec.ownedDomain = ownedDomain;
  }

  found.sort((a, b) => b.score - a.score);
  return { ownedDomain, results: found };
}

module.exports = { hunt, lookupOne, buildTargets, SCAN_TLDS };
