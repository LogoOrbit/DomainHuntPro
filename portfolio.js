'use strict';

// DomainHunt Pro — bulk portfolio lead engine.
// Runs the RDAP look-alike hunt across every domain in a portfolio and
// aggregates everyone who turns up (owners of similar names, brands with
// contact addresses) into a single deduped, scored outreach list.

const { hunt } = require('./lookup');
const { searchTrademarks } = require('./trademark');

// A smaller TLD set for fast bulk scans over large portfolios; the full
// SCAN_TLDS list from lookup.js is used for a thorough (slower) pass.
const QUICK_TLDS = ['com', 'net', 'org', 'io', 'co', 'ai', 'app', 'xyz'];

function leadKey(org, email, fallbackDomain) {
  return (org || email || fallbackDomain || '').toLowerCase().trim();
}

function domainKeyword(fqdn) {
  return fqdn.includes('.') ? fqdn.split('.')[0] : fqdn;
}

async function huntPortfolio(domains, { tlds, concurrency = 4, onProgress, isCancelled, usptoApiKey } = {}) {
  const list = [...new Set((domains || []).map((d) => String(d).trim().toLowerCase()).filter(Boolean))];
  const scanTlds = tlds && tlds.length ? tlds : QUICK_TLDS;
  const leadsMap = new Map();
  let done = 0;

  // Get-or-create a lead bucket keyed by owner/email, tracking its sources.
  function bucket(key, seed) {
    let lead = leadsMap.get(key);
    if (!lead) {
      lead = {
        org: seed.org || '',
        emails: new Set(),
        outreach: new Set(),
        lookalikeDomains: new Set(),
        yourDomains: new Set(),
        trademarks: new Set(),
        sources: new Set(),
        registrar: seed.registrar || ''
      };
      leadsMap.set(key, lead);
    }
    return lead;
  }

  function ingestRdap(fqdn, results) {
    for (const r of results) {
      if (r.domain === fqdn) continue; // that's your own portfolio domain, not a lead
      if (!r.registered) continue;
      const contacts = (r.emails && r.emails.length) ? r.emails : [];
      const org = r.owner && r.owner !== '(redacted)' ? r.owner : '';
      if (!org && !contacts.length) continue;

      const lead = bucket(leadKey(org, contacts[0], r.domain), { org, registrar: r.registrar });
      contacts.forEach((e) => lead.emails.add(e));
      if (!contacts.length && r.outreach) r.outreach.forEach((e) => lead.outreach.add(e));
      if (!lead.org && org) lead.org = org;
      lead.lookalikeDomains.add(r.domain);
      lead.yourDomains.add(fqdn);
      lead.sources.add('rdap');
    }
  }

  function ingestTrademarks(fqdn, marks) {
    for (const m of marks) {
      if (!m.owner) continue;
      const lead = bucket(leadKey(m.owner, '', ''), { org: m.owner });
      if (!lead.org) lead.org = m.owner;
      if (m.wordmark) lead.trademarks.add(m.wordmark + (m.serial ? ` (#${m.serial})` : ''));
      const loc = [m.state, m.country].filter(Boolean).join(', ');
      if (loc) lead.location = loc;
      lead.yourDomains.add(fqdn);
      lead.sources.add('trademark');
    }
  }

  const queue = list.slice();
  async function worker() {
    while (queue.length) {
      if (isCancelled && isCancelled()) return;
      const fqdn = queue.shift();
      if (fqdn === undefined) return;
      try {
        const { results } = await hunt(fqdn, null, scanTlds);
        ingestRdap(fqdn, results);
      } catch (e) {
        // skip failed domain, keep going
      }
      if (usptoApiKey) {
        try {
          const marks = await searchTrademarks(domainKeyword(fqdn), usptoApiKey);
          ingestTrademarks(fqdn, marks);
        } catch (e) {
          // trademark lookup is best-effort; never blocks the scan
        }
      }
      done += 1;
      if (onProgress) onProgress(done, list.length);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  const leads = [...leadsMap.values()].map((l) => ({
    org: l.org || '(unnamed owner)',
    emails: [...l.emails],
    outreach: l.outreach.size && !l.emails.size ? [...l.outreach] : [],
    lookalikeDomains: [...l.lookalikeDomains],
    yourDomains: [...l.yourDomains],
    trademarks: [...l.trademarks],
    sources: [...l.sources],
    location: l.location || '',
    registrar: l.registrar,
    // Trademark owners are high-intent → weight them; direct emails and
    // interest in multiple of your domains also lift the score.
    score: l.emails.size * 3
      + l.yourDomains.size * 2
      + l.lookalikeDomains.size
      + (l.sources.has('trademark') ? 4 : 0)
      + l.trademarks.size
  }));

  leads.sort((a, b) => b.score - a.score);

  return { scanned: list.length, leads };
}

module.exports = { huntPortfolio, QUICK_TLDS };
