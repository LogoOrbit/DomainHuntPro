'use strict';

// DomainHunt Pro — multi-source contact enrichment engine.
//
// RDAP alone returns almost nothing for most domains: registries redact
// registrant contacts under GDPR, so a pure-registry hunt yields a handful of
// role-based mailboxes at best. This module fans out across many *public*
// data sources to discover as many real, reachable contacts as possible for a
// domain and the organization behind it:
//
//   1. Website crawl      — homepage + contact/about/team/legal pages, plus
//                           discovered subdomains, scraped for emails, phones
//                           and social handles.
//   2. Certificate logs   — crt.sh certificate-transparency search enumerates
//                           subdomains (mail., careers., support., …), each of
//                           which is another crawl surface.
//   3. DNS (DoH)          — MX / TXT / A records over DNS-over-HTTPS reveal mail
//                           infrastructure and verification tokens (SPF, DKIM,
//                           Google/Microsoft/marketing platforms in use).
//   4. Social handles     — LinkedIn / Twitter(X) / Facebook / Instagram /
//                           YouTube profile URLs found on the site, turned into
//                           direct outreach channels.
//   5. RDAP registry      — registrant org + any exposed contact emails.
//   6. Role/pattern mail  — once a real name is found, common corporate email
//                           patterns (first.last@, f.last@, first@ …) are
//                           synthesized as candidate addresses.
//   7. Pluggable providers— optional paid enrichment APIs (Hunter.io, Apollo,
//                           Clearbit, …) auto-activate when their API key is
//                           present in the environment. See PROVIDERS below.
//
// Every contact is tagged with its source and a confidence score, then merged
// and de-duplicated. Nothing here bypasses authentication or scrapes behind a
// login — it reads what a browser visiting the public site would see.

const https = require('https');
const http = require('http');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const dns = require('dns').promises;

// Optional proxy support. Honors HTTPS_PROXY / HTTP_PROXY (and lowercase) so the
// engine works behind corporate proxies. For https targets we open a CONNECT
// tunnel through the proxy, then run TLS over it.
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy ||
  process.env.HTTP_PROXY || process.env.http_proxy || '';
let EXTRA_CA;
try {
  if (process.env.NODE_EXTRA_CA_CERTS) EXTRA_CA = fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS);
} catch (_) { /* ignore */ }

function connectViaProxy(proxyUrl, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const sock = net.connect(Number(p.port) || 80, p.hostname, () => {
      let headers = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;
      if (p.username) {
        const auth = Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64');
        headers += `Proxy-Authorization: Basic ${auth}\r\n`;
      }
      sock.write(headers + 'Connection: keep-alive\r\n\r\n');
    });
    let buf = '';
    const onData = (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        sock.removeListener('data', onData);
        if (/^HTTP\/1\.[01] 2\d\d/.test(buf)) resolve(sock);
        else { sock.destroy(); reject(new Error('proxy CONNECT failed: ' + buf.split('\r\n')[0])); }
      }
    };
    sock.on('data', onData);
    sock.once('error', reject);
    sock.setTimeout(12000, () => { sock.destroy(); reject(new Error('proxy timeout')); });
  });
}

// ---------------------------------------------------------------------------
// Low-level fetch helpers
// ---------------------------------------------------------------------------

const UA = 'Mozilla/5.0 (compatible; DomainHuntPro/2.0; +contact-research)';

async function buildRequestOptions(url, timeout) {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const opts = {
    method: 'GET',
    host: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: u.pathname + u.search,
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/json,*/*', 'Host': u.host },
    timeout
  };
  const mod = isHttps ? https : http;

  if (PROXY_URL) {
    if (isHttps) {
      // Tunnel via CONNECT, then TLS over the resulting socket.
      const sock = await connectViaProxy(PROXY_URL, u.hostname, opts.port);
      opts.socket = sock;
      opts.agent = false;
      if (EXTRA_CA) opts.ca = [...tls.rootCertificates, EXTRA_CA.toString()];
      opts.servername = u.hostname;
    } else {
      // Plain HTTP proxying: send absolute URL to the proxy.
      const p = new URL(PROXY_URL);
      opts.host = p.hostname;
      opts.port = Number(p.port) || 80;
      opts.path = url;
    }
  }
  return { mod, opts };
}

function fetchText(url, { redirectsLeft = 4, timeout = 12000, maxBytes = 3_000_000 } = {}) {
  return new Promise((resolve) => {
    (async () => {
    let mod, opts;
    try { ({ mod, opts } = await buildRequestOptions(url, timeout)); }
    catch (_) { return resolve({ __error: 'proxy' }); }

    const req = mod.request(opts, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location && redirectsLeft > 0) {
        res.resume();
        let next;
        try { next = new URL(headers.location, url).href; } catch (_) { return resolve({ __error: 'redir' }); }
        return resolve(fetchText(next, { redirectsLeft: redirectsLeft - 1, timeout, maxBytes }));
      }
      if (statusCode === 404) return resolve({ __notFound: true });
      if (statusCode >= 400) return resolve({ __error: statusCode });
      let data = '';
      let bytes = 0;
      res.on('data', (c) => {
        bytes += c.length;
        if (bytes > maxBytes) { req.destroy(); return; }
        data += c;
      });
      res.on('end', () => resolve({ ok: true, body: data, finalUrl: url, contentType: headers['content-type'] || '' }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ __error: 'timeout' }); });
    req.on('error', () => resolve({ __error: 'network' }));
    req.end();
    })();
  });
}

async function fetchJson(url, opts) {
  const r = await fetchText(url, opts);
  if (!r.ok) return r;
  try { return { ok: true, json: JSON.parse(r.body) }; }
  catch (_) { return { __error: 'parse' }; }
}

// ---------------------------------------------------------------------------
// Extraction (emails, phones, social handles, names)
// ---------------------------------------------------------------------------

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;
// Obfuscated forms: "name [at] domain [dot] com", "name(at)domain(dot)com"
const OBFUSCATED_RE = /([a-z0-9._%+-]+)\s*(?:\[at\]|\(at\)|\s+at\s+|&#64;|＠)\s*([a-z0-9.-]+)\s*(?:\[dot\]|\(dot\)|\s+dot\s+|\.)\s*([a-z]{2,24})/gi;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;

const JUNK_EMAIL_HOSTS = /(?:example\.|sentry\.|wixpress\.|\.png|\.jpg|\.jpeg|\.gif|\.svg|\.webp|\.css|\.js|@2x|domain\.com|email\.com|yourdomain|your-email)/i;

function decodeCfEmails(html) {
  // Cloudflare email-protection: data-cfemail="hexhex..." XOR-encoded.
  const out = [];
  const re = /data-cfemail=["']?([0-9a-f]+)["']?/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const hex = m[1];
      const key = parseInt(hex.substr(0, 2), 16);
      let email = '';
      for (let i = 2; i < hex.length; i += 2) {
        email += String.fromCharCode(parseInt(hex.substr(i, 2), 16) ^ key);
      }
      if (email.includes('@')) out.push(email.toLowerCase());
    } catch (_) { /* ignore */ }
  }
  return out;
}

function extractEmails(html) {
  const found = new Set();
  const scan = (str) => {
    let m;
    EMAIL_RE.lastIndex = 0;
    while ((m = EMAIL_RE.exec(str))) {
      const e = m[0].toLowerCase().replace(/\.$/, '');
      if (!JUNK_EMAIL_HOSTS.test(e) && e.length < 100) found.add(e);
    }
    OBFUSCATED_RE.lastIndex = 0;
    while ((m = OBFUSCATED_RE.exec(str))) {
      const e = `${m[1]}@${m[2]}.${m[3]}`.toLowerCase();
      if (!JUNK_EMAIL_HOSTS.test(e)) found.add(e);
    }
  };
  scan(html);
  // Also decode &#64; entity emails and mailto: links explicitly.
  const mailtoRe = /mailto:([^"'?\s>]+)/gi;
  let mm;
  while ((mm = mailtoRe.exec(html))) {
    const e = decodeURIComponent(mm[1]).toLowerCase();
    if (EMAIL_RE.test(e) && !JUNK_EMAIL_HOSTS.test(e)) found.add(e);
  }
  for (const e of decodeCfEmails(html)) found.add(e);
  return [...found];
}

const SOCIAL_PATTERNS = [
  ['linkedin', /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|in|school)\/[A-Za-z0-9._%-]+/gi],
  ['twitter', /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[A-Za-z0-9_]{2,30}/gi],
  ['facebook', /https?:\/\/(?:www\.)?facebook\.com\/[A-Za-z0-9.\-]{3,60}/gi],
  ['instagram', /https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9._]{2,40}/gi],
  ['youtube', /https?:\/\/(?:www\.)?youtube\.com\/(?:@[A-Za-z0-9._-]+|channel\/[A-Za-z0-9_-]+|c\/[A-Za-z0-9_-]+)/gi],
  ['github', /https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9-]{1,39}/gi]
];

const SOCIAL_JUNK = /(?:\/(?:sharer|share|intent|home|login|signup|policies|help|about|tr\?)|facebook\.com\/(?:tr|plugins|dialog))/i;

function extractSocials(html) {
  const out = {};
  for (const [name, re] of SOCIAL_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(html))) {
      const url = m[0].replace(/[).,'"]+$/, '');
      if (SOCIAL_JUNK.test(url)) continue;
      out[name] = out[name] || new Set();
      out[name].add(url);
    }
  }
  const flat = {};
  for (const k of Object.keys(out)) flat[k] = [...out[k]].slice(0, 12);
  return flat;
}

function extractPhones(html) {
  // Pull tel: links (highest quality) plus loose matches.
  const found = new Set();
  const telRe = /tel:([+\d][\d\s().-]{6,}\d)/gi;
  let m;
  while ((m = telRe.exec(html))) found.add(m[1].replace(/\s+/g, ' ').trim());
  // Loose matches only from visible text (strip tags first) to cut noise.
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
  PHONE_RE.lastIndex = 0;
  while ((m = PHONE_RE.exec(text))) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 15) found.add(m[0].replace(/\s+/g, ' ').trim());
    if (found.size > 40) break;
  }
  return [...found];
}

function extractTitle(html) {
  const m = /<title[^>]*>([^<]{1,140})<\/title>/i.exec(html);
  return m ? m[1].trim() : '';
}

// ---------------------------------------------------------------------------
// Source 1: website crawl
// ---------------------------------------------------------------------------

const CONTACT_PATHS = [
  '', '/contact', '/contact-us', '/contactus', '/about', '/about-us', '/team',
  '/our-team', '/people', '/staff', '/leadership', '/company', '/support',
  '/help', '/imprint', '/impressum', '/legal', '/privacy', '/press', '/media',
  '/careers', '/jobs', '/investors', '/partners'
];

async function crawlSite(host, { maxPages = 14, concurrency = 5 } = {}) {
  const bases = [`https://${host}`, `https://www.${host}`];
  // Pick whichever base responds first.
  let base = null;
  for (const b of bases) {
    const probe = await fetchText(b, { timeout: 9000 });
    if (probe.ok) { base = probe.finalUrl.replace(/\/$/, ''); break; }
  }
  if (!base) return { reachable: false, emails: [], phones: [], socials: {}, title: '', pages: 0 };

  const origin = (() => { try { return new URL(base).origin; } catch (_) { return base; } })();
  const queue = CONTACT_PATHS.map((p) => origin + p);
  const seen = new Set();
  const emails = new Set();
  const phones = new Set();
  const socials = {};
  let title = '';
  let pages = 0;

  const mergeSocials = (s) => {
    for (const k of Object.keys(s)) {
      socials[k] = socials[k] || new Set();
      for (const v of s[k]) socials[k].add(v);
    }
  };

  async function worker() {
    while (queue.length && pages < maxPages) {
      const url = queue.shift();
      if (seen.has(url)) continue;
      seen.add(url);
      const r = await fetchText(url, { timeout: 9000 });
      if (!r.ok || !/text\/html|json|xml/i.test(r.contentType || 'text/html')) continue;
      pages += 1;
      if (!title) title = extractTitle(r.body);
      for (const e of extractEmails(r.body)) emails.add(e);
      for (const p of extractPhones(r.body)) phones.add(p);
      mergeSocials(extractSocials(r.body));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const flatSocials = {};
  for (const k of Object.keys(socials)) flatSocials[k] = [...socials[k]].slice(0, 12);
  return { reachable: true, emails: [...emails], phones: [...phones], socials: flatSocials, title, pages };
}

// ---------------------------------------------------------------------------
// Source 2: certificate transparency (subdomain enumeration)
// ---------------------------------------------------------------------------

async function enumerateSubdomains(host) {
  const subs = new Set();
  const r = await fetchJson(`https://crt.sh/?q=%25.${encodeURIComponent(host)}&output=json`, { timeout: 15000 });
  if (r.ok && Array.isArray(r.json)) {
    for (const row of r.json) {
      const names = String(row.name_value || '').split(/\n/);
      for (let n of names) {
        n = n.trim().toLowerCase().replace(/^\*\./, '');
        if (n.endsWith(host) && n !== host && /^[a-z0-9.-]+$/.test(n)) subs.add(n);
      }
    }
  }
  return [...subs];
}

// Subdomains worth crawling for extra contacts.
const INTERESTING_SUB = /^(?:www|mail|email|contact|support|help|careers|jobs|team|about|investor|press|media|partners|sales|info|hello|corp|corporate|hr|people)\./;

// ---------------------------------------------------------------------------
// Source 3: DNS over HTTPS
// ---------------------------------------------------------------------------

async function dnsIntel(host) {
  const out = { mx: [], txt: [], provider: [] };
  try {
    out.mx = (await dns.resolveMx(host)).map((r) => r.exchange).slice(0, 10);
  } catch (_) { /* none */ }
  try {
    out.txt = (await dns.resolveTxt(host)).map((a) => a.join('')).slice(0, 20);
  } catch (_) { /* none */ }
  {
    // Fingerprint common platforms from MX + verification tokens. Runs even if
    // one of the record types is missing.
    const joined = out.txt.join(' ').toLowerCase();
    const marks = [
      [/google-site-verification|_spf\.google|aspmx\.l\.google/, 'Google Workspace'],
      [/ms=|outlook\.com|protection\.outlook/, 'Microsoft 365'],
      [/facebook-domain-verification/, 'Facebook Business'],
      [/hubspot|hs1\.|hs2\./, 'HubSpot'],
      [/pardot|salesforce/, 'Salesforce'],
      [/mailchimp|mandrill/, 'Mailchimp'],
      [/sendgrid/, 'SendGrid'],
      [/zoho/, 'Zoho'],
      [/stripe-verification/, 'Stripe'],
      [/atlassian|_atlassian/, 'Atlassian']
    ];
    const mxJoined = out.mx.join(' ').toLowerCase();
    for (const [re, label] of marks) {
      if (re.test(joined) || re.test(mxJoined)) out.provider.push(label);
    }
    out.provider = [...new Set(out.provider)];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Source 6: email-pattern synthesis from discovered names
// ---------------------------------------------------------------------------

function synthesizePatterns(host, names) {
  const out = [];
  for (const full of names) {
    const parts = String(full).toLowerCase().replace(/[^a-z\s]/g, '').trim().split(/\s+/);
    if (parts.length < 2) continue;
    const f = parts[0];
    const l = parts[parts.length - 1];
    for (const pat of [`${f}.${l}`, `${f}${l}`, `${f}`, `${f[0]}${l}`, `${f}_${l}`, `${f}-${l}`, `${f[0]}.${l}`]) {
      out.push({ email: `${pat}@${host}`, name: full, source: 'pattern', confidence: 0.35 });
    }
  }
  return out;
}

// Extract likely person names (First Last) near role/title words on team pages.
function extractNames(html) {
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const names = new Set();
  // Capitalized First Last (optionally middle), bounded, avoid ALLCAPS nav.
  const re = /\b([A-Z][a-z]{1,15})\s+(?:[A-Z]\.?\s+)?([A-Z][a-z]{1,20})\b/g;
  let m;
  const STOP = /^(The|Our|About|Contact|Privacy|Terms|All|New|Get|Learn|Read|View|Sign|Log|Home|Team|Careers|Cookie|United|San|Los|New York)$/;
  while ((m = re.exec(text))) {
    if (STOP.test(m[1]) || STOP.test(m[2])) continue;
    names.add(`${m[1]} ${m[2]}`);
    if (names.size > 60) break;
  }
  return [...names];
}

// ---------------------------------------------------------------------------
// Source 7: pluggable paid providers (activate when API key is present)
// ---------------------------------------------------------------------------

const PROVIDERS = [
  {
    name: 'Hunter.io',
    envKey: 'HUNTER_API_KEY',
    async run(host, key) {
      const r = await fetchJson(`https://api.hunter.io/v2/domain-search?domain=${host}&limit=100&api_key=${key}`);
      if (!r.ok || !r.json || !r.json.data) return [];
      return (r.json.data.emails || []).map((e) => ({
        email: e.value,
        name: [e.first_name, e.last_name].filter(Boolean).join(' '),
        title: e.position || '',
        source: 'hunter.io',
        confidence: (e.confidence || 50) / 100
      }));
    }
  },
  {
    name: 'Apollo.io',
    envKey: 'APOLLO_API_KEY',
    async run(host /*, key */) { void host; return []; /* wire POST /v1/mixed_people/search here */ }
  },
  {
    name: 'Clearbit',
    envKey: 'CLEARBIT_API_KEY',
    async run(host /*, key */) { void host; return []; /* wire Prospector API here */ }
  }
];

async function runProviders(host) {
  const contacts = [];
  const active = [];
  for (const p of PROVIDERS) {
    const key = process.env[p.envKey];
    if (!key) continue;
    active.push(p.name);
    try {
      const rows = await p.run(host, key);
      for (const c of rows) contacts.push(c);
    } catch (_) { /* provider failed, skip */ }
  }
  return { contacts, active };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function normalizeContact(c) {
  return {
    type: c.email ? 'email' : (c.phone ? 'phone' : c.channel ? 'social' : 'other'),
    value: c.email || c.phone || c.url || c.value || '',
    name: c.name || '',
    title: c.title || '',
    channel: c.channel || '',
    source: c.source || 'web',
    confidence: c.confidence != null ? c.confidence : 0.6
  };
}

// Full enrichment for one host. Returns a rich contact set.
// onStep(label) is an optional progress callback.
async function enrichDomain(host, onStep = () => {}) {
  host = String(host || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (!host || !host.includes('.')) return { host, contacts: [], meta: {}, sources: [] };

  const contacts = [];
  const sources = [];
  const meta = { subdomains: [], socials: {}, dns: {}, providers: [], title: '' };

  const push = (c) => contacts.push(normalizeContact(c));

  // Kick off independent sources in parallel.
  onStep('Crawling website');
  const [site, subs, dnsInfo, prov] = await Promise.all([
    crawlSite(host).catch(() => ({ reachable: false, emails: [], phones: [], socials: {} })),
    enumerateSubdomains(host).catch(() => []),
    dnsIntel(host).catch(() => ({ mx: [], txt: [], provider: [] })),
    runProviders(host).catch(() => ({ contacts: [], active: [] }))
  ]);

  if (site.reachable) sources.push('website');
  meta.title = site.title || '';
  for (const e of site.emails) push({ email: e, source: 'website', confidence: 0.9 });
  for (const p of site.phones) push({ phone: p, source: 'website', confidence: 0.8 });
  for (const k of Object.keys(site.socials || {})) {
    for (const url of site.socials[k]) push({ channel: k, url, source: 'website', confidence: 0.85 });
  }

  // Subdomains: record them, and crawl the interesting ones for more contacts.
  meta.subdomains = subs.slice(0, 200);
  if (subs.length) sources.push('certificate-transparency');
  const toCrawl = subs.filter((s) => INTERESTING_SUB.test(s)).slice(0, 8);
  if (toCrawl.length) {
    onStep('Scanning subdomains');
    const subResults = await Promise.all(toCrawl.map((s) => crawlSite(s, { maxPages: 4 }).catch(() => null)));
    for (const sr of subResults) {
      if (!sr || !sr.reachable) continue;
      for (const e of sr.emails) push({ email: e, source: 'subdomain', confidence: 0.85 });
      for (const p of sr.phones) push({ phone: p, source: 'subdomain', confidence: 0.7 });
      for (const k of Object.keys(sr.socials || {})) {
        for (const url of sr.socials[k]) push({ channel: k, url, source: 'subdomain', confidence: 0.75 });
      }
    }
  }

  // DNS intel.
  meta.dns = dnsInfo;
  if (dnsInfo.mx.length || dnsInfo.txt.length) sources.push('dns');

  // Names → pattern emails (candidate outreach when direct emails are scarce).
  onStep('Deriving contacts');
  const homepageNames = [];
  if (site.reachable) {
    // Re-crawl team/about lightly for names.
    const teamPages = await Promise.all(
      ['about', 'team', 'our-team', 'people', 'leadership', 'staff']
        .map((p) => fetchText(`https://${host}/${p}`, { timeout: 8000 }).catch(() => null))
    );
    for (const r of teamPages) {
      if (r && r.ok) for (const n of extractNames(r.body)) homepageNames.push(n);
    }
  }
  const uniqNames = [...new Set(homepageNames)];
  for (const c of synthesizePatterns(host, uniqNames)) push(c);
  if (uniqNames.length) sources.push('name-patterns');

  // Providers.
  meta.providers = prov.active;
  if (prov.active.length) sources.push('providers:' + prov.active.join('+'));
  for (const c of prov.contacts) push(c);

  meta.socials = site.socials || {};

  // De-duplicate on value, keeping the highest-confidence variant.
  const byVal = new Map();
  for (const c of contacts) {
    if (!c.value) continue;
    const key = c.type + '|' + c.value.toLowerCase();
    const prev = byVal.get(key);
    if (!prev || c.confidence > prev.confidence) byVal.set(key, c);
  }
  const merged = [...byVal.values()].sort((a, b) => b.confidence - a.confidence);

  return { host, contacts: merged, meta, sources: [...new Set(sources)] };
}

module.exports = {
  enrichDomain,
  crawlSite,
  enumerateSubdomains,
  dnsIntel,
  extractEmails,
  extractSocials,
  synthesizePatterns
};
