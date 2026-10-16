/* Tidemark frontend: vanilla JS, no build step. */
const KEY = 'tidemark.workspace';
let owner = localStorage.getItem(KEY);
if (!owner) { owner = crypto.randomUUID(); localStorage.setItem(KEY, owner); }

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api' + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-owner-key': owner },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return null;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast.id);
  toast.id = setTimeout(() => t.classList.remove('on'), 3200);
}

const fmtAgo = (ts) => {
  if (!ts) return 'never';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};
const fmtDate = (ts) => new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const everyLabel = (m) => (m < 60 ? `${m} min` : m % 60 ? `${m} min` : `${m / 60} h`);
const STATUS = {
  ok: 'Up to date', pending: 'Waiting for first check', error: 'Unreachable', blocked: 'Blocked by site',
  noisy: 'Changing constantly', paused: 'Paused',
};

/* ---------------- state ---------------- */
let monitors = [];
let current = null; // {id, snapshotId}
let detail = { snaps: [], from: null, to: null, tab: 'text' };

function route() {
  const [, , id, snap] = location.hash.split('/'); // #/m/<id>/<snap>
  current = id ? { id, snap: snap ? Number(snap) : null } : null;
  document.body.dataset.view = current ? 'detail' : 'list';
  renderRail();
  renderStage(true);
}
window.addEventListener('hashchange', route);

async function refresh() {
  try {
    monitors = await api('/monitors');
  } catch (e) { return; }
  renderRail();
  if (current && !$('dialog[open]')) renderStage(false);
}

/* ---------------- rail ---------------- */
function renderRail() {
  const attention = monitors.filter((m) => ['error', 'blocked', 'noisy'].includes(m.status)).length;
  $('#rail-sub').textContent = monitors.length
    ? `Watching ${monitors.length} page${monitors.length > 1 ? 's' : ''}${attention ? ` · ${attention} need attention` : ''}`
    : 'Nothing watched yet';
  $('#monitor-list').innerHTML = monitors.map((m) => {
    const fresh = m.status === 'ok' && m.last_changed && Date.now() - m.last_changed < 86_400_000;
    const sub = m.status === 'ok' ? (m.last_changed ? `Changed ${fmtAgo(m.last_changed)}` : 'No changes yet') : STATUS[m.status];
    return `<li><button class="mon" data-id="${m.id}" ${current?.id === m.id ? 'aria-current="true"' : ''}>
      <span class="dot ${fresh ? 'fresh' : m.status}"></span><b>${esc(m.name)}</b><small>${esc(sub)}</small></button></li>`;
  }).join('');
}
$('#monitor-list').addEventListener('click', (e) => {
  const b = e.target.closest('.mon');
  if (b) location.hash = `#/m/${b.dataset.id}`;
});
$('#add-btn').addEventListener('click', () => openForm());
$('#key-btn').addEventListener('click', () => {
  const next = prompt('Your workspace key (keep it private; it is how this browser finds your monitors).\nPaste a different key to open another workspace:', owner);
  if (next && next !== owner && /^[\w-]{16,64}$/.test(next.trim())) {
    localStorage.setItem(KEY, next.trim());
    location.hash = '';
    location.reload();
  }
});

/* ---------------- stage ---------------- */
function renderStage(full) {
  const stage = $('#stage');
  if (!current) {
    stage.innerHTML = monitors.length
      ? `<div class="empty"><h2>Pick a page on the left.</h2><p>You will see its status, its versions and what changed between them.</p></div>`
      : `<div class="empty">
          <svg class="tide-art" viewBox="0 0 180 90" aria-hidden="true"><g stroke="#17201C" stroke-width="2" stroke-linecap="round"><path d="M4 12h172"/><path d="M4 30h120" stroke="#2447D6" stroke-width="4"/><path d="M4 48h60"/><path d="M4 66h90"/><path d="M4 84h36"/></g></svg>
          <h2>Add the first page you want to keep an eye on.</h2>
          <p>Tidemark loads it in a real browser, ignores clocks, counters and ads, and tells you only when something meaningful changed.</p>
          <button class="btn primary" id="empty-add" type="button">Add a page</button></div>`;
    $('#empty-add')?.addEventListener('click', () => openForm());
    return;
  }
  const m = monitors.find((x) => x.id === current.id);
  if (!m) { stage.innerHTML = '<div class="empty"><h2>This monitor is gone.</h2></div>'; return; }
  if (full) detail = { snaps: [], from: null, to: null, tab: detail.tab };
  stage.innerHTML = `
    <a class="btn back" href="#/">Back to pages</a>
    <div class="head">
      <div>
        <h2>${esc(m.name)}</h2>
        <a class="url" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">${esc(m.url)}</a>
      </div>
      <div class="actions">
        <button class="btn small" data-act="check">Check now</button>
        <button class="btn small" data-act="edit">Edit</button>
        <button class="btn small" data-act="pause">${m.paused ? 'Resume' : 'Pause'}</button>
        <button class="btn small" data-act="feed">RSS feed</button>
        <button class="btn small danger" data-act="delete">Delete</button>
      </div>
    </div>
    <dl class="facts">
      <div><dt>Status</dt><dd><span class="pill ${m.status}"><span class="dot ${m.status}"></span>${STATUS[m.status]}</span></dd></div>
      <div><dt>Last checked</dt><dd>${fmtAgo(m.last_checked)}</dd></div>
      <div><dt>Last changed</dt><dd>${fmtAgo(m.last_changed)}</dd></div>
      <div><dt>Checks every</dt><dd>${everyLabel(m.interval_min)}</dd></div>
      <div><dt>Sensitivity</dt><dd>${m.sensitivity[0].toUpperCase() + m.sensitivity.slice(1)}</dd></div>
    </dl>
    ${m.last_error && m.status !== 'ok' ? `<div class="note ${m.status === 'error' ? 'bad' : ''}">${esc(m.last_error)}</div>` : ''}
    <div class="layout"><section aria-label="Versions"><p class="gauge-title">Versions, newest first. A longer tick means a bigger change.</p><ol class="gauge" id="gauge"></ol></section>
    <section id="viewer-slot"></section></div>`;
  stage.querySelector('.actions').addEventListener('click', (e) => onAction(e, m));
  loadSnaps(m);
}

async function onAction(e, m) {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  try {
    if (act === 'check') { await api(`/monitors/${m.id}/check`, { method: 'POST' }); toast('Check queued. It runs in a few seconds.'); setTimeout(refresh, 6000); }
    if (act === 'edit') openForm(m);
    if (act === 'pause') { await api(`/monitors/${m.id}`, { method: 'PATCH', body: { paused: !m.paused } }); await refresh(); }
    if (act === 'feed') { await navigator.clipboard?.writeText(`${location.origin}/feed/${m.id}.xml`); toast('RSS link copied.'); }
    if (act === 'delete' && confirm(`Delete “${m.name}” and all of its versions?`)) {
      await api(`/monitors/${m.id}`, { method: 'DELETE' });
      location.hash = '#/';
      await refresh();
    }
  } catch (err) { toast(err.message); }
}

async function loadSnaps(m) {
  try { detail.snaps = await api(`/monitors/${m.id}/snapshots`); } catch { return; }
  const s = detail.snaps;
  if (!detail.to || !s.some((x) => x.id === detail.to)) {
    detail.to = current.snap && s.some((x) => x.id === current.snap) ? current.snap : s[0]?.id ?? null;
    const idx = s.findIndex((x) => x.id === detail.to);
    detail.from = s[idx + 1]?.id ?? detail.to;
  }
  renderGauge();
  renderViewer(m);
}

function renderGauge() {
  const g = $('#gauge');
  if (!g) return;
  g.innerHTML = detail.snaps.length
    ? detail.snaps.map((s) => `<li class="${s.id === detail.to ? 'sel' : ''}" style="--mag:${Math.min(40, s.added + s.removed)}">
        <button data-snap="${s.id}"><time>${fmtDate(s.created_at)}</time>
        <span class="sum">${esc(s.summary || '')}</span>
        ${s.baseline ? '' : `<span class="delta"><span class="a">+${s.added}</span> <span class="d">−${s.removed}</span></span>`}</button></li>`).join('')
    : '<li><span class="sum">No versions yet. The first snapshot is saved after the first check.</span></li>';
  g.onclick = (e) => {
    const b = e.target.closest('[data-snap]');
    if (!b) return;
    const id = Number(b.dataset.snap);
    const i = detail.snaps.findIndex((x) => x.id === id);
    detail.to = id;
    detail.from = detail.snaps[i + 1]?.id ?? id;
    renderGauge();
    renderViewer(monitors.find((x) => x.id === current.id));
  };
}

async function renderViewer(m) {
  const slot = $('#viewer-slot');
  if (!slot) return;
  if (detail.snaps.length < 2) {
    slot.innerHTML = `<div class="viewer"><div class="vempty">${detail.snaps.length ? 'Only the first snapshot exists. When the page changes, the comparison appears here.' : 'Waiting for the first check.'}</div></div>`;
    return;
  }
  const opts = detail.snaps.map((s) => (id) => `<option value="${s.id}" ${s.id === id ? 'selected' : ''}>${esc(fmtDate(s.created_at))}</option>`);
  const sel = (name, id) => `<select data-cmp="${name}" aria-label="${name}">${opts.map((o) => o(id)).join('')}</select>`;
  slot.innerHTML = `<div class="viewer">
    <div class="vbar">
      <div class="tabs" role="tablist">
        ${[['text', 'Text changes'], ['hl', 'Highlighted'], ['side', 'Side by side']].map(([k, l]) => `<button class="tab" role="tab" data-tab="${k}" aria-selected="${detail.tab === k}">${l}</button>`).join('')}
      </div>
      <div class="cmp">Compare ${sel('from', detail.from)} with ${sel('to', detail.to)}</div>
    </div>
    <div class="vbody" id="vbody"><div class="vempty">Loading…</div></div></div>`;
  slot.querySelector('.tabs').onclick = (e) => { const t = e.target.closest('[data-tab]'); if (t) { detail.tab = t.dataset.tab; renderViewer(m); } };
  slot.querySelector('.cmp').onchange = (e) => { detail[e.target.dataset.cmp] = Number(e.target.value); renderGauge(); renderViewer(m); };

  const body = $('#vbody');
  const q = `from=${detail.from}&to=${detail.to}`;
  const shotUrl = (id) => { const s = detail.snaps.find((x) => x.id === id); return s?.shot ? `/shots/${s.shot}` : null; };
  if (detail.from === detail.to) { body.innerHTML = '<div class="vempty">Pick two different versions to compare.</div>'; return; }
  if (detail.tab === 'text') {
    try {
      const d = await api(`/monitors/${m.id}/diff?${q}`);
      body.innerHTML = d.rows.length ? `<div class="diff">${d.rows.map((r) => {
        if (r.t === 'gap') return `<div class="dl gap"><i></i><span>${esc(r.text)}</span></div>`;
        const sign = r.t === 'add' ? '+' : r.t === 'del' ? '−' : '';
        const txt = r.words ? r.words.map((w) => (w.hl ? `<mark>${esc(w.v)}</mark>` : esc(w.v))).join('') : esc(r.text);
        return `<div class="dl ${r.t}"><i>${sign}</i><span>${txt}</span></div>`;
      }).join('')}</div>` : '<div class="vempty">The text is identical.</div>';
    } catch (e) { body.innerHTML = `<div class="vempty">${esc(e.message)}</div>`; }
  } else if (detail.tab === 'hl') {
    if (!shotUrl(detail.from) || !shotUrl(detail.to)) { body.innerHTML = '<div class="vempty">One of these versions has no screenshot.</div>'; return; }
    body.innerHTML = `<div class="legend">Red marks pixels that differ. The rest of the page is faded.</div><img alt="Highlighted screenshot difference" src="/api/monitors/${m.id}/shotdiff?${q}&k=${owner}">`;
  } else {
    const a = shotUrl(detail.from), b = shotUrl(detail.to);
    body.innerHTML = a && b
      ? `<div class="shots"><figure><figcaption>Before · ${esc(fmtDate(detail.snaps.find((x) => x.id === detail.from).created_at))}</figcaption><img alt="Earlier screenshot" src="${a}"></figure>
         <figure><figcaption>After · ${esc(fmtDate(detail.snaps.find((x) => x.id === detail.to).created_at))}</figcaption><img alt="Later screenshot" src="${b}"></figure></div>`
      : '<div class="vempty">One of these versions has no screenshot.</div>';
  }
}

/* ---------------- add / edit form ---------------- */
const INTERVALS = [[15, 'Every 15 minutes'], [30, 'Every 30 minutes'], [60, 'Every hour'], [360, 'Every 6 hours'], [720, 'Every 12 hours'], [1440, 'Every 24 hours']];
let formSel = { watch: [], ignore: [] };

function openForm(m) {
  const dlg = $('#form-dlg');
  formSel = { watch: [...(m?.watch_selectors || [])], ignore: [...(m?.ignore_selectors || [])] };
  const v = m || { name: '', url: '', interval_min: 60, sensitivity: 'medium', keywords: [], email: '', telegram_chat: '', discord_webhook: '', digest: false };
  dlg.innerHTML = `<form method="dialog" id="mon-form" novalidate>
    <h2>${m ? 'Edit page' : 'Add a page'}</h2>
    <div class="row">
      <div class="field"><label for="f-name">Name</label><input id="f-name" type="text" required maxlength="80" value="${esc(v.name)}" placeholder="Competitor pricing"></div>
      <div class="field"><label for="f-int">Check</label><select id="f-int">${INTERVALS.map(([n, l]) => `<option value="${n}" ${n === v.interval_min ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label for="f-url">Page address<span class="hint">Public pages only. No logins are stored.</span></label><input id="f-url" type="url" required value="${esc(v.url)}" placeholder="https://example.com/pricing"></div>
    <div class="field"><label>How picky should it be?<span class="hint">Low waits for a bigger edit. High reports any text change.</span></label>
      <div class="seg" role="radiogroup">${['low', 'medium', 'high'].map((s) => `<label><input type="radio" name="sens" value="${s}" ${v.sensitivity === s ? 'checked' : ''}><span>${s[0].toUpperCase() + s.slice(1)}</span></label>`).join('')}</div></div>
    <details ${formSel.watch.length || formSel.ignore.length ? 'open' : ''}><summary>Watch or ignore parts of the page</summary>
      <div class="field"><button class="btn small" type="button" id="open-picker">Pick regions on the page</button>
        <span class="hint">Click parts of the page to watch them, or to ignore them. Leave empty to watch the whole page.</span>
        <div class="chips" id="chips"></div></div>
      <div class="field"><label for="f-ign">Extra CSS selectors to ignore<span class="hint">One per line.</span></label><textarea id="f-ign" spellcheck="false" placeholder=".live-chat&#10;#promo-banner"></textarea></div>
    </details>
    <details ${v.keywords.length ? 'open' : ''}><summary>Only alert on certain words</summary>
      <div class="field"><label for="f-kw">Keywords<span class="hint">Comma separated. Changes are still saved; you are alerted only when one of these words is added or removed.</span></label><input id="f-kw" type="text" value="${esc(v.keywords.join(', '))}" placeholder="out of stock, price, sale"></div></details>
    <details ${v.email || v.telegram_chat || v.discord_webhook ? 'open' : ''}><summary>Where to send alerts</summary>
      <div class="field"><label for="f-mail">Email</label><input id="f-mail" type="email" value="${esc(v.email)}"></div>
      <div class="row"><div class="field"><label for="f-tg">Telegram chat ID</label><input id="f-tg" type="text" value="${esc(v.telegram_chat)}"></div>
      <div class="field"><label for="f-dc">Discord webhook URL</label><input id="f-dc" type="text" value="${esc(v.discord_webhook)}"></div></div>
      <label style="font-weight:500"><input type="checkbox" id="f-dig" ${v.digest ? 'checked' : ''}> Send one daily digest instead of an alert per change</label></details>
    <p class="err" id="f-err" role="alert"></p>
    <div class="dfoot"><button class="btn" type="button" id="f-cancel">Cancel</button><button class="btn primary" id="f-save" type="submit">${m ? 'Save changes' : 'Start monitoring'}</button></div>
  </form>`;
  $('#f-ign').value = '';
  renderChips();
  dlg.showModal();
  $('#f-cancel').onclick = () => dlg.close();
  $('#open-picker').onclick = () => openPicker($('#f-url').value);
  $('#mon-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#f-save');
    btn.disabled = true;
    const typed = $('#f-ign').value.split('\n').map((x) => x.trim()).filter(Boolean);
    const body = {
      name: $('#f-name').value, url: $('#f-url').value, interval_min: Number($('#f-int').value),
      sensitivity: document.querySelector('input[name=sens]:checked').value,
      watch_selectors: formSel.watch, ignore_selectors: [...new Set([...formSel.ignore, ...typed])],
      keywords: $('#f-kw').value.split(',').map((x) => x.trim()).filter(Boolean),
      email: $('#f-mail').value, telegram_chat: $('#f-tg').value, discord_webhook: $('#f-dc').value, digest: $('#f-dig').checked,
    };
    try {
      const saved = await api(m ? `/monitors/${m.id}` : '/monitors', { method: m ? 'PATCH' : 'POST', body });
      dlg.close();
      await refresh();
      location.hash = `#/m/${saved.id}`;
      toast(m ? 'Saved.' : 'Added. The first snapshot is being captured.');
    } catch (err) { $('#f-err').textContent = err.message; btn.disabled = false; }
  };
}

function renderChips() {
  const c = $('#chips');
  if (!c) return;
  c.innerHTML = [...formSel.watch.map((s, i) => ['w', s, i]), ...formSel.ignore.map((s, i) => ['i', s, i])]
    .map(([k, s, i]) => `<span class="chip ${k}" title="${k === 'w' ? 'Watching' : 'Ignoring'}">${k === 'w' ? 'watch' : 'ignore'}: ${esc(s)}<button type="button" aria-label="Remove ${esc(s)}" data-k="${k}" data-i="${i}">×</button></span>`).join('');
  c.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    formSel[b.dataset.k === 'w' ? 'watch' : 'ignore'].splice(Number(b.dataset.i), 1);
    renderChips();
  };
}

/* ---------------- visual picker ---------------- */
async function openPicker(url) {
  const dlg = $('#picker-dlg');
  if (!url) { $('#f-err').textContent = 'Enter the page address first.'; return; }
  dlg.innerHTML = `<div class="box"><h2>Pick regions</h2><p>Loading the page in a browser. This takes a few seconds…</p></div>`;
  dlg.showModal();
  let scan;
  try { scan = await api('/picker', { method: 'POST', body: { url } }); }
  catch (e) { dlg.innerHTML = `<div class="box"><h2>Pick regions</h2><p class="err">${esc(e.message)}</p><div class="dfoot"><button class="btn" id="p-close">Close</button></div></div>`; $('#p-close').onclick = () => dlg.close(); return; }

  dlg.innerHTML = `<div class="box"><h2>Pick regions</h2>
    <div class="pickbar">
      <div class="seg" role="radiogroup" aria-label="What a click does">
        <label><input type="radio" name="pmode" value="watch" checked><span>Watch this</span></label>
        <label><input type="radio" name="pmode" value="ignore"><span>Ignore this</span></label></div>
      <span class="hint" style="margin:0">Hover to preview, click to add. Click an added region again in the list below to remove it.</span>
    </div>
    <div class="pickwrap" id="pw"><img id="pimg" alt="Screenshot of the page" src="${scan.image}"><div class="hl" id="hl" hidden></div></div>
    <div class="chips" id="pchips"></div>
    <div class="dfoot"><button class="btn primary" id="p-done">Done</button></div></div>`;
  const img = $('#pimg'), hl = $('#hl');
  const mode = () => document.querySelector('input[name=pmode]:checked').value;
  const scale = () => img.clientWidth / scan.width;
  const hit = (ev) => {
    const r = img.getBoundingClientRect(), k = scale();
    const x = (ev.clientX - r.left) / k, y = (ev.clientY - r.top) / k;
    let best = null;
    for (const el of scan.elements) {
      if (x >= el.x && x <= el.x + el.w && y >= el.y && y <= el.y + el.h && (!best || el.w * el.h < best.w * best.h)) best = el;
    }
    return best;
  };
  const draw = (el) => {
    if (!el) { hl.hidden = true; return; }
    const k = scale();
    Object.assign(hl.style, { left: el.x * k + 'px', top: el.y * k + 'px', width: el.w * k + 'px', height: el.h * k + 'px' });
    hl.className = 'hl' + (mode() === 'ignore' ? ' ign' : '');
    hl.hidden = false;
  };
  img.addEventListener('mousemove', (e) => draw(hit(e)));
  img.addEventListener('mouseleave', () => draw(null));
  img.addEventListener('click', (e) => {
    const el = hit(e);
    if (!el) return;
    const list = mode() === 'watch' ? formSel.watch : formSel.ignore;
    if (!list.includes(el.sel)) list.push(el.sel);
    pchips();
  });
  const pchips = () => {
    const rows = [...formSel.watch.map((s, i) => ['w', s, i]), ...formSel.ignore.map((s, i) => ['i', s, i])];
    $('#pchips').innerHTML = rows.map(([k, s, i]) => `<span class="chip ${k}">${k === 'w' ? 'watch' : 'ignore'}: ${esc(s)}<button type="button" data-k="${k}" data-i="${i}" aria-label="Remove">×</button></span>`).join('') || '<span class="hint">Nothing selected yet.</span>';
  };
  $('#pchips').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    formSel[b.dataset.k === 'w' ? 'watch' : 'ignore'].splice(Number(b.dataset.i), 1);
    pchips();
  };
  pchips();
  $('#p-done').onclick = () => { dlg.close(); renderChips(); };
}

/* ---------------- boot ---------------- */
await refresh();
route();
setInterval(refresh, 15000);
