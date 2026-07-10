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
