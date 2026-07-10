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

function contactsOf(r) {
  if (r.contacts && r.contacts.length) return r.contacts;
  // Fall back to legacy email/outreach fields.
  const list = (r.emails && r.emails.length ? r.emails : r.outreach) || [];
  return list.map((e) => ({ type: 'email', value: e, source: 'rdap', confidence: 0.9 }));
}

function countByType(rows) {
  const c = { email: 0, phone: 0, social: 0, total: 0 };
  for (const r of rows) {
    for (const ct of contactsOf(r)) {
      c.total += 1;
      if (c[ct.type] != null) c[ct.type] += 1;
    }
  }
  return c;
}

function renderSummary(rows) {
  const registered = rows.filter((r) => r.registered === true).length;
  const available = rows.filter((r) => r.registered === false).length;
  const c = countByType(rows);

  $('summary').innerHTML = `
    <div class="card good"><div class="n">${c.total}</div><div class="l">Total contacts</div></div>
    <div class="card"><div class="n">${c.email}</div><div class="l">Emails</div></div>
    <div class="card"><div class="n">${c.phone}</div><div class="l">Phone numbers</div></div>
    <div class="card"><div class="n">${c.social}</div><div class="l">Social channels</div></div>
    <div class="card"><div class="n">${registered}</div><div class="l">Registered look-alikes</div></div>
    <div class="card buy"><div class="n">${available}</div><div class="l">Available to buy</div></div>`;
  $('summary').classList.remove('hidden');
}

const CHANNEL_ICON = {
  linkedin: 'in', twitter: '𝕏', facebook: 'f', instagram: 'ig', youtube: '▶', github: 'gh'
};

function contactChips(contacts) {
  return contacts.map((c) => {
    const conf = Math.round((c.confidence || 0) * 100);
    if (c.type === 'email') {
      return `<a class="chip email" href="mailto:${esc(c.value)}" title="${esc(c.source)} · ${conf}%">${esc(c.value)}</a>`;
    }
    if (c.type === 'phone') {
      return `<a class="chip phone" href="tel:${esc(c.value)}" title="${esc(c.source)}">☎ ${esc(c.value)}</a>`;
    }
    if (c.type === 'social') {
      const icon = CHANNEL_ICON[c.channel] || '↗';
      return `<a class="chip social" href="${esc(c.value)}" target="_blank" rel="noopener" title="${esc(c.channel)} · ${esc(c.source)}">${icon} ${esc(c.channel)}</a>`;
    }
    return `<span class="chip">${esc(c.value)}</span>`;
  }).join('');
}

function renderRows(rows) {
  const body = $('resultsBody');
  body.innerHTML = '';
  rows.forEach((r, idx) => {
    const statusClass = r.registered === true ? 'registered' : r.registered === false ? 'available' : 'unknown';
    const statusLabel = r.registered === true ? 'Registered' : r.registered === false ? 'Available' : 'Unknown';
    const contacts = contactsOf(r);
    const owner = r.registered === false
      ? '<span class="muted">' + esc(r.note || 'Acquisition target') + '</span>'
      : esc(r.owner || (r.note || '—'));
    const sources = (r.sources || []).map((s) => `<span class="src">${esc(s)}</span>`).join('') || '<span class="muted">—</span>';
    const canExpand = contacts.length > 0;

    const tr = document.createElement('tr');
    tr.className = 'main-row';
    tr.innerHTML = `
      <td class="expander">${canExpand ? `<button class="exp" data-idx="${idx}" aria-label="Toggle contacts">▸</button>` : ''}</td>
      <td class="domain">${esc(r.domain)}</td>
      <td><span class="pill ${statusClass}">${statusLabel}</span></td>
      <td>${owner}</td>
      <td class="count"><span class="badge">${contacts.length}</span> contacts</td>
      <td class="sources">${sources}</td>`;
    body.appendChild(tr);

    if (canExpand) {
      const detail = document.createElement('tr');
      detail.className = 'detail-row hidden';
      detail.innerHTML = `<td></td><td colspan="5"><div class="chips">${contactChips(contacts)}</div></td>`;
      body.appendChild(detail);
    }
  });

  body.querySelectorAll('button.exp').forEach((btn) => {
    btn.addEventListener('click', () => {
      const detail = btn.closest('tr').nextElementSibling;
      if (!detail) return;
      const open = detail.classList.toggle('hidden');
      btn.textContent = open ? '▸' : '▾';
    });
  });

  $('resultsTable').classList.toggle('hidden', rows.length === 0);
  $('empty').classList.toggle('hidden', rows.length > 0);
}

function refreshExportButtons() {
  const has = currentRows.length > 0;
  $('exportCsv').disabled = !has;
  $('exportJson').disabled = !has;
  $('exportContacts').disabled = !has;
}

async function runHunt(query, { append = false } = {}) {
  if (!query || !query.trim()) return;
  setBusy(true);
  try {
    const enrich = $('deepMode').checked;
    const res = await window.api.hunt(query.trim(), { enrich });
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
window.api.onProgress(({ done, total, label }) => {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('barFill').style.width = pct + '%';
  $('progressText').textContent = `${label || 'Scanning'} — ${done}/${total}`;
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
$('exportContacts').addEventListener('click', async () => {
  const res = await window.api.exportResults(currentRows, 'contacts');
  if (res.ok) toast('Exported contacts to ' + res.filePath);
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
  const c = countByType(currentRows);
  toast(`Done — ${c.total} contacts across ${currentRows.length} records`);
});
