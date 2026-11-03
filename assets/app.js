// Notice Desk web app. Plain ES modules, no build step.
//   Check impact  (every signed-in user): drop DACS files, get affected users and actions.
//   Library       (CJC IT admins):       drop the quarter's summary and notice files.
//   Clients       (CJC IT admins):       client organisations and their users.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { decode, parseSource, parseChangeSummary } from './dacs-parsers.js';
import { buildReport, usageCodes, reportSheets } from './impact.js';
import { loadIntoLibrary, refFromFileName, isSummaryFileName } from './library.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ---------------------------------------------------------------- helpers */
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayIso = () => new Date().toISOString().slice(0, 10);
const fmtDate = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const num = n => Number(n || 0).toLocaleString('en-GB');
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3600); }
async function q(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }
/** Read every row of a table or view, 1,000 at a time (the API's page size). */
async function all(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const page = await q(build().range(from, from + 999));
    out.push(...page); if (page.length < 1000) return out;
  }
}
const rpc = (name, args) => q(sb.rpc(name, args));
const currentQuarter = () => { const d = new Date(); return `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`; };

const SEV = { 1: ['Urgent', 'p-match'], 2: ['Review', 'p-review'], 3: ['Info', 'p-nr'] };
const sevPill = s => `<span class="pill ${SEV[s][1]}">${SEV[s][0]}</span>`;

/* ------------------------------------------------------------------ state */
const S = { session: null, isAdmin: false, clients: [], files: { usage: null, perms: null }, report: null, tab: 'actions', queue: [] };

/* ------------------------------------------------------------------- boot */
sb.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') { S.session = null; setTimeout(boot, 0); }
  else if (event === 'SIGNED_IN' && !S.session) { S.session = session; setTimeout(boot, 0); }
});
window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });

async function boot() {
  const { data } = await sb.auth.getSession();
  S.session = data.session;
  if (!S.session) return renderAuth();
  try {
    const [isAdmin, mem] = await Promise.all([rpc('is_cjc_admin', {}), q(sb.from('tenant_members').select('role, tenants(id, name)').eq('user_id', S.session.user.id))]);
    S.isAdmin = isAdmin; S.clients = mem;
  } catch (e) { return renderFatal(e); }
  if (!S.isAdmin && !S.clients.length) return renderNoAccess();
  renderShell(); route();
}
function renderFatal(e) {
  $('#root').innerHTML = `<div class="auth"><section class="panel"><h1>Something went wrong</h1><div class="err">${esc(e.message)}</div><button class="btn" onclick="location.reload()">Reload</button></section></div>`;
}
function renderNoAccess() {
  $('#root').innerHTML = `<div class="auth"><section class="panel"><h1>Almost there</h1>
    <p class="sub">You're signed in as ${esc(S.session.user.email)}, but your account isn't linked to a client yet. Ask CJC IT to add you.</p>
    <button class="btn" id="so">Sign out</button></section></div>`;
  $('#so').addEventListener('click', () => sb.auth.signOut());
}

/* ------------------------------------------------------------------- auth */
function renderAuth(msg = '') {
  $('#root').innerHTML = `<div class="auth"><section class="panel">
    <div><h1>Notice Desk</h1><p class="sub">See which of your users are affected by this quarter's LSEG and Bloomberg data notifications, and what to do about it.</p></div>
    ${msg ? `<div class="err">${esc(msg)}</div>` : ''}
    <form class="form" id="signin" style="grid-template-columns:minmax(0,1fr)">
      <label>Email<input class="txt" id="si-email" type="email" autocomplete="username" required></label>
      <label>Password<input class="txt" id="si-pass" type="password" autocomplete="current-password" required></label>
      <div class="row"><button class="btn primary" type="submit">Sign in</button></div>
    </form>
    <p class="muted" style="margin:0;font-size:12px">Provided by CJC IT. Ask your CJC IT contact for an account.</p>
  </section></div>`;
  $('#signin').addEventListener('submit', async e => {
    e.preventDefault();
    const { error } = await sb.auth.signInWithPassword({ email: $('#si-email').value.trim(), password: $('#si-pass').value });
    if (error) renderAuth(error.message === 'Invalid login credentials' ? "That email and password don't match." : error.message);
  });
}

/* ------------------------------------------------------------------ shell */
function renderShell() {
  const who = S.isAdmin ? 'CJC IT admin' : esc(S.clients.map(c => c.tenants.name).join(', '));
  $('#root').innerHTML = `<div class="shell">
    <aside class="rail">
      <div class="brand"><b>Notice Desk</b><span>Data notification impact checks</span></div>
      <nav class="nav" id="nav"></nav>
      <div class="tenant"><span>Signed in</span><b>${esc(S.session.user.email)}</b><span>${who}</span><button class="linkbtn" id="signout">Sign out</button></div>
    </aside>
    <main><div class="wrap" id="view"></div></main>
  </div>`;
  $('#signout').addEventListener('click', () => sb.auth.signOut());
}
function renderNav() {
  const r = (location.hash || '#check').slice(1);
  const items = [['check', 'Check impact'], ...(S.isAdmin ? [['library', 'Library'], ['clients', 'Clients']] : [])];
  $('#nav').innerHTML = items.map(([k, l]) => `<a href="#${k}" class="${r === k ? 'on' : ''}">${l}</a>`).join('');
}
let routeSeq = 0;
async function route() {
  if (!S.session) return;
  const seq = ++routeSeq;
  let r = (location.hash || '#check').slice(1);
  if (!S.isAdmin && r !== 'check') r = 'check';
  renderNav();
  try {
    const html = await ({ check: vCheck, library: vLibrary, clients: vClients }[r] || vCheck)();
    if (seq !== routeSeq) return;
    $('#view').innerHTML = html; wireDrops();
  } catch (e) { if (seq === routeSeq) $('#view').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

/* =========================================================== CHECK IMPACT */
async function vCheck() {
  const f = S.files; const r = S.report;
  const fileChip = (kind, label) => f[kind] ? `<div class="banner info" style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap">
      <span><b>${label}:</b> ${esc(f[kind].name)} · ${num(f[kind].rows.length)} rows${f[kind].meta?.period ? ` · ${esc(f[kind].meta.period)}` : ''}</span>
      <button class="btn small" data-remove="${kind}">Remove</button></div>` : '';
  return `
  <div class="head"><div><h1>Check your impact</h1>
    <p class="sub">Drop your DACS <b>Usage Detail by User</b> and/or <b>Active Permission by Exchange</b> exports. Notice Desk checks them against every notice in the CJC IT library and lists who is affected and what to do.</p></div>
    ${r ? '<div class="row"><button class="btn" data-act="download">Download Excel</button><button class="btn" data-act="reset">Start again</button></div>' : ''}</div>
  <section class="panel">
    <div class="drop" data-drop="dacs"><b>Drop your DACS files here</b>
      <span class="muted">CSV exports straight from DACS. You can drop both files together.</span>
      <div class="row" style="justify-content:center"><label class="btn primary" for="dacsfile">Choose files</label><input type="file" id="dacsfile" accept=".csv,.txt" multiple hidden></div></div>
    ${fileChip('usage', 'Usage')}${fileChip('perms', 'Permissions')}
    <p class="muted" style="margin:0;font-size:12px">Your files are read in this browser and aren't uploaded or stored. Only RIC and service codes are sent to check against the library. ${!f.usage ? 'Add the usage file to see exactly which RICs and users are hit. ' : ''}${!f.perms ? 'Add the permission file to check whether users keep access and to see price and policy changes.' : ''}</p>
  </section>
  ${r ? reportHtml(r) : ''}`;
}

function reportHtml(r) {
  const s = r.stats; const t = S.tab;
  const tabs = [['actions', `Actions (${s.actions})`], ['users', `By user (${s.users_affected})`], ['notices', `By notice (${s.notices_affecting})`], ['rics', `RIC detail (${r.ricDetail.length})`]];
  let body = '';
  if (t === 'actions') body = r.actions.length ? `<div class="tbl-wrap"><table><thead><tr><th>Priority</th><th>Notice</th><th>Action</th><th>Users</th><th>Due</th></tr></thead><tbody>
    ${r.actions.map((a, i) => `<tr><td>${sevPill(a.severity)}</td>
      <td style="min-width:200px"><span class="mono">${esc(a.ref)}</span><br><span class="muted" style="font-size:12px">${esc(a.title)}</span></td>
      <td style="min-width:280px"><b>${esc(a.category)}</b><br>${esc(a.text)}${a.rics.length ? `<details style="margin-top:4px"><summary style="font-size:12px">${num(a.rics.length)} RIC${a.rics.length === 1 ? '' : 's'}</summary><div class="mono" style="font-size:12px;margin-top:4px">${a.rics.slice(0, 200).map(esc).join(' ')}${a.rics.length > 200 ? ' …' : ''}</div></details>` : ''}</td>
      <td style="min-width:180px">${a.user_names.slice(0, 6).map(n => `<span class="chip" style="margin:0 4px 4px 0">${esc(n)}</span>`).join('')}${a.users.length > 6 ? `<details><summary style="font-size:12px">+${a.users.length - 6} more</summary>${a.user_names.slice(6).map(n => `<span class="chip" style="margin:0 4px 4px 0">${esc(n)}</span>`).join('')}</details>` : ''}</td>
      <td style="white-space:nowrap">${a.due_label ? `<span class="${a.severity === 1 ? 'tag-used' : ''}">${esc(a.due_label)}</span>` : fmtDate(a.due_date)}<br><span class="muted" style="font-size:12px">effective ${fmtDate(a.effective_date)}</span></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="empty">No actions. None of this library\'s notices affect the users or RICs in your files.</p>';
  if (t === 'users') body = `<div class="tbl-wrap"><table><thead><tr><th>User or application</th><th>Cost centre</th><th>What to do</th><th class="num">RICs</th></tr></thead><tbody>
    ${r.users.map(u => `<tr><td style="min-width:180px"><b>${esc(u.name || u.login)}</b><br><span class="mono muted" style="font-size:12px">${esc(u.login)}${u.email ? ' · ' + esc(u.email) : ''}</span></td>
      <td class="mono">${esc(u.cost_centre || '—')}</td>
      <td style="min-width:320px">${u.actions.map(a => `<div style="margin-bottom:4px">${sevPill(a.severity)} <span class="mono">${esc(a.ref)}</span> <b>${esc(a.category)}</b></div>`).join('')}</td>
      <td class="num mono">${num(u.rics.length)}</td></tr>`).join('')}</tbody></table></div>`;
  if (t === 'notices') body = `<div class="tbl-wrap"><table><thead><tr><th>Notice</th><th>Effective</th><th>Actions</th><th class="num">Users</th><th class="num">RICs</th></tr></thead><tbody>
    ${r.notices.map(n => `<tr><td style="min-width:260px"><span class="mono">${esc(n.ref)}</span> ${sevPill(n.top)}<br>${esc(n.title)}${n.summary ? `<details><summary style="font-size:12px">Summary</summary><div style="font-size:13px;margin-top:4px">${esc(n.summary)}</div></details>` : ''}</td>
      <td style="white-space:nowrap">${fmtDate(n.effective_date)}</td><td>${[...new Set(n.actions.map(a => a.category))].map(c => `<span class="chip" style="margin:0 4px 4px 0">${esc(c)}</span>`).join('')}</td>
      <td class="num mono">${n.users.length}</td><td class="num mono">${num(n.rics.length)}</td></tr>`).join('')}</tbody></table></div>`;
  if (t === 'rics') body = r.ricDetail.length ? `<div class="tbl-wrap"><table><thead><tr><th>RIC</th><th>User</th><th>Notice</th><th>Change</th><th>PDPs</th><th>Access</th></tr></thead><tbody>
    ${r.ricDetail.slice(0, 2000).map(d => `<tr><td class="mono">${esc(d.ric)}${d.via === 'chain' ? `<br><span class="muted" style="font-size:11px">chain of ${esc(d.matched_code)}</span>` : ''}${d.new_code ? `<br>→ ${esc(d.new_code)}` : ''}</td>
      <td>${esc(r.people.get(d.login)?.name || d.login)}</td><td class="mono">${esc(d.ref)}</td><td>${esc(d.change)}</td>
      <td class="mono" style="font-size:12px">${d.pdp_removed ? `<span class="tag-used">−${esc(d.pdp_removed)}</span> ` : ''}${d.pdp_added ? `<span style="color:var(--ok);font-weight:600">+${esc(d.pdp_added)}</span>` : ''}${!d.pdp_removed && !d.pdp_added ? '—' : ''}</td>
      <td>${d.access === 'loses' ? '<span class="tag-used">Loses access</span>' : d.access === 'keeps' ? 'Keeps access' : `<span class="muted">${esc(d.access)}</span>`}</td></tr>`).join('')}
    </tbody></table></div>${r.ricDetail.length > 2000 ? '<p class="muted">Showing the first 2,000 rows. The Excel download has them all.</p>' : ''}`
    : `<p class="empty">${S.files.usage ? 'None of your RICs appear in the library\'s notice files.' : 'Add your DACS usage file to see RIC-level detail.'}</p>`;
  return `
  <div class="kpis">
    <div class="kpi ${s.urgent ? 'alert' : ''}"><span class="n">${s.urgent}</span><span class="l">Urgent actions</span></div>
    <div class="kpi ${s.losing_access ? 'alert' : ''}"><span class="n">${s.losing_access}</span><span class="l">Users losing access</span></div>
    <div class="kpi"><span class="n">${s.users_affected}</span><span class="l">Users and applications affected</span></div>
    <div class="kpi"><span class="n">${s.notices_affecting}</span><span class="l">Notices affecting you, of ${s.notices_checked}</span></div>
  </div>
  <section class="panel">
    <div class="tabs">${tabs.map(([k, l]) => `<button class="${t === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
    ${body}
    <p class="muted" style="margin:0;font-size:12px">Checked ${num(s.codes_checked)} RICs from ${num(s.usage_rows)} usage rows and ${num(s.perm_rows)} permission rows against ${s.notices_checked} notices on ${fmtDate(todayIso())}. Due dates are 5 days before each change takes effect.</p>
  </section>`;
}

async function addDacsFiles(files) {
  for (const file of files) {
    try {
      const { text, encoding } = decode(new Uint8Array(await file.arrayBuffer()));
      const p = parseSource(text, encoding);
      if (p.kind === 'lseg_usage') S.files.usage = { name: file.name, rows: p.rows, meta: p.meta };
      else if (p.kind === 'lseg_permissions') S.files.perms = { name: file.name, rows: p.rows, meta: p.meta };
      else throw new Error(`${file.name} looks like a Bloomberg usage file. Bloomberg checks are coming soon.`);
    } catch (e) { toast(`${file.name}: ${e.message}`); }
  }
  await runCheck();
}
async function runCheck() {
  if (!S.files.usage && !S.files.perms) { S.report = null; return route(); }
  $('#view').insertAdjacentHTML('beforeend', '<p class="loading" id="running"><span class="spin"></span> Checking against the library…</p>');
  try {
    const usage = S.files.usage?.rows || []; const perms = S.files.perms?.rows || [];
    const [notices, changes] = await Promise.all([
      all(() => sb.from('lib_notices').select('id, ref, vendor, title, change_types, effective_date, summary').order('id')),
      all(() => sb.from('lib_service_changes').select('notice_id, old_pdp, new_pdp, old_pe, new_pe, old_price, new_price').order('id')),
    ]);
    const codes = [...usageCodes(usage).keys()];
    const matches = [];
    for (let i = 0; i < codes.length; i += 2000) matches.push(...await rpc('lib_match_codes', { p_vendor: 'LSEG', p_codes: codes.slice(i, i + 2000) }));
    S.report = buildReport({ usage, perms, notices, changes, matches, today: todayIso() });
    S.tab = 'actions';
  } catch (e) { toast(e.message); }
  route();
}
function downloadReport() {
  if (!window.XLSX) return toast('The Excel writer did not load. Check your connection and reload.');
  const sheets = reportSheets(S.report, S.report.people);
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ Note: 'Nothing to show' }]), name);
  XLSX.writeFile(wb, `Notice Desk impact ${todayIso()}.xlsx`);
}

/* ================================================================ LIBRARY */
async function vLibrary() {
  const lib = await all(() => sb.from('lib_overview').select('*').order('effective_date', { ascending: true, nullsFirst: false }).order('ref'));
  const withFile = lib.filter(n => n.file_id).length; const rows = lib.reduce((a, n) => a + (n.stored_rows || 0), 0);
  const noSummary = lib.filter(n => n.title === n.ref).length;
  return `
  <div class="head"><div><h1>Notice library</h1><p class="sub">The notices and affected RIC lists every client is checked against. Drop the quarter's Quarterly Change Summary and the notice spreadsheets together; each spreadsheet is attached to its notice by the DN number in its file name.</p></div></div>
  <section class="panel">
    <div class="row">
      <label class="row" style="gap:6px"><span class="muted">Vendor</span><select class="sel" id="lib-vendor"><option>LSEG</option><option>Bloomberg</option></select></label>
      <label class="row" style="gap:6px"><span class="muted">Quarter</span><input class="txt" id="lib-quarter" value="${esc(store.get('nd.quarter') || currentQuarter())}" style="width:110px"></label>
    </div>
    <div class="drop" data-drop="library"><b>Drop the summary and notice spreadsheets here</b>
      <span class="muted">.xlsx files. Large files (hundreds of thousands of rows) take a minute or two each. Keep this page open until they finish.</span>
      <div class="row" style="justify-content:center"><label class="btn primary" for="libfile">Choose files</label><input type="file" id="libfile" accept=".xlsx,.xls,.csv" multiple hidden></div></div>
    <div id="queue">${queueHtml()}</div>
  </section>
  <div class="kpis">
    <div class="kpi"><span class="n">${lib.length}</span><span class="l">Notices</span></div>
    <div class="kpi"><span class="n">${withFile}</span><span class="l">With a RIC list</span></div>
    <div class="kpi"><span class="n">${num(rows)}</span><span class="l">Instrument rows</span></div>
    <div class="kpi ${noSummary ? 'alert' : ''}"><span class="n">${noSummary}</span><span class="l">Files without a summary row</span></div>
  </div>
  <div class="tbl-wrap"><table><thead><tr><th>Notice</th><th>Quarter</th><th>Effective</th><th>Change types</th><th class="num">Service changes</th><th>RIC list</th></tr></thead><tbody>
  ${lib.length ? lib.map(n => `<tr><td style="min-width:260px"><span class="chip vendor">${esc(n.vendor)}</span> <span class="mono">${esc(n.ref)}</span><br>${n.title === n.ref ? '<span class="muted">No summary row yet</span>' : esc(n.title)}</td>
    <td>${esc(n.quarter || '')}</td><td style="white-space:nowrap">${fmtDate(n.effective_date)}</td>
    <td style="min-width:160px;font-size:12px">${(n.change_types || []).map(esc).join('<br>')}</td><td class="num mono">${n.service_changes}</td>
    <td style="min-width:160px">${n.file_id ? `<span class="mono" style="font-size:12px">${esc(n.file_name)}</span><br>${num(n.total_rows)} rows` : n.files_loading ? '<span class="tag-chain">Loading…</span>' : '<span class="muted">None</span>'}</td></tr>`).join('')
    : '<tr><td colspan="6" class="empty">The library is empty. Drop this quarter\'s files above.</td></tr>'}
  </tbody></table></div>`;
}
function queueHtml() {
  if (!S.queue.length) return '';
  return `<div class="tbl-wrap"><table><thead><tr><th>File</th><th>Notice</th><th>Status</th></tr></thead><tbody>
    ${S.queue.map(j => `<tr><td class="mono" style="font-size:12px">${esc(j.file.name)}</td><td class="mono">${esc(j.ref)}</td>
      <td class="${j.state === 'error' ? 'tag-used' : j.state === 'done' ? '' : 'tag-chain'}">${j.state === 'working' ? '<span class="spin"></span> ' : ''}${esc(j.msg)}</td></tr>`).join('')}
  </tbody></table></div>`;
}
const refreshQueue = () => { const el = $('#queue'); if (el) el.innerHTML = queueHtml(); };
function readInWorker(buffer, vendor, job) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./notice-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = e => { if (e.data.progress) { job.msg = e.data.progress; refreshQueue(); return; } w.terminate(); e.data.ok ? resolve(e.data.result) : reject(new Error(e.data.error)); };
    w.onerror = e => { w.terminate(); reject(new Error(e.message || 'The spreadsheet reader failed to start.')); };
    w.postMessage({ buffer, vendor, pack: true }, [buffer]);
  });
}
let queueRunning = false;
async function addLibraryFiles(files) {
  const vendor = $('#lib-vendor').value; const quarter = $('#lib-quarter').value.trim(); store.set('nd.quarter', quarter);
  const jobs = [...files].map(file => ({ file, vendor, quarter, summary: isSummaryFileName(file.name), ref: isSummaryFileName(file.name) ? 'Summary' : refFromFileName(file.name), state: 'queued', msg: 'Waiting' }));
  jobs.sort((a, b) => b.summary - a.summary); // summary first, so notices get their titles
  S.queue.push(...jobs); refreshQueue();
  if (queueRunning) return; queueRunning = true;
  try {
    for (const job of S.queue.filter(j => j.state === 'queued')) {
      job.state = 'working'; job.msg = 'Reading…'; refreshQueue();
      try {
        if (job.summary) {
          const wb = XLSX.read(new Uint8Array(await job.file.arrayBuffer()), { type: 'array', cellDates: true });
          const p = parseChangeSummary(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true }));
          const r = await rpc('lib_import_summary', { p_vendor: job.vendor, p_quarter: job.quarter, p_rows: p.rows });
          job.msg = `${p.notices} notices: ${r.notices_created} new, ${r.notices_updated} updated`;
        } else {
          const parsed = await readInWorker(await job.file.arrayBuffer(), job.vendor, job);
          if (!parsed.total) throw new Error('No instrument rows found');
          const r = await loadIntoLibrary(rpc, { vendor: job.vendor, ref: job.ref, fileName: job.file.name, quarter: job.quarter, parsed },
            (done, total) => { job.msg = `Uploading ${num(done)} of ${num(total)} rows`; refreshQueue(); });
          job.msg = `${num(r.rows)} rows loaded${parsed.warnings.length ? ` · ${parsed.warnings[0]}` : ''}`;
        }
        job.state = 'done';
      } catch (e) { job.state = 'error'; job.msg = e.message; }
      refreshQueue();
    }
    // Clear out rows from files that were replaced
    for (let i = 0; i < 100; i++) { const n = await rpc('lib_purge', { p_limit: 50000 }); if (!n) break; }
  } finally { queueRunning = false; }
  if ((location.hash || '') === '#library') route();
}

/* ================================================================ CLIENTS */
async function vClients() {
  const clients = await rpc('admin_clients', {});
  return `
  <div class="head"><div><h1>Clients</h1><p class="sub">Client organisations and the people who can sign in and check their impact. Create each person's login in Supabase first (Authentication → Users → Add user), then add them here.</p></div></div>
  <section class="panel"><h2>Add a client</h2>
    <form class="form" id="newclient"><label>Client name<input class="txt" id="nc-name" required></label>
      <label>Short name<input class="txt mono" id="nc-slug" required pattern="[a-z0-9-]+" placeholder="client-name"></label>
      <div class="full"><button class="btn primary" type="submit">Add client</button></div></form></section>
  ${clients.length ? clients.map(c => `<section class="panel"><div class="panel-h"><h2>${esc(c.name)}</h2><span class="muted mono" style="font-size:12px">${esc(c.slug)}</span></div>
    ${c.members.length ? `<div class="tbl-wrap"><table><thead><tr><th>Email</th><th>Role</th><th></th></tr></thead><tbody>${c.members.map(m => `<tr><td>${esc(m.email)}</td><td>${esc(m.role)}</td><td><button class="btn small" data-rm="${c.id}|${m.user_id}">Remove</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted" style="margin:0">No users yet.</p>'}
    <form class="row" data-addmember="${c.id}"><input class="txt" type="email" placeholder="name@client.com" required style="max-width:280px"><select class="sel"><option value="member">Member</option><option value="viewer">Viewer</option><option value="admin">Admin</option></select><button class="btn" type="submit">Add user</button></form>
  </section>`).join('') : ''}`;
}

/* ----------------------------------------------------------------- events */
function wireDrops() {
  document.querySelectorAll('.drop').forEach(d => {
    d.addEventListener('dragover', e => { e.preventDefault(); d.classList.add('over'); });
    d.addEventListener('dragleave', () => d.classList.remove('over'));
    d.addEventListener('drop', e => { e.preventDefault(); d.classList.remove('over'); const fs = [...e.dataTransfer.files]; if (!fs.length) return;
      d.dataset.drop === 'library' ? addLibraryFiles(fs) : addDacsFiles(fs); });
  });
}
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act],[data-tab],[data-remove],[data-rm]'); if (!t) return;
  try {
    if (t.dataset.tab) { S.tab = t.dataset.tab; return route(); }
    if (t.dataset.remove) { S.files[t.dataset.remove] = null; return runCheck(); }
    if (t.dataset.rm) { const [tid, uid] = t.dataset.rm.split('|'); await rpc('admin_remove_member', { p_tenant_id: tid, p_user_id: uid }); toast('User removed'); return route(); }
    if (t.dataset.act === 'download') downloadReport();
    if (t.dataset.act === 'reset') { S.files = { usage: null, perms: null }; S.report = null; route(); }
  } catch (err) { toast(err.message); }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'dacsfile' && t.files.length) addDacsFiles([...t.files]);
  if (t.id === 'libfile' && t.files.length) addLibraryFiles([...t.files]);
});
document.addEventListener('submit', async e => {
  const f = e.target;
  try {
    if (f.id === 'newclient') { e.preventDefault(); await rpc('admin_create_client', { p_name: $('#nc-name').value.trim(), p_slug: $('#nc-slug').value.trim() }); toast('Client added'); route(); }
    if (f.dataset.addmember) {
      e.preventDefault(); const [email, role] = [f.querySelector('input').value.trim(), f.querySelector('select').value];
      await rpc('admin_add_member', { p_tenant_id: f.dataset.addmember, p_email: email, p_role: role }); toast(`${email} added`); route();
    }
  } catch (err) { toast(err.message); }
});
document.addEventListener('input', e => { if (e.target.id === 'nc-name') $('#nc-slug').value = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); });

boot();
