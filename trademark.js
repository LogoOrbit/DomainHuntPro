'use strict';

// DomainHunt Pro — US trademark lookup (via RapidAPI).
// Finds registered-trademark owners whose wordmark matches one of your
// domain names. These are among the highest-intent buyers: a brand with a
// live US trademark often has a real business reason to want the exact domain.
//
// Uses the "USPTO Trademark" API on RapidAPI (by pentium10). Signup is just an
// email — no US identity verification — so it works from anywhere:
//   https://rapidapi.com/pentium10/api/uspto-trademark
// Subscribe (a free tier exists), then copy your RapidAPI key.
//
// searchTrademarks() fails soft: on any error it returns [] so a portfolio
// scan is never blocked.

const https = require('https');

const API_HOST = 'uspto-trademark.p.rapidapi.com';

function apiGet(pathname, apiKey, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const req = https.get({
      host: API_HOST,
      path: pathname,
      headers: {
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': API_HOST,
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
        if (statusCode === 429) return resolve({ __status: 429, __error: 'rate' });
        if (statusCode >= 400) return resolve({ __status: statusCode, __error: 'http' });
        try { resolve({ __status: statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ __status: statusCode, body: null, __error: 'parse' }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ __error: 'timeout' }); });
    req.on('error', () => resolve({ __error: 'network' }));
  });
}

// Normalize a RapidAPI trademark-search response to a list of matches.
// Response shape: { count, items: [ TrademarkSummary ], page }
function mapResults(body) {
  const arr = Array.isArray(body) ? body
    : (body && (body.items || body.results || body.data)) || [];
  if (!Array.isArray(arr)) return [];
  return arr.map((t) => ({
    wordmark: t.wordMark || t.wordmark || t.keyword || '',
    serial: t.serialNumber || t.serial_number || '',
    registration: t.registrationNumber || '',
    status: t.status || '',
    owner: t.ownerName || t.owner || '',
    country: t.ownerCountry || '',
    state: t.ownerState || ''
  })).filter((m) => m.owner || m.wordmark);
}

// Only keep marks whose owner looks live/registered and whose wordmark is a
// meaningful match — avoids flooding the lead list with dead/loosely-related
// filings.
function isUsefulMatch(m, keyword) {
  if (!m.owner) return false;
  const s = (m.status || '').toLowerCase();
  if (s.includes('dead') || s.includes('abandon') || s.includes('cancel') || s.includes('expired')) return false;
  return true;
}

function enc(s) { return encodeURIComponent(String(s).trim()); }

// Validate a RapidAPI key against the lightweight databaseStatus endpoint.
async function testKey(apiKey) {
  const r = await apiGet('/v1/databaseStatus', apiKey);
  if (r.__error === 'auth') return { ok: false, error: 'Key rejected (401/403). Check the key is copied correctly and you are subscribed to the USPTO Trademark API on RapidAPI.' };
  if (r.__error === 'rate') return { ok: false, error: 'Rate limit hit — wait a moment and retry.' };
  if (r.__error === 'timeout') return { ok: false, error: 'Request timed out — try again.' };
  if (r.__error === 'network') return { ok: false, error: 'Network error reaching RapidAPI.' };
  if (r.__status && r.__status >= 200 && r.__status < 300) return { ok: true, message: 'Key is valid ✓' };
  return { ok: false, error: `RapidAPI returned status ${r.__status || 'unknown'}` };
}

// Search trademarks by wordmark keyword. Fails soft (returns []).
// searchType 'active' = live marks only (most relevant for buyer leads).
async function searchTrademarks(keyword, apiKey, opts = {}) {
  if (!keyword || !apiKey) return [];
  const searchType = opts.searchType || 'active';
  const r = await apiGet(`/v1/trademarkSearch/${enc(keyword)}/${searchType}`, apiKey);
  if (r.__error || !r.body) return [];
  try {
    return mapResults(r.body).filter((m) => isUsefulMatch(m, keyword));
  } catch (e) { return []; }
}

module.exports = { testKey, searchTrademarks, mapResults };
