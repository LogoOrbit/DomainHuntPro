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
  const buyers = rows.length;
  const verified = rows.filter((r) => r.verifiedEmails > 0).length;
  const avg = buyers ? Math.round(rows.reduce((n, r) => n + (r.score || 0), 0) / buyers) : 0;
  const top = rows[0];

  $('summary').innerHTML = `
    <div class="card good"><div class="n">${buyers}</div><div class="l">Potential buyers</div></div>
    <div class="card good"><div class="n">${verified}</div><div class="l">With verified contact</div></div>
    <div class="card"><div class="n">${avg}</div><div class="l">Average match score</div></div>
    <div class="card buy"><div class="n">${top ? esc(top.score) : '—'}</div><div class="l">${top ? 'Top: ' + esc(top.owner !== '(redacted)' ? top.owner : top.domain) : 'Top opportunity'}</div></div>`;
  $('summary').classList.remove('hidden');
}

function confidenceClass(c) {
  return c === 'Verified' ? 'registered' : c === 'Likely Valid' ? 'likely' : 'unknown';
}

function scoreClass(s) {
  return s >= 90 ? 'registered' : s >= 75 ? 'likely' : 'unknown';
}

function renderRows(rows) {
  const body = $('resultsBody');
  body.innerHTML = '';
  rows.forEach((r, i) => {
    const company = r.owner && r.owner !== '(redacted)'
      ? esc(r.owner)
      : '<span class="muted">Unnamed (registry-redacted) — see contacts</span>';
    const contacts = (r.contacts || []).slice(0, 3).map((c) =>
      `<div><a href="mailto:${esc(c.email)}">${esc(c.email)}</a>
        <span class="pill sm ${confidenceClass(c.confidence)}">${esc(c.confidence)}</span>
        <span class="muted sm">${esc(c.label)}</span></div>`).join('') || '<span class="muted">—</span>';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="domain">${company}</td>
      <td class="emails">${contacts}</td>
      <td><span class="pill ${scoreClass(r.score)}">${r.score}</span><div class="muted sm">${esc(r.tier)}</div></td>
      <td><a href="${esc(r.website)}" target="_blank" rel="noopener">${esc(r.domain)}</a></td>
      <td><button class="ghost sm" data-detail="${i}">Why + outreach ▾</button></td>`;
    body.appendChild(tr);

    const dr = document.createElement('tr');
    dr.className = 'detail hidden';
    dr.innerHTML = `<td colspan="5">
      <p><b>Why this score (${r.score} — ${esc(r.tier)}):</b></p>
      <ul>${(r.scoreDetail?.reasons || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <p><b>AI recommendation:</b> ${esc(r.recommendation)}</p>
      <details><summary>Cold email</summary><pre>${esc(r.outreach?.coldEmail)}</pre></details>
      <details><summary>LinkedIn message</summary><pre>${esc(r.outreach?.linkedin)}</pre></details>
      <details><summary>Follow-up email</summary><pre>${esc(r.outreach?.followUp1)}</pre></details>
      <details><summary>Second follow-up</summary><pre>${esc(r.outreach?.followUp2)}</pre></details>
    </td>`;
    body.appendChild(dr);

    tr.querySelector('button[data-detail]').addEventListener('click', () => dr.classList.toggle('hidden'));
  });
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
      currentRows.sort((a, b) => (b.score || 0) - (a.score || 0));
    } else {
      currentRows = res.results;
    }
    renderSummary(currentRows);
    renderRows(currentRows);
    refreshExportButtons();
    if (!append && !currentRows.length) toast('No active companies found on look-alike domains for this name.');
  } finally {
    setBusy(false);
  }
}

// --- Events -----------------------------------------------------------------
window.api.onProgress(({ done, total }) => {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('barFill').style.width = pct + '%';
  $('progressText').textContent = `Scanning ${done}/${total} look-alike domains`;
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
  toast(`Imported ${res.items.length} domain(s) — hunting buyers…`);
  currentRows = [];
  for (const item of res.items) {
    await runHunt(item, { append: true });
  }
  toast(`Done — ${currentRows.length} prospects for ${res.items.length} owned domain(s)`);
});
