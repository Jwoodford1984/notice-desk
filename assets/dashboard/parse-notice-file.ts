// Single-file version for pasting into the Supabase dashboard editor.
// Generated from supabase/functions/parse-notice-file and _shared/.
// @ts-nocheck
import * as XLSX from 'npm:xlsx@0.18.5';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

// ---- notice workbook parser ----
// Vendor notice spreadsheet parser, shared by the web app (in the browser) and
// the parse-notice-file Edge Function. Plain JavaScript with no imports.
//
// Input: every sheet of a workbook as arrays of rows ([{ name, aoa }]).
// Output: one row per instrument with old/new code, PDP, PE and a change label.
//
// Layouts handled:
//   * LSEG Data Notification files: sheets "remove", "addNew", "update"
//     (or a single update-style or "riccontent" sheet) with
//     "Resource Item RIC", "Service Packages PDP", "Resource Group PE" columns.
//   * Generic lists: any sheet with a RIC / ticker / symbol column.
//     A SYMBOL column with an EXCH column is turned into SYMBOL.EXCH.

const clean = v => String(v ?? '').replace(/ /g, ' ').replace(/[\t\r\n]+/g, ' ').trim();
const codesKey = v => clean(v).split(/[\s,;]+/).filter(Boolean).sort().join(',');
const isBlankRow = r => !r || r.every(c => clean(c) === '');

/** Find the header row (first row containing a cell matching re) within the first 15 rows. */
function headerIndex(aoa, re) {
  for (let i = 0; i < Math.min(aoa.length, 15); i++) if ((aoa[i] || []).some(c => re.test(clean(c)))) return i;
  return -1;
}
function colFinder(H) {
  return (re, not) => H.findIndex(h => re.test(h) && !(not && not.test(h)));
}
function toDate(v) {
  if (v instanceof Date) return new Date(v.getTime() + 12 * 3600 * 1000).toISOString().slice(0, 10);
  const s = clean(v); const m = s.match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : s;
}

const LSEG_HDR = /^resource item ric/i;

function parseLsegSheet(name, aoa, warnings, keep) {
  let total = 0;
  const hi = headerIndex(aoa, LSEG_HDR);
  if (hi < 0) return null;
  const H = aoa[hi].map(clean);
  const f = colFinder(H);
  const isUpdate = H.some(h => /\(old\)/i.test(h));
  const rows = [];
  if (isUpdate) {
    const c = {
      ricOld: f(/^resource item ric \(old\)/i), ricNew: f(/^resource item ric \(new\)/i),
      nameOld: f(/^ric name \(old\)/i), nameNew: f(/^ric name \(new\)/i),
      peOld: f(/resource group pe \(old\)/i), peNew: f(/resource group pe \(new\)/i),
      pdpOld: f(/service packages? pdp \(old\)/i), pdpNew: f(/service packages? pdp \(new\)/i),
      exOld: f(/exchange code \(old\)/i), exNew: f(/exchange code \(new\)/i),
      date: f(/map collect date|effective/i),
    };
    for (let i = hi + 1; i < aoa.length; i++) {
      const r = aoa[i]; if (isBlankRow(r)) continue;
      const g = k => (c[k] >= 0 ? clean(r[c[k]]) : '');
      const oldRic = g('ricOld'); if (!oldRic) continue;
      total++; if (keep && !keep(oldRic)) continue;
      const newRic = g('ricNew'); const parts = [];
      if (newRic && newRic !== oldRic) parts.push('RIC change');
      if (g('pdpNew') && g('pdpOld') !== g('pdpNew') && codesKey(g('pdpOld')) !== codesKey(g('pdpNew'))) parts.push('PDP change');
      if (g('peNew') && g('peOld') !== g('peNew')) parts.push('PE change');
      if (g('exNew') && g('exOld') !== g('exNew')) parts.push('Exchange change');
      if (g('nameNew') && g('nameOld') !== g('nameNew')) parts.push('Name change');
      rows.push({
        current_code: oldRic, new_code: newRic && newRic !== oldRic ? newRic : '',
        change_type: parts.join(', ') || 'Updated', effective_label: c.date >= 0 ? toDate(r[c.date]) : '',
        ric_name: g('nameOld') || g('nameNew'), old_pdp: g('pdpOld'), new_pdp: g('pdpNew') || g('pdpOld'),
        old_pe: g('peOld'), new_pe: g('peNew') || g('peOld'), exchange_code: g('exNew') || g('exOld'), sheet: name,
      });
    }
  } else {
    const c = { ric: f(LSEG_HDR), name: f(/^ric name/i), pe: f(/resource group pe/i), pdp: f(/service packages? pdp/i), ex: f(/exchange code/i), date: f(/map collect date|effective/i) };
    const removed = /remove|delete|drop/i.test(name);
    const added = /add|new/i.test(name);
    const label = removed ? 'Removed' : added ? 'Added' : 'Listed';
    for (let i = hi + 1; i < aoa.length; i++) {
      const r = aoa[i]; if (isBlankRow(r)) continue;
      const g = k => (c[k] >= 0 ? clean(r[c[k]]) : '');
      const ric = g('ric'); if (!ric) continue;
      total++; if (keep && !keep(ric)) continue;
      rows.push({
        current_code: ric, new_code: '', change_type: label, effective_label: c.date >= 0 ? toDate(r[c.date]) : '',
        ric_name: g('name'), old_pdp: removed ? g('pdp') : '', new_pdp: removed ? '' : g('pdp'),
        old_pe: removed ? g('pe') : '', new_pe: removed ? '' : g('pe'), exchange_code: g('ex'), sheet: name,
      });
    }
  }
  return { rows, total };
}

const GENERIC_HDR = /\b(rics?|tickers?|instruments?|symbols?|identifiers?|securit(y|ies))\b/i;

function parseGenericSheet(name, aoa, warnings, keep) {
  let total = 0;
  const hi = headerIndex(aoa, GENERIC_HDR);
  const H = hi >= 0 ? aoa[hi].map(clean) : (aoa[0] || []).map((_, i) => `Column ${i + 1}`);
  const f = colFinder(H);
  let code = f(/(old|current|existing|from).*(ric|ticker|security)|^(rics?|tickers?|instruments?|symbols?|securit(y|ies))$/i);
  if (code < 0) code = f(/ric|ticker|instrument|symbol|security/i, /new/i);
  if (code < 0) code = 0;
  const nw = f(/new.*(ric|ticker|security)|(ric|ticker).*new/i);
  const change = f(/change|action|event|type/i);
  const eff = f(/effective|date/i);
  const exch = f(/^exch(ange)?( code)?$/i);
  const nameCol = f(/^name$|ric name|description/i);
  const pdp = f(/service codes?|pdp/i);
  const symbolStyle = /^symbols?$/i.test(H[code] || '') && exch >= 0;
  if (symbolStyle) warnings.push(`${name}: built RICs from ${H[code]} + ${H[exch]} (e.g. 1A + MI → 1A.MI).`);
  if (hi < 0) warnings.push(`${name}: no header row found; used the first column.`);
  const rows = [];
  for (let i = hi + 1; i < aoa.length; i++) {
    const r = aoa[i]; if (isBlankRow(r)) continue;
    let v = clean(r[code]); if (!v) continue;
    if (symbolStyle && clean(r[exch])) v = `${v}.${clean(r[exch])}`;
    total++; if (keep && !keep(v)) continue;
    rows.push({
      current_code: v, new_code: nw >= 0 ? clean(r[nw]) : '', change_type: change >= 0 ? clean(r[change]) : 'Listed',
      effective_label: eff >= 0 ? toDate(r[eff]) : '', ric_name: nameCol >= 0 ? clean(r[nameCol]) : '',
      old_pdp: '', new_pdp: pdp >= 0 ? clean(r[pdp]) : '', old_pe: '', new_pe: '', exchange_code: exch >= 0 ? clean(r[exch]) : '', sheet: name,
    });
  }
  return { rows, total, header: H, columns: { instrument: H[code] ?? null, new_code: H[nw] ?? null, change: H[change] ?? null, effective: H[eff] ?? null } };
}

/**
 * @param {{name: string, aoa?: unknown[][], load?: () => unknown[][]}[]} sheets every sheet in the workbook.
 *   Give `load` instead of `aoa` to read sheets one at a time (saves memory on very large files).
 * @param {{keep?: (code: string) => boolean}} [opts] keep only rows whose current code passes `keep`
 *   (the browser uses this to store only instruments that appear in usage). Totals still count every row.
 * @returns {{format: string, rows: object[], total: number, sheets: {name: string, rows: number}[], columns: object, warnings: string[]}}
 */
function parseNoticeWorkbook(sheets, opts = {}) {
  const warnings = []; const keep = opts.keep;
  const aoaOf = s => s.aoa || (s.aoa = s.load());
  const isLseg = sheets.some(s => headerIndex(aoaOf(s).slice(0, 15), LSEG_HDR) >= 0);
  const rows = []; const summary = []; let columns = {}; let total = 0;
  if (isLseg) {
    for (const s of sheets) {
      const r = parseLsegSheet(s.name, aoaOf(s), warnings, keep);
      s.aoa = null; // let the sheet be garbage-collected
      if (r === null) continue; // e.g. a "ric domain" lookup sheet
      summary.push({ name: s.name, rows: r.total }); total += r.total; for (const x of r.rows) rows.push(x);
    }
    columns = { instrument: 'Resource Item RIC', new_code: 'Resource Item RIC (new)', pdp: 'Service Packages PDP', pe: 'Resource Group PE' };
  } else {
    for (const s of sheets) {
      if (!aoaOf(s).some(r => !isBlankRow(r))) continue;
      const g = parseGenericSheet(s.name, aoaOf(s), warnings, keep);
      summary.push({ name: s.name, rows: g.total }); total += g.total; for (const x of g.rows) rows.push(x);
      if (!columns.instrument) columns = g.columns;
      if (g.total) break; // generic files: use the first sheet with data
    }
  }
  if (!total) warnings.push('No instrument rows found.');
  return { format: isLseg ? 'lseg-dn' : 'generic', rows, total, sheets: summary, columns, warnings };
}

/** Normalise a code the same way the database does (normalise_code / chain_base). */
function normaliseCode(code, vendor) {
  const s = String(code ?? '').trim();
  return vendor === 'Bloomberg' ? s.replace(/\s+/g, ' ').toUpperCase() : s.replace(/^\//, '');
}

/**
 * Read a SheetJS worksheet as an array of rows. LSEG files often carry a stale
 * dimension tag (e.g. A1:L6 on a 50,000-row sheet), which SheetJS trusts, so
 * the range is recomputed from the cells actually present first.
 * @param {any} XLSX the SheetJS module
 * @param {any} ws a worksheet (read with or without `dense: true`)
 */
function sheetToRows(XLSX, ws) {
  let maxR = 0, maxC = 0;
  // Dense sheets: SheetJS 0.18 makes the sheet itself an array of rows; 0.19+ uses ws['!data'].
  const dense = Array.isArray(ws) ? ws : Array.isArray(ws['!data']) ? ws['!data'] : null;
  if (dense) {
    for (let r = 0; r < dense.length; r++) { const row = dense[r]; if (row && row.length) { maxR = r; if (row.length - 1 > maxC) maxC = row.length - 1; } }
  } else {
    for (const k of Object.keys(ws)) {
      if (k[0] === '!') continue;
      const a = XLSX.utils.decode_cell(k); if (a.r > maxR) maxR = a.r; if (a.c > maxC) maxC = a.c;
    }
  }
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, blankrows: false });
}

// ---- supabase helpers ----

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/** A client that acts as the calling user, so every read and write goes through RLS. */
export function userClient(req: Request): SupabaseClient {
  const auth = req.headers.get('Authorization');
  if (!auth) throw new HttpError(401, 'Sign in first: the request has no Authorization header.');
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

export async function handle(req: Request, fn: () => Promise<Response>): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  try { return await fn(); }
  catch (e) {
    const status = e instanceof HttpError ? e.status : 400;
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
}

/** Insert in batches so large usage files stay under request size limits. */
export async function insertChunked(db: SupabaseClient, table: string, rows: Record<string, unknown>[], size = 1000) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await db.from(table).insert(rows.slice(i, i + size));
    if (error) throw new HttpError(400, `Saving ${table} failed at row ${i + 1}: ${error.message}`);
  }
}

// ---- function ----
// POST { notice_id, storage_path, file_name }
// Reads a vendor notice spreadsheet attached to a notice (in the "notice-files"
// bucket), stores every instrument row and returns the match summary.
// Every sheet is read, so LSEG files with remove / addNew / update tabs work.
// Edge Functions have tight CPU limits: for files over a few thousand rows the
// web app reads the file in the browser instead and stores only matched rows.

Deno.serve(req => handle(req, async () => {
  const { notice_id, storage_path, file_name } = await req.json();
  if (!notice_id || !storage_path) throw new HttpError(400, 'notice_id and storage_path are required.');
  const db = userClient(req);

  const { data: notice, error: nErr } = await db.from('notices').select('id, tenant_id, vendor, kind').eq('id', notice_id).single();
  if (nErr || !notice) throw new HttpError(404, 'Notice not found, or you do not have access to it.');
  if (!String(storage_path).startsWith(`${notice.tenant_id}/`)) throw new HttpError(400, 'storage_path must start with the tenant id.');

  const { data: blob, error: dlErr } = await db.storage.from('notice-files').download(storage_path);
  if (dlErr || !blob) throw new HttpError(404, `Couldn't read ${storage_path}: ${dlErr?.message ?? 'not found'}`);
  const wb = XLSX.read(new Uint8Array(await blob.arrayBuffer()), { type: 'array', cellDates: true, dense: true });
  const parsed = parseNoticeWorkbook(wb.SheetNames.map(name => ({ name, load: () => sheetToRows(XLSX, wb.Sheets[name]) as unknown[][] })));
  if (!parsed.total) throw new HttpError(400, 'No instrument rows found. Check the file has a RIC or ticker column.');

  const { data: file, error: fErr } = await db.from('notice_files').insert({
    tenant_id: notice.tenant_id, notice_id, file_name: file_name ?? storage_path.split('/').pop(), storage_path,
    sheet_name: parsed.sheets.map(s => s.name).join(', '), detected_columns: parsed.columns,
    row_count: parsed.total, total_rows: parsed.total, stored_rows: parsed.rows.length, matched_only: false, sheets: parsed.sheets,
  }).select('id').single();
  if (fErr) throw new HttpError(400, fErr.message);

  const vendor = notice.kind === 'ticker' || notice.vendor === 'Bloomberg' ? 'Bloomberg' : 'LSEG';
  try {
    await insertChunked(db, 'notice_instruments', parsed.rows.map(r => ({ ...r, tenant_id: notice.tenant_id, notice_id, file_id: file.id, vendor })));
  } catch (e) {
    await db.from('notice_files').delete().eq('id', file.id);
    throw e;
  }

  const { data: impact } = await db.from('notice_impact').select('*').eq('notice_id', notice_id).single();
  return json({ file_id: file.id, rows: parsed.total, stored: parsed.rows.length, format: parsed.format, sheets: parsed.sheets, warnings: parsed.warnings, impact });
}));
