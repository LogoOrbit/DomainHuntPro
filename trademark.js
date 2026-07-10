'use strict';

// DomainHunt Pro — USPTO trademark lookup.
// Finds registered-trademark owners whose wordmark matches one of your
// domain names. These are among the highest-intent buyers: a brand with a
// live trademark often has a real business reason to want the exact domain.
//
// Uses the USPTO Open Data Portal (data.uspto.gov) with an `x-api-key`
// header. Get a free key at https://data.uspto.gov/apis/getting-started
//
// NOTE ON ENDPOINTS: the ODP exposes a key-validation/data-product endpoint
// that we use for `testKey()`. The wordmark *search* endpoint + response
// shape are configured below in ONE place (SEARCH) so they are trivial to
// adjust once validated against a live key. `searchTrademarks()` fails soft:
// on any error it returns [] so a portfolio scan is never blocked.

const https = require('https');

const API_HOST = 'api.uspto.gov';

// Endpoint used to confirm a key is valid (documented, known-good).
const TEST_PATH = '/api/v1/datasets/products/trtdxfap';

// Wordmark search configuration — kept in one object so the exact path,
// query params and response mapping can be tuned after a live test call.
const SEARCH = {
  path: '/api/v1/trademarks/search',
  // Build the full path (incl. querystring) for a given wordmark keyword.
  buildPath(keyword, { limit = 10 } = {}) {
    const qs = new URLSearchParams({ query: keyword, limit: String(limit) });
    return `${this.path}?${qs.toString()}`;
  },
  // Map a raw API response body to a normalized list of matches. Defensive:
  // tolerates several plausible field names so a schema tweak won't break it.
  mapResults(body) {
    const arr = Array.isArray(body) ? body
      : (body.results || body.trademarks || body.data || body.items || []);
    if (!Array.isArray(arr)) return [];
    return arr.map((t) => {
      const owners = t.owners || t.parties || [];
      const owner = owners[0] || {};
      return {
        wordmark: t.wordmark || t.markLiteralElements || t.mark || '',
        serial: t.serial_number || t.serialNumber || t.serial || '',
        status: t.status || t.markCurrentStatusExternalDescriptionText || '',
        owner: owner.name || owner.partyName || t.ownerName || '',
        entityType: owner.entity_type || owner.legalEntityTypeCategory || '',
        email: owner.email || owner.emailAddressText || ''
      };
    }).filter((m) => m.owner || m.wordmark);
  }
};

function apiGet(pathname, apiKey, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const req = https.get({
      host: API_HOST,
      path: pathname,
      headers: {
        'x-api-key': apiKey,
        'Accept': 'application/json',
        'User-Agent': 'DomainHuntPro/1.0'
      },
      timeout: timeoutMs
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        const { statusCode } = res;
        if (statusCode === 401 || statusCode === 403) {
          return resolve({ __status: statusCode, __error: 'auth' });
        }
        if (statusCode >= 400) return resolve({ __status: statusCode, __error: 'http' });
        try { resolve({ __status: statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ __status: statusCode, body: null, __error: 'parse' }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ __error: 'timeout' }); });
    req.on('error', () => resolve({ __error: 'network' }));
  });
}

// Validate an API key against a known-good endpoint. Returns { ok, ... }.
async function testKey(apiKey) {
  const r = await apiGet(TEST_PATH, apiKey);
  if (r.__error === 'auth') return { ok: false, error: 'Key rejected by USPTO (401/403). Double-check the key.' };
  if (r.__error === 'timeout') return { ok: false, error: 'USPTO request timed out — try again.' };
  if (r.__error === 'network') return { ok: false, error: 'Network error reaching USPTO.' };
  if (r.__status && r.__status >= 200 && r.__status < 300) return { ok: true, message: 'Key is valid ✓' };
  return { ok: false, error: `USPTO returned status ${r.__status || 'unknown'}` };
}

// Search trademarks by wordmark keyword. Fails soft (returns []).
async function searchTrademarks(keyword, apiKey, opts = {}) {
  if (!keyword || !apiKey) return [];
  const r = await apiGet(SEARCH.buildPath(keyword, opts), apiKey);
  if (r.__error || !r.body) return [];
  try { return SEARCH.mapResults(r.body); }
  catch (e) { return []; }
}

module.exports = { testKey, searchTrademarks, SEARCH };
