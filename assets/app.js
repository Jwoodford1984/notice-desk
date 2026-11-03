// Notice Desk web app. Plain ES modules, no build step.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ---------------------------------------------------------------- helpers */
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayIso = () => new Date().toISOString().slice(0, 10);
const fmtDate = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const daysTo = d => d ? Math.round((new Date(d + 'T00:00:00') - new Date(todayIso() + 'T00:00:00')) / 86400000) : null;
const daysChip = d => { const n = daysTo(d); if (n === null) return ''; const t = n < 0 ? `${-n}d ago` : n === 0 ? 'today' : `in ${n}d`; return `<span class="days ${n >= 0 && n <= 10 ? 'soon' : ''}">${t}</span>`; };
const uniq = a => [...new Set(a)];
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3200); }

const STATUS = { new: 'New', awaiting_file: 'Awaiting file', matched: 'Matched', in_review: 'In review', actioned: 'Actioned', not_relevant: 'Not relevant' };
const STATUS_CLS = { new: 'p-new', awaiting_file: 'p-await', matched: 'p-match', in_review: 'p-review', actioned: 'p-done', not_relevant: 'p-nr' };
const ACTION = { open: 'Open', in_progress: 'In progress', done: 'Done' };
const pill = s => `<span class="pill ${STATUS_CLS[s] || ''}">${esc(STATUS[s] || s)}</span>`;
const SOURCE_KINDS = {
  lseg_usage: ['LSEG usage', 'DACS · Usage Detail by User'],
  lseg_permissions: ['LSEG permissions', 'DACS · Active Permission by Exchange'],
  bpipe_usage: ['Bloomberg B-PIPE usage', 'B-PIPE / EMRS usage export'],
};

/** Unwrap a Supabase response, throwing a readable error. */
async function q(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }
/** Call an Edge Function and surface its { error } message on failure. */
async function fn(name, body) {
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) { let msg = error.message; try { const b = await error.context.json(); msg = b.error || msg; } catch { /* not JSON */ } throw new Error(msg); }
  return data;
}
async function upload(bucket, path, file) {
  const { error } = await sb.storage.from(bucket).upload(path, file, { upsert: false });
  if (error) throw new Error(`Upload failed: ${error.message}`);
}
const safeName = n => n.replace(/[^A-Za-z0-9._-]+/g, '_');

/* ------------------------------------------------------------------ state */
const S = { session: null, tenants: [], tenantId: null, role: null, filter: 'affects', source: 'all', q: '', tab: {}, emailFor: null, showNew: false };
const isAppLogin = l => /(_prd|_prod|_uat|_tst|_test|_dev|_gtu)$|^(rtds|murex|bpipe|svc)_/i.test(l);

/* ------------------------------------------------------------------- boot */
// Re-boot only on real sign-in / sign-out. Supabase calls must not run inside this callback, hence setTimeout.
sb.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') { S.session = null; S.tenantId = null; setTimeout(boot, 0); }
  else if (event === 'SIGNED_IN' && !S.session) { S.session = session; setTimeout(boot, 0); }
});
window.addEventListener('hashchange', () => { S.emailFor = null; route(); window.scrollTo(0, 0); });

async function boot() {
  const { data } = await sb.auth.getSession();
  S.session = data.session;
  if (!S.session) return renderAuth();
  try {
    S.tenants = await q(sb.from('tenant_members').select('role, tenants(id, name, slug)').eq('user_id', S.session.user.id));
  } catch (e) { return renderFatal(e); }
  if (!S.tenants.length) return renderNoWorkspace();
  const saved = store.get('nd.tenant');
  const pick = S.tenants.find(t => t.tenants.id === saved) || S.tenants[0];
  S.tenantId = pick.tenants.id; S.role = pick.role;
  renderShell(); route();
}

function renderFatal(e) {
  $('#root').innerHTML = `<div class="auth"><section class="panel"><h1>Something went wrong</h1><div class="err">${esc(e.message)}</div><button class="btn" onclick="location.reload()">Reload</button></section></div>`;
}

/* ------------------------------------------------------------------- auth */
function renderAuth(msg = '') {
  $('#root').innerHTML = `<div class="auth"><section class="panel">
    <div><h1>Notice Desk</h1><p class="sub">Market data change notifications. Sign in to your workspace.</p></div>
    ${msg ? `<div class="err">${esc(msg)}</div>` : ''}
    <form class="form" id="signin" style="grid-template-columns:minmax(0,1fr)">
      <label>Email<input class="txt" id="si-email" type="email" autocomplete="username" required></label>
      <label>Password<input class="txt" id="si-pass" type="password" autocomplete="current-password"></label>
      <div class="row"><button class="btn primary" type="submit">Sign in</button><button class="btn" type="button" id="si-link">Email me a sign-in link</button></div>
    </form>
    <p class="muted" style="margin:0;font-size:12px">Accounts are created by your workspace admin in Supabase.</p>
  </section></div>`;
  $('#signin').addEventListener('submit', async e => {
    e.preventDefault();
    const { error } = await sb.auth.signInWithPassword({ email: $('#si-email').value.trim(), password: $('#si-pass').value });
    if (error) renderAuth(error.message === 'Invalid login credentials' ? 'That email and password don\'t match. Check them, or use a sign-in link.' : error.message);
  });
  $('#si-link').addEventListener('click', async () => {
    const email = $('#si-email').value.trim(); if (!email) return toast('Enter your email first');
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href.split('#')[0], shouldCreateUser: false } });
    toast(error ? error.message : `Sign-in link sent to ${email}`);
  });
}

function renderNoWorkspace() {
  $('#root').innerHTML = `<div class="auth"><section class="panel">
    <div><h1>Create a workspace</h1><p class="sub">You're signed in as ${esc(S.session.user.email)} but aren't a member of a workspace yet. Create one for a client, or ask an admin to add you.</p></div>
    <form class="form" id="ws" style="grid-template-columns:minmax(0,1fr)">
      <label>Workspace name<input class="txt" id="ws-name" required placeholder="Client name"></label>
      <label>Short name (letters, numbers, hyphens)<input class="txt mono" id="ws-slug" required pattern="[a-z0-9-]+" placeholder="client-name"></label>
      <div class="row"><button class="btn primary" type="submit">Create workspace</button><button class="btn" type="button" id="so">Sign out</button></div>
    </form></section></div>`;
  $('#ws-name').addEventListener('input', e => { $('#ws-slug').value = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); });
  $('#ws').addEventListener('submit', async e => {
    e.preventDefault();
    try { await q(sb.rpc('create_tenant', { p_name: $('#ws-name').value.trim(), p_slug: $('#ws-slug').value.trim() })); boot(); }
    catch (err) { toast(err.message); }
  });
  $('#so').addEventListener('click', () => sb.auth.signOut());
}

/* ------------------------------------------------------------------ shell */
function renderShell() {
  $('#root').innerHTML = `<div class="shell">
    <aside class="rail">
      <div class="brand"><b>Notice Desk</b><span>Market data change notifications</span></div>
      <nav class="nav" id="nav"></nav>
      <div class="tenant">
        <span>Workspace</span>
        ${S.tenants.length > 1 ? `<select class="ws-switch" id="ws-switch" aria-label="Workspace">${S.tenants.map(t => `<option value="${t.tenants.id}" ${t.tenants.id === S.tenantId ? 'selected' : ''}>${esc(t.tenants.name)}</option>`).join('')}</select>` : `<b>${esc(S.tenants[0].tenants.name)}</b>`}
        <span>${esc(S.session.user.email)} · ${esc(S.role)}</span>
        <button class="linkbtn" id="signout">Sign out</button>
      </div>
    </aside>
    <main><div class="wrap" id="view"></div></main>
  </div>`;
  $('#signout').addEventListener('click', () => sb.auth.signOut());
  $('#ws-switch')?.addEventListener('change', e => { store.set('nd.tenant', e.target.value); boot(); });
}
function renderNav(counts = {}) {
  const r = (location.hash || '#dashboard').slice(1); const cur = r.startsWith('notice-') ? 'notices' : r;
  const items = [['dashboard', 'Dashboard'], ['notices', 'Notices', counts.notices], ['actions', 'Actions', counts.actions], ['sources', 'Data sources'], ['applications', 'Applications']];
  const nav = $('#nav'); if (!nav) return;
  nav.innerHTML = items.map(([k, l, c]) => `<a href="#${k}" class="${cur === k ? 'on' : ''}">${l}${c != null ? `<span class="count">${c}</span>` : ''}</a>`).join('');
}
let routeSeq = 0;
async function route() {
  if (!S.tenantId) return;
  const seq = ++routeSeq;
  const r = (location.hash || '#dashboard').slice(1);
  renderNav(S.counts);
  $('#view').innerHTML = '<p class="loading"><span class="spin"></span> Loading…</p>';
  try {
    let html;
    if (r.startsWith('notice-')) html = await vNotice(r.slice(7));
    else html = await ({ dashboard: vDashboard, notices: vNotices, actions: vActions, sources: vSources, applications: vApps }[r] || vDashboard)();
    if (seq !== routeSeq) return;
    $('#view').innerHTML = html; renderNav(S.counts); wire();
  } catch (e) {
    if (seq !== routeSeq) return;
    $('#view').innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}

/* ------------------------------------------------------------ data access */
async function loadNotices() {
  const [impact, notices, acts] = await Promise.all([
    q(sb.from('notice_impact').select('*').eq('tenant_id', S.tenantId)),
    q(sb.from('notices').select('id, ref, vendor, title, change_type, kind, status, effective_date, requires_file, source, service_codes').eq('tenant_id', S.tenantId)),
    q(sb.from('actions').select('id, status, due_date, notice_id').eq('tenant_id', S.tenantId).neq('status', 'done')),
  ]);
  const im = new Map(impact.map(i => [i.notice_id, i]));
  const list = notices.map(n => ({ ...n, ...(im.get(n.id) || {}), id: n.id }));
  list.forEach(n => {
    n.inUse = (n.used_direct || 0) + (n.used_via_chain || 0);
    n.affects = n.inUse > 0 || (n.logins_permissioned || 0) > 0 || (n.requires_file && !n.current_file_id);
    n.open = !['actioned', 'not_relevant'].includes(n.status);
  });
  S.counts = { notices: list.filter(n => n.open && n.affects).length, actions: acts.length };
  return { list, acts };
}
function impactText(n) {
  if (n.requires_file && !n.current_file_id) return ['Awaiting instrument file', 'muted'];
  if (n.current_file_id) return [`${n.inUse} of ${n.instruments} ${n.kind === 'ticker' ? 'tickers' : 'RICs'} in use`, n.inUse ? 'tag-used' : 'muted'];
  if ((n.your_pdps || []).length) return [`${n.your_pdps.join(', ')} · ${n.logins_permissioned} login${n.logins_permissioned === 1 ? '' : 's'}`, 'tag-chain'];
  if (n.logins_permissioned) return [`${n.logins_permissioned} logins permissioned`, 'tag-chain'];
  return [n.source === 'LSEG Quarterly Change Summary' ? 'No PDPs you hold' : 'No match', 'muted'];
}

/* -------------------------------------------------------------- dashboard */
async function vDashboard() {
  const { list, acts } = await loadNotices();
  const open = list.filter(n => n.open && n.affects);
  const due14 = open.filter(n => { const d = daysTo(n.effective_date); return d !== null && d >= 0 && d <= 14; });
  const inUse = open.reduce((a, n) => a + n.inUse, 0);
  const overdue = acts.filter(a => daysTo(a.due_date) < 0);
  const untriaged = open.filter(n => n.source === 'LSEG Quarterly Change Summary' && n.status === 'new');
  const awaiting = open.filter(n => n.requires_file && !n.current_file_id);
  const fut = open.filter(n => daysTo(n.effective_date) >= 0).sort((a, b) => (a.effective_date || '').localeCompare(b.effective_date || ''));
  const past = open.filter(n => daysTo(n.effective_date) < 0).sort((a, b) => (b.effective_date || '').localeCompare(a.effective_date || ''));
  const shown = [...fut, ...past].slice(0, 10);
  const name = S.tenants.find(t => t.tenants.id === S.tenantId).tenants.name;
  return `
  <div class="head"><div><h1>${esc(name)}</h1><p class="sub">${open.length} open notices affect your data, out of ${list.filter(n => n.open).length} open.</p></div>
    <a class="btn primary" href="#notices">All notices</a></div>
  <div class="kpis">
    <div class="kpi"><span class="n">${open.length}</span><span class="l">Open notices affecting you</span></div>
    <div class="kpi ${due14.length ? 'alert' : ''}"><span class="n">${due14.length}</span><span class="l">Effective in the next 14 days</span></div>
    <div class="kpi ${inUse ? 'alert' : ''}"><span class="n">${inUse}</span><span class="l">Affected instruments in use</span></div>
    <div class="kpi"><span class="n">${acts.length}</span><span class="l">Open actions${overdue.length ? ` · <b style="color:var(--crit)">${overdue.length} overdue</b>` : ''}</span></div>
  </div>
  <div class="grid-main">
    <section class="panel"><div class="panel-h"><h2>Effective dates</h2></div>
      ${shown.length ? `<div class="timeline">${shown.map(n => { const d = n.effective_date ? new Date(n.effective_date + 'T00:00:00') : null; const [t, c] = impactText(n);
        return `<div class="tl" data-go="#notice-${n.id}" tabindex="0" role="link"><div class="date">${d ? `<b>${d.getDate()}</b>${d.toLocaleDateString('en-GB', { month: 'short' })} ${d.getFullYear()}` : '—'}</div>
        <div class="t"><div>${esc(n.title)}</div><span class="muted" style="font-size:12px">${esc(n.vendor)} · ${esc(n.ref)} · <span class="${c}">${esc(t)}</span></span></div>
        <div class="row" style="flex-direction:column;align-items:flex-end;gap:4px">${pill(n.status)}${daysChip(n.effective_date)}</div></div>`; }).join('')}</div>`
      : '<p class="empty">No open notices affect your data. Import a change summary or load usage and permission files.</p>'}
    </section>
    <section class="panel"><div class="panel-h"><h2>Needs your attention</h2></div>
      ${untriaged.length ? `<div class="banner info"><b>${untriaged.length} notices</b> from the change summary touch PDPs you're permissioned for and haven't been reviewed. <a href="#notices">Review them</a></div>` : ''}
      ${awaiting.map(n => `<div class="banner"><b>${esc(n.ref)}</b> is waiting for its instrument file. <a href="#notice-${n.id}">Attach file</a></div>`).join('')}
      ${overdue.length ? `<div class="banner"><b>${overdue.length} actions</b> are past their due date. <a href="#actions">See actions</a></div>` : ''}
      ${!untriaged.length && !awaiting.length && !overdue.length ? '<p class="muted">Nothing waiting on you.</p>' : ''}
    </section>
  </div>`;
}

/* ---------------------------------------------------------------- notices */
let NOTICES = [];
async function vNotices() {
  const { list } = await loadNotices(); NOTICES = list;
  return `
  <div class="head"><div><h1>Notices</h1><p class="sub">Every vendor and exchange notice in one place. Import the LSEG Quarterly Change Summary to create a quarter's notices in one go.</p></div>
    <div class="row"><label class="btn" for="sumfile">Import change summary</label><input type="file" id="sumfile" accept=".xlsx,.xls" hidden>
    <button class="btn primary" data-act="toggle-new">Log a notice</button></div></div>
  <section class="panel" id="newform" ${S.showNew ? '' : 'hidden'}>
    <h2>Log a notice</h2>
    <form class="form" id="nf">
      <label>Reference<input class="txt" id="nf-ref" required placeholder="DN217999"></label>
      <label>Vendor<select class="sel" id="nf-vendor"><option>LSEG</option><option>Bloomberg</option><option>CME Group</option><option>ICE</option><option>Eurex</option><option>Other exchange</option></select></label>
      <label class="full">Title<input class="txt" id="nf-title" required></label>
      <label>Change type<input class="txt" id="nf-type" placeholder="e.g. RIC change, Price change"></label>
      <label>Effective date<input class="txt" id="nf-eff" type="date" required></label>
      <label>Services / PDP codes (optional)<input class="txt mono" id="nf-codes" placeholder="e.g. CU2, CME"></label>
      <label>Instrument list<select class="sel" id="nf-kind"><option value="ric">RIC list to attach</option><option value="ticker">Bloomberg ticker list to attach</option><option value="exchange">None, exchange-level notice</option></select></label>
      <label class="full">Portal link<input class="txt" id="nf-portal" placeholder="https://"></label>
      <div class="full row"><button class="btn primary" type="submit">Save notice</button><button class="btn" type="button" data-act="toggle-new">Cancel</button></div>
    </form>
  </section>
  <div id="ntools">${noticeToolbar()}</div>
  <div class="tbl-wrap"><table><thead><tr><th>Reference</th><th>Vendor</th><th>Notice</th><th>Type</th><th>Effective</th><th>Impact</th><th>Status</th></tr></thead><tbody id="ntbody">${noticeRows()}</tbody></table></div>`;
}
function filtered(ignoreAffect) {
  const s = S.q.trim().toLowerCase();
  return NOTICES.filter(n => {
    const summary = n.source === 'LSEG Quarterly Change Summary';
    if (S.source === 'summary' && !summary) return false;
    if (S.source === 'other' && summary) return false;
    if (!ignoreAffect) { if (S.filter === 'affects' && !n.affects) return false; if (S.filter === 'not' && n.affects) return false; }
    if (s && !`${n.ref} ${n.title} ${n.change_type} ${(n.your_pdps || []).join(' ')}`.toLowerCase().includes(s)) return false;
    return true;
  }).sort((a, b) => (a.effective_date || '').localeCompare(b.effective_date || '') || a.ref.localeCompare(b.ref));
}
function noticeToolbar() {
  const base = filtered(true); const nA = base.filter(n => n.affects).length;
  const bulk = base.filter(n => !n.affects && n.status === 'new').length;
  return `<div class="row" style="justify-content:space-between">
    <div class="row">
      <select class="sel" id="nf-filter" aria-label="Filter by impact"><option value="affects" ${S.filter === 'affects' ? 'selected' : ''}>Affects you (${nA})</option><option value="not" ${S.filter === 'not' ? 'selected' : ''}>Doesn't affect you (${base.length - nA})</option><option value="all" ${S.filter === 'all' ? 'selected' : ''}>All (${base.length})</option></select>
      <select class="sel" id="nf-source" aria-label="Filter by source"><option value="all" ${S.source === 'all' ? 'selected' : ''}>All sources</option><option value="summary" ${S.source === 'summary' ? 'selected' : ''}>Change summary</option><option value="other" ${S.source === 'other' ? 'selected' : ''}>Logged notices</option></select>
      <input class="txt" id="nf-q" type="search" placeholder="Search ID, title or PDP code" value="${esc(S.q)}" style="width:240px">
    </div>
    ${bulk && S.role !== 'viewer' ? `<button class="btn small" data-act="bulk-nr">Mark ${bulk} not affecting you as not relevant</button>` : ''}
  </div>`;
}
function noticeRows() {
  const list = filtered();
  if (!list.length) return `<tr><td colspan="7" class="empty">${NOTICES.length ? 'No notices match these filters.' : 'No notices yet. Import a change summary or log a notice.'}</td></tr>`;
  return list.map(n => { const [t, c] = impactText(n); return `<tr class="click" data-go="#notice-${n.id}" tabindex="0">
    <td class="mono">${esc(n.ref)}</td><td><span class="chip vendor">${esc(n.vendor)}</span></td><td style="min-width:240px">${esc(n.title)}</td><td style="min-width:120px">${esc(n.change_type || '')}</td>
    <td style="white-space:nowrap">${fmtDate(n.effective_date)}<br>${daysChip(n.effective_date)}</td><td class="${c}" style="min-width:150px">${esc(t)}</td><td>${pill(n.status)}</td></tr>`; }).join('');
}

/* ---------------------------------------------------------- notice detail */
let CUR = null;
async function vNotice(id) {
  const [n, impact, file, changes, pdp, inst, perm, acts] = await Promise.all([
    q(sb.from('notices').select('*').eq('id', id).maybeSingle()),
    q(sb.from('notice_impact').select('*').eq('notice_id', id).maybeSingle()),
    q(sb.from('notice_files').select('*').eq('notice_id', id).eq('is_current', true).maybeSingle()),
    q(sb.from('notice_service_changes').select('*').eq('notice_id', id).order('line_no')),
    q(sb.from('notice_pdp_matches').select('*').eq('notice_id', id)),
    q(sb.from('notice_instrument_matches').select('*').eq('notice_id', id).limit(2000)),
    q(sb.from('notice_permission_matches').select('*').eq('notice_id', id)),
    q(sb.from('actions').select('*').eq('notice_id', id).order('number')),
  ]);
  if (!n) return '<p>Notice not found. <a href="#notices">Back to notices</a></p>';
  CUR = { n, impact, file, changes, pdp, inst, perm, acts };
  await loadNotices(); // refresh nav counts
  const summary = n.source === 'LSEG Quarterly Change Summary';
  const tab = S.tab[id] || 'used';
  const canEdit = S.role !== 'viewer';

  // Instrument file
  let filePanel = '';
  if (canEdit || file) {
    filePanel = `<section class="panel"><div class="panel-h"><h2>Instrument file</h2>${file ? (canEdit ? `<label class="btn small" for="nfile">Replace file</label>` : '') : n.requires_file ? pill('awaiting_file') : '<span class="pill p-nr">Optional</span>'}</div>
      ${file ? `<dl class="fields"><dt>File</dt><dd class="mono">${esc(file.file_name)}</dd><dt>Rows</dt><dd>${(file.total_rows ?? file.row_count).toLocaleString('en-GB')}${file.matched_only ? ` · ${(file.stored_rows || 0).toLocaleString('en-GB')} in your usage kept` : ''}</dd>
        ${(file.sheets || []).length ? `<dt>Sheets</dt><dd>${file.sheets.map(s => `<span class="chip" style="margin:0 4px 4px 0">${esc(s.name)}: ${Number(s.rows).toLocaleString('en-GB')}</span>`).join('')}</dd>` : ''}
        <dt>Columns</dt><dd>${Object.entries(file.detected_columns || {}).filter(([, v]) => v).map(([k, v]) => `<span class="chip" style="margin:0 4px 4px 0">${esc(k.replace('_', ' '))}: ${esc(v)}</span>`).join('')}</dd>
        <dt>Attached</dt><dd>${fmtDate(file.created_at.slice(0, 10))}</dd></dl>
        ${file.matched_only ? '<p class="muted" style="margin:0;font-size:12px">Only instruments in your usage were stored. Attach the file again after loading a new usage file to re-check it.</p>' : ''}`
      : `<div class="drop" id="drop"><b>Drop the ${esc(n.vendor)} spreadsheet here</b><span class="muted">${n.requires_file ? '' : 'Optional: adds RIC-level matching and an access check. '}LSEG remove / addNew / update files, or any sheet with a RIC or ticker column.</span>
        <div class="row" style="justify-content:center"><label class="btn primary" for="nfile">Choose file</label>${n.portal_url ? `<a class="btn" href="${esc(n.portal_url)}" target="_blank" rel="noopener">Open vendor portal</a>` : ''}</div></div>`}
      <input type="file" id="nfile" accept=".xlsx,.xls,.csv" hidden>
    </section>`;
  }

  // Impact
  let impactHtml = '';
  if (file) {
    const U = n.kind === 'ticker' ? 'tickers' : 'RICs';
    const byCode = new Map();
    inst.forEach(m => { if (!byCode.has(m.instrument_id)) byCode.set(m.instrument_id, { code: m.current_code, new: m.new_code, change: m.change_type, name: m.ric_name, oldPdp: m.old_pdp, newPdp: m.new_pdp, rows: [] }); byCode.get(m.instrument_id).rows.push(m); });
    const owners = groupOwners(inst.map(m => m.login));
    impactHtml = `<section class="panel"><div class="panel-h"><h2>Impact</h2></div>
      <div class="stats"><div class="stat"><b>${(impact?.instruments || 0).toLocaleString('en-GB')}</b><span>${U} in notice</span></div>
        <div class="stat ${impact?.used_direct ? 'hot' : ''}"><b>${impact?.used_direct || 0}</b><span>Used directly</span></div>
        <div class="stat ${impact?.used_via_chain ? 'hot' : ''}"><b>${impact?.used_via_chain || 0}</b><span>Used via a chain</span></div>
        <div class="stat"><b>${impact?.logins_affected || 0}</b><span>Logins affected</span></div>
        <div class="stat"><b>${impact?.cost_centres || 0}</b><span>Cost centres</span></div>
        <div class="stat ${impact?.logins_losing_access ? 'hot' : ''}"><b>${impact?.logins_losing_access || 0}</b><span>Logins losing access</span></div></div>
      ${impact?.logins_losing_access ? `<div class="banner"><b>${impact.logins_losing_access} login${impact.logins_losing_access === 1 ? '' : 's'}</b> request RICs whose new PDPs they aren't permissioned for (marked ⚠). They lose access on ${fmtDate(n.effective_date)} unless a new service is ordered.</div>` : ''}
      <div class="tabs"><button class="${tab === 'used' ? 'on' : ''}" data-tab="used">In use (${byCode.size})</button><button class="${tab === 'owner' ? 'on' : ''}" data-tab="owner">By user (${owners.length})</button></div>
      ${tab === 'owner' ? `<div class="tbl-wrap"><table><thead><tr><th>Login</th><th>Name</th><th class="num">${U}</th></tr></thead><tbody>${owners.map(o => `<tr><td class="mono">${esc(o.login)}</td><td>${esc(inst.find(m => m.login === o.login)?.user_name || '')}</td><td class="num mono">${uniq(inst.filter(m => m.login === o.login).map(m => m.instrument_id)).length}</td></tr>`).join('')}</tbody></table></div>`
      : byCode.size ? `<div class="tbl-wrap"><table><thead><tr><th>RIC</th><th>Change</th><th>PDPs</th><th>Match</th><th>Used by</th><th>Cost centre</th></tr></thead><tbody>
        ${[...byCode.values()].map(r => `<tr><td class="mono">${esc(r.code)}${r.new ? `<br>→ ${esc(r.new)}` : ''}${r.name ? `<br><span class="muted" style="font-size:11px;font-family:var(--f-body)">${esc(r.name)}</span>` : ''}</td><td style="min-width:110px">${esc(r.change || '')}</td>
          <td class="mono" style="min-width:120px;font-size:12px">${pdpDiff(r.oldPdp, r.newPdp)}</td>
          <td>${r.rows.some(x => x.match_type === 'direct') ? '<span class="tag-used">In use</span>' : `<span class="tag-chain">Via chain</span><br><span class="mono muted" style="font-size:11px">${esc(uniq(r.rows.map(x => x.used_item)).join(', '))}</span>`}</td>
          <td style="min-width:180px"><div class="row" style="gap:4px">${uniq(r.rows.map(x => x.login)).map(l => { const x = r.rows.find(y => y.login === l); return `<span class="chip ${isAppLogin(l) ? 'app' : ''}" title="${esc(ACCESS_TITLE[x.access] || '')}">${x.access === 'loses' ? '⚠ ' : ''}${esc(x.user_name || l)}</span>`; }).join('')}</div></td>
          <td class="mono">${esc(uniq(r.rows.map(x => x.cost_centre).filter(Boolean)).join(', ') || '—')}</td></tr>`).join('')}</tbody></table></div>`
      : `<p class="empty">None of the ${U} in this notice appear in your current usage file.</p>`}
    </section>`;
  }
  if (changes.length) {
    const held = new Map(); pdp.forEach(m => { if (!held.has(m.code)) held.set(m.code, { ...m, logins: [] }); held.get(m.code).logins.push(m); });
    const allCodes = uniq(changes.flatMap(c => [...(c.old_pdps || []), ...(c.new_pdps || [])]));
    const hl = arr => (arr || []).map(c => held.has(c) ? `<b class="tag-used">${esc(c)}</b>` : esc(c)).join(', ') || '<span class="muted">—</span>';
    const sideTxt = { old: 'Removed or replaced', new: 'Being added', both: 'On both sides (mapping changes)' };
    impactHtml += `<section class="panel"><div class="panel-h"><h2>${file ? 'PDP impact' : 'Impact'}</h2><span class="muted" style="font-size:12px">PDP match against your current permission file</span></div>
      <div class="stats"><div class="stat ${held.size ? 'hot' : ''}"><b>${held.size}</b><span>PDPs you hold</span></div><div class="stat"><b>${allCodes.length}</b><span>PDPs in notice</span></div>
        <div class="stat ${perm.length ? 'hot' : ''}"><b>${uniq(perm.map(p => p.login)).length}</b><span>Logins permissioned</span></div>
        <div class="stat"><b>${uniq(perm.map(p => p.login)).filter(isAppLogin).length}</b><span>System logins</span></div></div>
      ${held.size ? `<div class="tbl-wrap"><table><thead><tr><th>PDP</th><th>In this notice</th><th>Price</th><th>Permissioned logins</th></tr></thead><tbody>
        ${[...held.values()].sort((a, b) => a.code.localeCompare(b.code)).map(h => `<tr><td class="mono"><b>${esc(h.code)}</b></td><td>${sideTxt[h.side] || h.side}</td>
          <td class="mono" style="white-space:nowrap">${h.old_price || h.new_price ? `${esc(h.old_price || '—')} → ${esc(h.new_price || '—')}` : '<span class="muted">No change</span>'}</td>
          <td style="min-width:200px"><div class="row" style="gap:4px">${uniq(h.logins.map(l => l.login)).map(l => { const x = h.logins.find(y => y.login === l); return `<span class="chip ${isAppLogin(l) ? 'app' : ''}" title="${esc(l)}">${esc(x.user_name || l)}</span>`; }).join('')}</div></td></tr>`).join('')}
      </tbody></table></div>` : `<p class="empty">None of the ${allCodes.length} PDP codes in this notice are in your current permission file.</p>`}
      <h3>Service changes in this notice (${changes.length})</h3>
      <div class="tbl-wrap"><table><thead><tr><th>Old PDP</th><th>New PDP</th><th>Old PE</th><th>New PE</th><th>Price</th></tr></thead><tbody>
      ${changes.map(c => `<tr><td class="mono" style="min-width:140px">${hl(c.old_pdps)}</td><td class="mono" style="min-width:140px">${hl(c.new_pdps)}</td><td class="mono">${esc(c.old_pe || '—')}</td><td class="mono">${esc(c.new_pe || '—')}</td><td class="mono" style="white-space:nowrap">${c.old_price || c.new_price ? `${esc(c.old_price || '—')} → ${esc(c.new_price || '—')}` : '—'}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="muted" style="margin:0;font-size:12px">Codes in red are permissioned on your site.</p>
    </section>`;
  } else if (!file && (n.service_codes || []).length) {
    impactHtml = `<section class="panel"><div class="panel-h"><h2>Impact</h2><span class="muted" style="font-size:12px">Exchange-level match on <span class="mono">${esc(n.service_codes.join(', '))}</span></span></div>
      <div class="stats"><div class="stat ${perm.length ? 'hot' : ''}"><b>${uniq(perm.map(p => p.login)).length}</b><span>Logins permissioned</span></div></div>
      ${perm.length ? `<div class="tbl-wrap"><table><thead><tr><th>Login</th><th>Name</th><th>Service</th><th>Fee</th><th>Email</th></tr></thead><tbody>
        ${perm.map(p => `<tr><td class="mono">${esc(p.login)}</td><td>${esc(p.user_name || '')}</td><td class="mono">${esc(p.service_code)}</td><td class="mono">${esc(p.fee_structure || '—')}</td><td class="mono">${esc(p.email || '—')}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="empty">No logins are permissioned for these services in your current permission file.</p>'}
    </section>`;
  }

  // Actions
  const showActions = !(n.requires_file && !file);
  const actionsPanel = showActions ? `<section class="panel"><div class="panel-h"><h2>Actions</h2>${canEdit ? `<button class="btn primary" data-act="create-actions">Create actions</button>` : ''}</div>
    ${acts.length ? `<div class="tbl-wrap"><table><thead><tr><th>Owner</th><th class="num">${file ? 'Items' : 'Logins'}</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>
      ${acts.map(a => `<tr><td>${esc(a.owner_name)}${a.is_app ? ' <span class="chip app">app</span>' : ''}<br><span class="muted mono" style="font-size:12px">${esc(a.owner_email || 'no email on file')}</span></td>
        <td class="num mono">${file ? a.items.length : a.logins.length}</td><td style="white-space:nowrap">${fmtDate(a.due_date)}<br>${a.status === 'done' ? '' : daysChip(a.due_date)}</td>
        <td><select class="sel" data-actstatus="${a.id}" aria-label="Action status" ${canEdit ? '' : 'disabled'}>${Object.entries(ACTION).map(([k, v]) => `<option value="${k}" ${k === a.status ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
        <td><button class="btn small" data-email="${a.id}">Email text</button></td></tr>`).join('')}</tbody></table></div>`
    : `<p class="muted" style="margin:0">Create actions to assign each affected person or application team, due 5 days before the effective date (or 3 days from today if that has passed). Running it again only adds owners who don't have an action yet.</p>`}
    ${S.emailFor && acts.some(a => a.id === S.emailFor) ? emailBlock(n, acts.find(a => a.id === S.emailFor)) : ''}
  </section>` : '';

  const steps = ['Received', 'Instrument file', 'Matched', 'Actions assigned', 'Closed'];
  const si = ['actioned', 'not_relevant'].includes(n.status) ? 4 : acts.length ? 3 : (file || !n.requires_file) ? 2 : 1;
  return `
  <a class="back" href="#notices">← All notices</a>
  <div class="head"><div><div class="row" style="margin-bottom:6px"><span class="chip vendor">${esc(n.vendor)}</span><span class="mono muted">${esc(n.ref)}</span>${n.change_type ? `<span class="chip wrap">${esc(n.change_type)}</span>` : ''}</div><h1>${esc(n.title)}</h1></div>
    <label class="row" style="gap:8px"><span class="muted">Status</span><select class="sel" id="nstatus" ${canEdit ? '' : 'disabled'}>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === n.status ? 'selected' : ''}>${v}</option>`).join('')}</select></label></div>
  <div class="steps">${steps.map((s, i) => `<div class="step ${i < si ? 'done' : i === si ? 'cur' : ''}"><div class="bar"></div>${s}</div>`).join('')}</div>
  <div class="grid-main">
    <div style="display:flex;flex-direction:column;gap:18px;min-width:0">${filePanel}${impactHtml}${actionsPanel}</div>
    <section class="panel"><h2>Notice details</h2>
      ${n.summary ? `<div class="ai"><small>Summary${summary ? ' · from LSEG' : ''}</small>${esc(n.summary)}</div>` : ''}
      <dl class="fields">
        <dt>Source</dt><dd>${esc(n.source || 'Logged manually')}</dd>
        <dt>Effective</dt><dd>${fmtDate(n.effective_date)} ${daysChip(n.effective_date)}</dd>
        ${n.effective_to ? `<dt>Effective to</dt><dd>${fmtDate(n.effective_to)}</dd>` : ''}
        ${n.published_date ? `<dt>Published</dt><dd>${fmtDate(n.published_date)}</dd>` : ''}
        ${(n.change_types || []).length ? `<dt>Change types</dt><dd><div class="row" style="gap:4px">${n.change_types.map(c => `<span class="chip wrap">${esc(c)}</span>`).join('')}</div></dd>` : ''}
        ${n.affected_band ? `<dt>Instruments affected</dt><dd>${esc(n.affected_band)}</dd>` : ''}
        ${n.vendor_status ? `<dt>Vendor status</dt><dd>${esc(n.vendor_status)}${n.vendor_version ? ` · version ${n.vendor_version}` : ''}</dd>` : ''}
        ${n.revision_reason ? `<dt>Last revision</dt><dd>${esc(n.revision_reason)}</dd>` : ''}
        ${(n.associated_refs || []).length ? `<dt>Related notices</dt><dd class="mono">${esc(n.associated_refs.join(', '))}</dd>` : ''}
        ${n.content_set ? `<dt>Content set</dt><dd>${esc(n.content_set)}</dd>` : ''}
        ${(n.service_codes || []).length ? `<dt>Services</dt><dd class="mono">${esc(n.service_codes.join(', '))}</dd>` : ''}
        ${n.portal_url ? `<dt>Portal link</dt><dd><a class="mono" href="${esc(n.portal_url)}" target="_blank" rel="noopener" style="font-size:12px">${esc(n.portal_url)}</a></dd>` : ''}
      </dl>
      ${n.description ? `<details><summary>Full description</summary><div style="white-space:pre-wrap;margin-top:8px;font-size:13px">${esc(n.description)}</div></details>` : ''}
    </section>
  </div>`;
}
const ACCESS_TITLE = { keeps: 'Permissioned for at least one of the new PDPs', loses: 'Not permissioned for any of the new PDPs: loses access', unknown: 'Access not checked (no new PDPs, or login not in the permission file)' };
/** Show what a PDP list change adds and removes, ignoring LSEG's WW* product-level codes. */
function pdpDiff(oldList, newList) {
  if (!oldList && !newList) return '<span class="muted">—</span>';
  const sp = s => new Set(String(s || '').replace(/\u00a0/g, ' ').split(/[\s,;]+/).filter(c => c && !/^WW/.test(c)));
  const o = sp(oldList), n = sp(newList);
  const rem = [...o].filter(c => !n.has(c)), add = [...n].filter(c => !o.has(c));
  if (!rem.length && !add.length) return `<span class="muted">${esc([...n].join(', ') || 'No change')}</span>`;
  return [...rem.map(c => `<span class="tag-used">−${esc(c)}</span>`), ...add.map(c => `<span style="color:var(--ok);font-weight:600">+${esc(c)}</span>`)].join(' ');
}
function groupOwners(logins) { return uniq(logins).map(login => ({ login })); }
function emailText(n, a) {
  const items = a.items || [];
  const codes = uniq(CUR.pdp.filter(m => a.logins.includes(m.login)).map(m => m.code));
  const lines = items.map(i => { const r = CUR.inst.find(m => m.current_code === i); return `  ${i}${r?.new_code ? '  ->  ' + r.new_code : ''}${r?.change_type ? '  (' + r.change_type + ')' : ''}`; });
  const what = items.length ? `You (${a.logins.join(', ')}) requested these affected instruments in the latest usage report:\n${lines.join('\n')}`
    : `Your login(s) ${a.logins.join(', ')} are permissioned for ${(codes.length ? codes : n.service_codes || []).join(', ')}, which this notice changes.`;
  return `To: ${a.owner_email || '[no email on file]'}
Subject: Action needed by ${fmtDate(a.due_date)}: ${n.vendor} ${n.ref}, ${n.title}

Hi ${a.is_app ? 'team' : a.owner_name},

${n.vendor} notice ${n.ref} takes effect on ${fmtDate(n.effective_date)}.
${n.summary || ''}

${what}

Please confirm what you need to change by ${fmtDate(a.due_date)}.

Thanks,
Market Data team`;
}
function emailBlock(n, a) {
  return `<div style="display:flex;flex-direction:column;gap:8px"><div class="panel-h"><h3>Email for ${esc(a.owner_name)}</h3><div class="row"><button class="btn small" data-act="copy-email">Copy</button><button class="btn small" data-act="close-email">Close</button></div></div><pre class="email" id="emailtxt">${esc(emailText(n, a))}</pre></div>`;
}

/* ---------------------------------------------------------------- actions */
async function vActions() {
  await loadNotices();
  const acts = await q(sb.from('actions').select('*, notices(id, ref, title)').eq('tenant_id', S.tenantId).order('due_date'));
  acts.sort((a, b) => (a.status === 'done') - (b.status === 'done') || (a.due_date || '').localeCompare(b.due_date || ''));
  return `<div class="head"><div><h1>Actions</h1><p class="sub">Who needs to do what, by when.</p></div></div>
  ${acts.length ? `<div class="tbl-wrap"><table><thead><tr><th>Notice</th><th>Owner</th><th class="num">Items</th><th>Due</th><th>Status</th></tr></thead><tbody>
  ${acts.map(a => `<tr class="click" data-go="#notice-${a.notice_id}" tabindex="0"><td><span class="mono">${esc(a.notices?.ref)}</span><br><span class="muted" style="font-size:12px">${esc(a.notices?.title || '')}</span></td>
    <td>${esc(a.owner_name)}${a.is_app ? ' <span class="chip app">app</span>' : ''}</td><td class="num mono">${a.items.length || a.logins.length}</td>
    <td style="white-space:nowrap">${fmtDate(a.due_date)}<br>${a.status === 'done' ? '' : daysChip(a.due_date)}</td><td>${esc(ACTION[a.status])}</td></tr>`).join('')}
  </tbody></table></div>` : '<p class="empty">No actions yet. Open a notice that affects you and create actions.</p>'}`;
}

/* ---------------------------------------------------------------- sources */
async function vSources() {
  await loadNotices();
  const srcs = await q(sb.from('data_sources').select('*').eq('tenant_id', S.tenantId).order('created_at', { ascending: false }).limit(50));
  const card = kind => {
    const cur = srcs.find(s => s.kind === kind && s.is_current); const [title, sub] = SOURCE_KINDS[kind];
    return `<section class="panel"><div class="panel-h"><div><h2>${title}</h2><span class="muted" style="font-size:12px">${sub}</span></div>${cur ? '<span class="pill p-done">Loaded</span>' : '<span class="pill p-nr">Not loaded</span>'}</div>
      ${cur ? `<div class="stats"><div class="stat"><b>${cur.row_count.toLocaleString('en-GB')}</b><span>Rows</span></div></div>
        <dl class="fields"><dt>File</dt><dd class="mono" style="font-size:12px">${esc(cur.file_name)}</dd>${cur.report_version ? `<dt>Version</dt><dd class="mono">${esc(cur.report_version)}</dd>` : ''}${cur.generated_label ? `<dt>Generated</dt><dd>${esc(cur.generated_label)}</dd>` : ''}${cur.period_label ? `<dt>Period</dt><dd>${esc(cur.period_label)}</dd>` : ''}<dt>Loaded</dt><dd>${fmtDate(cur.created_at.slice(0, 10))}</dd></dl>
        ${(cur.warnings || []).length ? `<div><h3 style="margin-bottom:4px">Parser notes</h3><ul class="warnlist">${cur.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}` : '<p class="muted" style="margin:0">No file loaded yet.</p>'}
      ${S.role !== 'viewer' ? `<div class="drop" data-drop="${kind}"><span>Drop a CSV here to replace it</span><div class="row" style="justify-content:center"><label class="btn small primary" for="f-${kind}">Choose CSV</label><input type="file" id="f-${kind}" accept=".csv,.txt" data-src="${kind}" hidden></div></div>` : ''}
    </section>`;
  };
  return `<div class="head"><div><h1>Data sources</h1><p class="sub">Usage tells Notice Desk which RICs and tickers you request. Permissions say who is entitled to each PDP and give emails for routing. A new file replaces the old one only once it has loaded fully.</p></div></div>
  <div class="grid2">${card('lseg_usage')}${card('lseg_permissions')}</div>${card('bpipe_usage')}
  ${srcs.length ? `<details><summary>Upload history (${srcs.length})</summary><div class="tbl-wrap" style="margin-top:8px"><table><thead><tr><th>Loaded</th><th>Type</th><th>File</th><th class="num">Rows</th><th>Current</th></tr></thead><tbody>
    ${srcs.map(s => `<tr><td>${fmtDate(s.created_at.slice(0, 10))}</td><td>${esc(SOURCE_KINDS[s.kind][0])}</td><td class="mono" style="font-size:12px">${esc(s.file_name)}</td><td class="num mono">${s.row_count}</td><td>${s.is_current ? 'Yes' : ''}</td></tr>`).join('')}
  </tbody></table></div></details>` : ''}`;
}

/* ----------------------------------------------------------- applications */
async function vApps() {
  await loadNotices();
  const [apps, cands] = await Promise.all([
    q(sb.from('applications').select('*').eq('tenant_id', S.tenantId).order('login')),
    q(sb.from('application_candidates').select('*').eq('tenant_id', S.tenantId).order('login')),
  ]);
  const rows = [...apps.map(a => ({ ...a, mapped: true })), ...cands.filter(c => !apps.some(a => a.login === c.login)).map(c => ({ login: c.login, name: '', owner_team: '', owner_email: '', dacs: c.user_name }))];
  return `<div class="head"><div><h1>Applications</h1><p class="sub">Map system logins to an application and owning team, so actions go to the people who can fix them. Logins that look like systems but aren't mapped yet are listed too.</p></div></div>
  ${rows.length ? `<div class="tbl-wrap"><table><thead><tr><th>Login</th><th>Application</th><th>Owning team</th><th>Team email</th><th></th></tr></thead><tbody>
  ${rows.map((r, i) => `<tr><td class="mono">${esc(r.login)}${r.dacs ? `<br><span class="muted" style="font-size:11px">${esc(r.dacs)}</span>` : ''}</td>
    <td><input class="txt" id="ap-n-${i}" value="${esc(r.name)}" placeholder="Name this application"></td>
    <td><input class="txt" id="ap-o-${i}" value="${esc(r.owner_team || '')}" placeholder="Team"></td>
    <td><input class="txt mono" id="ap-e-${i}" value="${esc(r.owner_email || '')}" placeholder="team@"></td>
    <td>${S.role !== 'viewer' ? `<button class="btn small ${r.mapped ? '' : 'primary'}" data-saveapp="${i}" data-login="${esc(r.login)}">${r.mapped ? 'Save' : 'Map'}</button>` : ''}</td></tr>`).join('')}
  </tbody></table></div>` : '<p class="empty">No system logins found yet. Load a usage or permission file first.</p>'}`;
}

/* ----------------------------------------------------------------- events */
function wire() {
  document.querySelectorAll('.drop').forEach(d => {
    d.addEventListener('dragover', e => { e.preventDefault(); d.classList.add('over'); });
    d.addEventListener('dragleave', () => d.classList.remove('over'));
    d.addEventListener('drop', e => { e.preventDefault(); d.classList.remove('over'); const f = e.dataTransfer.files[0]; if (!f) return; d.dataset.drop ? loadSource(f, d.dataset.drop) : attachNoticeFile(f); });
  });
}
document.addEventListener('click', async e => {
  const go = e.target.closest('[data-go]');
  if (go && !e.target.closest('a,button,select,input,label')) { location.hash = go.dataset.go; return; }
  const t = e.target.closest('[data-act],[data-tab],[data-email],[data-saveapp]'); if (!t) return;
  const nid = (location.hash.match(/^#notice-(.+)$/) || [])[1];
  try {
    if (t.dataset.tab) { S.tab[nid] = t.dataset.tab; return route(); }
    if (t.dataset.email) { S.emailFor = t.dataset.email; return route(); }
    if (t.dataset.saveapp) {
      const i = t.dataset.saveapp; const name = $('#ap-n-' + i).value.trim() || t.dataset.login;
      await q(sb.from('applications').upsert({ tenant_id: S.tenantId, login: t.dataset.login, name, owner_team: $('#ap-o-' + i).value.trim() || null, owner_email: $('#ap-e-' + i).value.trim() || null }));
      toast('Application saved'); return route();
    }
    const act = t.dataset.act;
    if (act === 'toggle-new') { S.showNew = !S.showNew; $('#newform').hidden = !S.showNew; if (S.showNew) $('#nf-ref').focus(); }
    if (act === 'bulk-nr') {
      const ids = filtered(true).filter(n => !n.affects && n.status === 'new').map(n => n.id);
      t.disabled = true; await q(sb.from('notices').update({ status: 'not_relevant' }).in('id', ids)); toast(`Marked ${ids.length} notices as not relevant`); route();
    }
    if (act === 'create-actions') { t.disabled = true; const k = await q(sb.rpc('create_actions_for_notice', { p_notice_id: nid })); toast(k ? `Created ${k} action${k === 1 ? '' : 's'}` : 'Every affected owner already has an action'); route(); }
    if (act === 'close-email') { S.emailFor = null; route(); }
    if (act === 'copy-email') {
      const el = $('#emailtxt');
      try { await navigator.clipboard.writeText(el.textContent); toast('Email text copied'); }
      catch { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Press Ctrl+C to copy'); }
    }
  } catch (err) { toast(err.message); t.disabled = false; }
});
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches?.('[data-go]')) location.hash = e.target.dataset.go; });
document.addEventListener('input', e => { if (e.target.id === 'nf-q') { S.q = e.target.value; $('#ntbody').innerHTML = noticeRows(); } });
document.addEventListener('change', async e => {
  const t = e.target;
  try {
    if (t.id === 'nf-filter') { S.filter = t.value; $('#ntools').innerHTML = noticeToolbar(); $('#ntbody').innerHTML = noticeRows(); }
    if (t.id === 'nf-source') { S.source = t.value; $('#ntools').innerHTML = noticeToolbar(); $('#ntbody').innerHTML = noticeRows(); }
    if (t.id === 'sumfile' && t.files[0]) await importSummary(t.files[0]);
    if (t.id === 'nfile' && t.files[0]) await attachNoticeFile(t.files[0]);
    if (t.dataset.src && t.files[0]) await loadSource(t.files[0], t.dataset.src);
    if (t.id === 'nstatus') { await q(sb.from('notices').update({ status: t.value }).eq('id', CUR.n.id)); toast('Status updated'); route(); }
    if (t.dataset.actstatus) { await q(sb.from('actions').update({ status: t.value }).eq('id', t.dataset.actstatus)); toast('Action updated'); route(); }
  } catch (err) { toast(err.message); }
});
document.addEventListener('submit', async e => {
  if (e.target.id !== 'nf') return; e.preventDefault();
  const v = id => $('#' + id).value.trim(); const kind = v('nf-kind');
  try {
    const row = await q(sb.from('notices').insert({
      tenant_id: S.tenantId, ref: v('nf-ref'), vendor: v('nf-vendor'), title: v('nf-title'), change_type: v('nf-type') || null,
      kind, effective_date: v('nf-eff'), service_codes: v('nf-codes') ? v('nf-codes').toUpperCase().split(/[\s,;]+/).filter(Boolean) : [],
      requires_file: kind !== 'exchange', portal_url: v('nf-portal') || null, source: 'Logged manually',
    }).select('id').single());
    S.showNew = false; toast('Notice saved'); location.hash = '#notice-' + row.id;
  } catch (err) { toast(/duplicate key/.test(err.message) ? 'A notice with that reference already exists' : err.message); }
});

async function importSummary(file) {
  toast(`Importing ${file.name}…`);
  const path = `${S.tenantId}/summaries/${Date.now()}_${safeName(file.name)}`;
  await upload('notice-files', path, file);
  const r = await fn('import-change-summary', { tenant_id: S.tenantId, storage_path: path, file_name: file.name });
  S.source = 'summary'; toast(`${r.notices_created} new notices, ${r.notices_updated} updated from ${r.rows} rows`); route();
}
/** Show a message that stays until replaced (for long-running file reads). */
function busy(msg) { const t = $('#toast'); t.innerHTML = `<span class="spin"></span> ${esc(msg)}`; t.hidden = false; clearTimeout(toast.t); }
function readInWorker(buffer, vendor, codes, chains) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./notice-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = e => {
      if (e.data.progress) return busy(e.data.progress);
      w.terminate(); e.data.ok ? resolve(e.data.result) : reject(new Error(e.data.error));
    };
    w.onerror = e => { w.terminate(); reject(new Error(e.message || 'The spreadsheet reader failed to start. Reload the page and try again.')); };
    w.postMessage({ buffer, vendor, codes, chains }, [buffer]);
  });
}
// Notice files are read in the browser: LSEG files can hold 650,000 rows, far
// beyond what an Edge Function can process. Only instruments that appear in
// current usage are stored; the file row keeps the full count.
async function attachNoticeFile(file) {
  const n = CUR.n; const vendor = n.kind === 'ticker' || n.vendor === 'Bloomberg' ? 'Bloomberg' : 'LSEG';
  try {
    busy(`Reading ${file.name}${file.size > 5e6 ? ' (large file: this can take a minute)' : ''}…`);
    const usage = await q(sb.rpc('current_usage_codes', { p_tenant_id: S.tenantId, p_vendor: vendor }));
    if (!usage.source_id) throw new Error(`Load a ${vendor === 'Bloomberg' ? 'B-PIPE' : 'LSEG'} usage file in Data sources first, so this notice can be matched.`);
    const res = await readInWorker(await file.arrayBuffer(), vendor, usage.codes, usage.chains);
    if (!res.total) throw new Error('No instrument rows found. Check the file has a RIC, ticker or "Resource Item RIC" column.');
    busy(`Saving ${res.rows.length.toLocaleString('en-GB')} matched instruments…`);
    const path = `${S.tenantId}/notices/${n.id}/${Date.now()}_${safeName(file.name)}`;
    let storagePath = path;
    try { await upload('notice-files', path, file); } catch (e) { storagePath = null; res.warnings.push(`The original file wasn't kept in storage: ${e.message}`); }
    const f = await q(sb.from('notice_files').insert({
      tenant_id: S.tenantId, notice_id: n.id, file_name: file.name, storage_path: storagePath,
      sheet_name: res.sheets.map(s => s.name).join(', '), detected_columns: res.columns,
      row_count: res.total, total_rows: res.total, stored_rows: res.rows.length, matched_only: true,
      sheets: res.sheets, usage_source_id: usage.source_id,
    }).select('id').single());
    try {
      for (let i = 0; i < res.rows.length; i += 500) {
        await q(sb.from('notice_instruments').insert(res.rows.slice(i, i + 500).map(r => ({ ...r, tenant_id: S.tenantId, notice_id: n.id, file_id: f.id, vendor }))));
      }
    } catch (e) { await sb.from('notice_files').delete().eq('id', f.id); throw e; }
    toast(`Read ${res.total.toLocaleString('en-GB')} rows. ${res.rows.length.toLocaleString('en-GB')} appear in your usage.${res.warnings.length ? ' ' + res.warnings[0] : ''}`);
    route();
  } catch (err) { toast(err.message); }
}
async function loadSource(file, kind) {
  toast(`Loading ${file.name}…`);
  const path = `${S.tenantId}/sources/${kind}/${Date.now()}_${safeName(file.name)}`;
  try {
    await upload('source-files', path, file);
    const r = await fn('parse-source', { tenant_id: S.tenantId, storage_path: path, file_name: file.name, expected_kind: kind });
    toast(`Loaded ${r.rows.toLocaleString('en-GB')} rows from ${file.name}`); route();
  } catch (err) { toast(err.message); }
}

boot();
