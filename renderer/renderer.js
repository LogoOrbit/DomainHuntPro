'use strict';

const $ = (id) => document.getElementById(id);
let currentRows = [];

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

function setBusy(busy) {
  $('huntBtn').disabled = busy;
  $('query').disabled = busy;
  $('progress').classList.toggle('hidden', !busy);
  if (busy) { $('barFill').style.width = '0%'; $('progressText').textContent = 'Scanning…'; }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

function renderSummary(rows) {
  const registered = rows.filter((r) => r.registered === true).length;
  const available = rows.filter((r) => r.registered === false).length;
  const withEmail = rows.filter((r) => r.emails && r.emails.length).length;
  const leads = rows.reduce((n, r) => n + ((r.emails && r.emails.length) || (r.outreach && r.outreach.length) || 0), 0);

  $('summary').innerHTML = `
    <div class="card good"><div class="n">${withEmail}</div><div class="l">Brands with contacts</div></div>
    <div class="card"><div class="n">${registered}</div><div class="l">Registered look-alikes</div></div>
    <div class="card buy"><div class="n">${available}</div><div class="l">Available to buy</div></div>
    <div class="card"><div class="n">${leads}</div><div class="l">Contact leads</div></div>`;
  $('summary').classList.remove('hidden');
}

function renderRows(rows) {
  const body = $('resultsBody');
  body.innerHTML = '';
  for (const r of rows) {
    const statusClass = r.registered === true ? 'registered' : r.registered === false ? 'available' : 'unknown';
    const statusLabel = r.registered === true ? 'Registered' : r.registered === false ? 'Available' : 'Unknown';
    const contacts = (r.emails && r.emails.length ? r.emails : r.outreach) || [];
    const emailHtml = contacts.length
      ? contacts.map((e) => `<a href="mailto:${esc(e)}">${esc(e)}</a>`).join('')
      : '<span class="muted">—</span>';
    const owner = r.registered === false
      ? '<span class="muted">' + esc(r.note || 'Acquisition target') + '</span>'
      : esc(r.owner || (r.note || '—'));

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="domain">${esc(r.domain)}</td>
      <td><span class="pill ${statusClass}">${statusLabel}</span></td>
      <td>${owner}</td>
      <td class="emails">${emailHtml}</td>
      <td class="muted">${esc(r.registrar || '—')}</td>`;
    body.appendChild(tr);
  }
  $('resultsTable').classList.toggle('hidden', rows.length === 0);
  $('empty').classList.toggle('hidden', rows.length > 0);
}

function refreshExportButtons() {
  const has = currentRows.length > 0;
  $('exportCsv').disabled = !has;
  $('exportJson').disabled = !has;
}

async function runHunt(query, { append = false } = {}) {
  if (!query || !query.trim()) return;
  setBusy(true);
  try {
    const res = await window.api.hunt(query.trim());
    if (!res.ok) { toast('Error: ' + res.error); return; }
    if (append) {
      const seen = new Set(currentRows.map((r) => r.domain));
      currentRows = currentRows.concat(res.results.filter((r) => !seen.has(r.domain)));
    } else {
      currentRows = res.results;
    }
    renderSummary(currentRows);
    renderRows(currentRows);
    refreshExportButtons();
  } finally {
    setBusy(false);
  }
}

// --- Events -----------------------------------------------------------------
window.api.onProgress(({ done, total }) => {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('barFill').style.width = pct + '%';
  $('progressText').textContent = `Scanning ${done}/${total}`;
});

$('searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  runHunt($('query').value);
});

$('exportCsv').addEventListener('click', async () => {
  const res = await window.api.exportResults(currentRows, 'csv');
  if (res.ok) toast('Exported to ' + res.filePath);
});
$('exportJson').addEventListener('click', async () => {
  const res = await window.api.exportResults(currentRows, 'json');
  if (res.ok) toast('Exported to ' + res.filePath);
});

$('importBtn').addEventListener('click', async () => {
  const res = await window.api.importFile();
  if (!res.ok) { if (!res.canceled) toast(res.error || 'Import failed'); return; }
  if (!res.items.length) { toast('No domains found in file'); return; }
  toast(`Imported ${res.items.length} domain(s) — hunting…`);
  currentRows = [];
  for (const item of res.items) {
    await runHunt(item, { append: true });
  }
  toast(`Done — ${currentRows.length} records for ${res.items.length} imported domain(s)`);
});

// --- Portfolio Leads tab -----------------------------------------------------
let portfolioDomains = [];
let currentLeads = [];
let portfolioBusy = false;

$('tabSingle').addEventListener('click', () => {
  $('tabSingle').classList.add('active');
  $('tabPortfolio').classList.remove('active');
  $('singleView').classList.remove('hidden');
  $('portfolioView').classList.add('hidden');
  $('singleTools').classList.remove('hidden');
});
$('tabPortfolio').addEventListener('click', () => {
  $('tabPortfolio').classList.add('active');
  $('tabSingle').classList.remove('active');
  $('portfolioView').classList.remove('hidden');
  $('singleView').classList.add('hidden');
  $('singleTools').classList.add('hidden');
});

// USPTO API key settings
(async function loadSettings() {
  try {
    const s = await window.api.getSettings();
    if (s && s.usptoApiKey) $('usptoKey').value = s.usptoApiKey;
  } catch (e) { /* ignore */ }
})();

$('usptoSaveBtn').addEventListener('click', async () => {
  const key = $('usptoKey').value.trim();
  const res = await window.api.saveSettings({ usptoApiKey: key });
  $('usptoStatus').textContent = res.ok ? 'Saved ✓' : 'Save failed';
  if (res.ok) toast(key ? 'USPTO key saved' : 'USPTO key cleared');
});

$('usptoTestBtn').addEventListener('click', async () => {
  const key = $('usptoKey').value.trim();
  if (!key) { $('usptoStatus').textContent = 'Enter a key first'; return; }
  $('usptoStatus').textContent = 'Testing…';
  const res = await window.api.testUsptoKey(key);
  $('usptoStatus').textContent = res.ok ? (res.message || 'Valid ✓') : (res.error || 'Failed');
});

$('portfolioImportBtn').addEventListener('click', async () => {
  const res = await window.api.importFile();
  if (!res.ok) { if (!res.canceled) toast(res.error || 'Import failed'); return; }
  if (!res.items.length) { toast('No domains found in file'); return; }
  portfolioDomains = res.items;
  $('portfolioCount').textContent = `${portfolioDomains.length} domain(s) loaded`;
  $('portfolioRunBtn').disabled = false;
  toast(`Loaded ${portfolioDomains.length} domain(s) from ${res.filePath}`);
});

function setPortfolioBusy(busy) {
  portfolioBusy = busy;
  $('portfolioRunBtn').disabled = busy || !portfolioDomains.length;
  $('portfolioImportBtn').disabled = busy;
  $('portfolioScope').disabled = busy;
  $('portfolioCancelBtn').classList.toggle('hidden', !busy);
  $('portfolioProgress').classList.toggle('hidden', !busy);
  if (busy) { $('portfolioBarFill').style.width = '0%'; $('portfolioProgressText').textContent = 'Scanning…'; }
}

function renderLeadsSummary(leads) {
  const withEmail = leads.filter((l) => l.emails.length).length;
  const total = leads.length;
  const multi = leads.filter((l) => l.yourDomains.length > 1).length;
  $('portfolioSummary').innerHTML = `
    <div class="card good"><div class="n">${withEmail}</div><div class="l">Leads with direct email</div></div>
    <div class="card"><div class="n">${total}</div><div class="l">Total leads found</div></div>
    <div class="card buy"><div class="n">${multi}</div><div class="l">Interested in 2+ of your domains</div></div>`;
  $('portfolioSummary').classList.remove('hidden');
}

function renderLeadsRows(leads) {
  const body = $('leadsBody');
  body.innerHTML = '';
  for (const l of leads) {
    const contacts = (l.emails.length ? l.emails : l.outreach) || [];
    const emailHtml = contacts.length
      ? contacts.map((e) => `<a href="mailto:${esc(e)}">${esc(e)}</a>`).join('')
      : '<span class="muted">—</span>';
    const sources = (l.sources || []);
    const srcHtml = sources.map((s) => {
      const cls = s === 'trademark' ? 'src-tm' : 'src-rdap';
      const label = s === 'trademark' ? 'Trademark' : 'Domain';
      return `<span class="pill ${cls}">${label}</span>`;
    }).join(' ') || '<span class="muted">—</span>';
    const seen = (l.trademarks && l.trademarks.length ? l.trademarks : (l.lookalikeDomains || []));
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${l.score}</td>
      <td>${esc(l.org)}</td>
      <td>${srcHtml}</td>
      <td class="emails">${emailHtml}</td>
      <td class="muted">${esc((l.yourDomains || []).join(', '))}</td>
      <td class="muted">${esc(seen.join(', '))}</td>`;
    body.appendChild(tr);
  }
  $('leadsTable').classList.toggle('hidden', leads.length === 0);
  $('leadsEmpty').classList.toggle('hidden', leads.length > 0);
  $('leadsExportCsv').disabled = leads.length === 0;
  $('leadsExportJson').disabled = leads.length === 0;
}

window.api.onPortfolioProgress(({ done, total }) => {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('portfolioBarFill').style.width = pct + '%';
  $('portfolioProgressText').textContent = `Scanned ${done}/${total} domains`;
});

$('portfolioRunBtn').addEventListener('click', async () => {
  if (!portfolioDomains.length) return;
  setPortfolioBusy(true);
  try {
    const scope = $('portfolioScope').value;
    const res = await window.api.runPortfolio(portfolioDomains, scope);
    if (!res.ok) { toast('Error: ' + res.error); return; }
    currentLeads = res.leads;
    renderLeadsSummary(currentLeads);
    renderLeadsRows(currentLeads);
    toast(res.cancelled
      ? `Cancelled — ${currentLeads.length} lead(s) found so far`
      : `Done — ${currentLeads.length} lead(s) found across ${res.scanned} domain(s)`);
  } finally {
    setPortfolioBusy(false);
  }
});

$('portfolioCancelBtn').addEventListener('click', async () => {
  await window.api.cancelPortfolio();
  toast('Cancelling…');
});

$('leadsExportCsv').addEventListener('click', async () => {
  const res = await window.api.exportResults(currentLeads, 'csv', 'leads');
  if (res.ok) toast('Exported to ' + res.filePath);
});
$('leadsExportJson').addEventListener('click', async () => {
  const res = await window.api.exportResults(currentLeads, 'json', 'leads');
  if (res.ok) toast('Exported to ' + res.filePath);
});
