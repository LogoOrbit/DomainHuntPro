'use strict';

// DomainHunt Pro — bulk portfolio lead engine.
// Runs the RDAP look-alike hunt across every domain in a portfolio and
// aggregates everyone who turns up (owners of similar names, brands with
// contact addresses) into a single deduped, scored outreach list.

const { hunt } = require('./lookup');

// A smaller TLD set for fast bulk scans over large portfolios; the full
// SCAN_TLDS list from lookup.js is used for a thorough (slower) pass.
const QUICK_TLDS = ['com', 'net', 'org', 'io', 'co', 'ai', 'app', 'xyz'];

function leadKey(org, email, fallbackDomain) {
  return (org || email || fallbackDomain || '').toLowerCase().trim();
}

async function huntPortfolio(domains, { tlds, concurrency = 4, onProgress, isCancelled } = {}) {
  const list = [...new Set((domains || []).map((d) => String(d).trim().toLowerCase()).filter(Boolean))];
  const scanTlds = tlds && tlds.length ? tlds : QUICK_TLDS;
  const leadsMap = new Map();
  let done = 0;

  function ingest(fqdn, results) {
    const fresh = [];
    for (const r of results) {
      if (r.domain === fqdn) continue; // that's your own portfolio domain, not a lead
      if (!r.registered) continue;
      const contacts = (r.emails && r.emails.length) ? r.emails : [];
      const org = r.owner && r.owner !== '(redacted)' ? r.owner : '';
      if (!org && !contacts.length) continue;

      const key = leadKey(org, contacts[0], r.domain);
      let lead = leadsMap.get(key);
      if (!lead) {
        lead = {
          org: org || '',
          emails: new Set(),
          outreach: new Set(),
          lookalikeDomains: new Set(),
          yourDomains: new Set(),
          registrar: r.registrar || ''
        };
        leadsMap.set(key, lead);
        fresh.push(lead);
      }
      contacts.forEach((e) => lead.emails.add(e));
      if (!contacts.length && r.outreach) r.outreach.forEach((e) => lead.outreach.add(e));
      if (!lead.org && org) lead.org = org;
      lead.lookalikeDomains.add(r.domain);
      lead.yourDomains.add(fqdn);
    }
    return fresh;
  }

  const queue = list.slice();
  async function worker() {
    while (queue.length) {
      if (isCancelled && isCancelled()) return;
      const fqdn = queue.shift();
      if (fqdn === undefined) return;
      try {
        const { results } = await hunt(fqdn, null, scanTlds);
        ingest(fqdn, results);
      } catch (e) {
        // skip failed domain, keep going
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
    registrar: l.registrar,
    score: l.emails.size * 3 + l.yourDomains.size * 2 + l.lookalikeDomains.size
  }));

  leads.sort((a, b) => b.score - a.score);

  return { scanned: list.length, leads };
}

module.exports = { huntPortfolio, QUICK_TLDS };
