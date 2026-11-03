// Single-file version for pasting into the Supabase dashboard editor.
// Generated from supabase/functions/parse-notice-file and _shared/.
import * as XLSX from 'npm:xlsx@0.18.5';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

// ---- parsers ----
// Parsers for LSEG DACS exports, Bloomberg B-PIPE usage CSVs and vendor
// notice spreadsheets. Pure functions with no Deno or Supabase imports, so
// they run in Edge Functions, in Node tests and in a browser.

export type UsageRow = {
  login: string; user_name: string; user_group: string; cost_centre: string; email: string;
  service_code: string; service_desc: string; item: string;
};
export type PermissionRow = {
  login: string; user_name: string; email: string; service_code: string; service_desc: string;
  fee_structure: string; activated_label: string;
};
export type SiteServiceRow = { site_name: string; service_code: string; service_desc: string; fee_structure: string };
export type ParsedSource =
  | { kind: 'lseg_usage'; rows: UsageRow[]; meta: SourceMeta; warnings: string[] }
  | { kind: 'lseg_permissions'; rows: PermissionRow[]; siteServices: SiteServiceRow[]; meta: SourceMeta; warnings: string[] }
  | { kind: 'bpipe_usage'; rows: UsageRow[]; meta: SourceMeta; warnings: string[] };
export type SourceMeta = { report: string; version: string; generated: string; period: string };
export type NoticeRow = { current_code: string; new_code: string; change_type: string; effective_label: string };
export type ParsedNoticeSheet = {
  header: string[]; columns: { instrument: number; new_code: number; change: number; effective: number };
  rows: NoticeRow[]; warnings: string[];
};

// ---------------------------------------------------------------------------
// CSV and encoding
// ---------------------------------------------------------------------------
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); rows.push(row); row = []; f = '';
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

/** DACS exports are often Windows-1252. Try strict UTF-8 first, fall back. */
export function decode(buf: ArrayBuffer | Uint8Array): { text: string; encoding: 'UTF-8' | 'Windows-1252' } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''), encoding: 'UTF-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'Windows-1252' };
  }
}

const clean = (v: unknown) => String(v ?? '').trim().replace(/;+$/, '').trim();
const isBlank = (r: string[]) => r.every(c => c === '');

// ---------------------------------------------------------------------------
// Source detection
// ---------------------------------------------------------------------------
export function parseSource(text: string, encoding: string): ParsedSource {
  const raw = parseCSV(text);
  if (raw.some(r => clean(r[0]) === 'SiteName' && clean(r[1]) === 'VService')) return parseDacs(raw, encoding);
  return parseBpipeUsage(raw, encoding);
}

// ---------------------------------------------------------------------------
// LSEG DACS: "Usage Detail by User" and "Active Permission by Exchange"
// ---------------------------------------------------------------------------
export function parseDacs(raw: string[][], encoding: string): ParsedSource {
  const warnings: string[] = [];
  let semis = 0;
  const rows = raw.map(r => r.map(c => { if (/;\s*$/.test(c)) semis++; return clean(c); }));
  const meta: SourceMeta = { report: rows[0]?.[0] ?? '', version: '', generated: '', period: '' };
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === 'Version' && !meta.version) meta.version = rows[i][1] ?? '';
    if (rows[i][0] === 'GenerateDate' && !meta.generated) {
      meta.generated = rows[i + 1]?.[0] ?? '';
      if (rows[i][1] === 'ReqStartDate') meta.period = `${rows[i + 1]?.[1] ?? ''} – ${rows[i + 1]?.[2] ?? ''}`;
    }
  }
  const hi = rows.findIndex(r => r[0] === 'SiteName' && r[1] === 'VService');
  if (hi < 0) throw new Error("Couldn't find the user table (a header row starting SiteName, VService).");
  const H = rows[hi];
  const col = (n: string) => H.indexOf(n);
  const isUsage = col('Item') >= 0;
  const isPerms = !isUsage && col('FeeStructure') >= 0;
  if (!isUsage && !isPerms) throw new Error('Unsupported DACS report. Use Usage Detail by User or Active Permission by Exchange.');

  const usage: UsageRow[] = [], perms: PermissionRow[] = [];
  let blankPos = 0, dup = 0, noEmail = 0;
  const seen = new Set<string>();
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    if (isBlank(r)) break;
    const g = (n: string) => (col(n) >= 0 ? r[col(n)] ?? '' : '');
    if (isUsage) {
      const o: UsageRow = { login: g('Login'), user_name: g('UName'), user_group: g('UGroup'), cost_centre: g('UCostCtr'),
        email: g('Email'), service_code: g('Global_Name'), service_desc: g('Description'), item: g('Item') };
      if (!o.item || !o.login) continue;
      if (!g('UAccessPos')) blankPos++;
      if (!o.email) noEmail++;
      const k = o.login + '|' + o.item; if (seen.has(k)) dup++; seen.add(k);
      usage.push(o);
    } else {
      const o: PermissionRow = { login: g('Login'), user_name: g('UName'), email: g('Email'), service_code: g('Global_Name'),
        service_desc: g('Description'), fee_structure: g('FeeStructure'), activated_label: g('Activation') };
      if (!o.login || !o.service_code) continue;
      if (!o.email) noEmail++;
      perms.push(o);
    }
  }
  const siteServices: SiteServiceRow[] = [];
  const mi = rows.findIndex(r => r[0] === 'mapsite');
  if (mi >= 0) for (let j = mi + 1; j < rows.length && !isBlank(rows[j]); j++) {
    const r = rows[j]; siteServices.push({ site_name: r[0], service_code: r[2], service_desc: r[3], fee_structure: r[4] });
  }
  const repeats = rows.filter(r => r[0] === meta.report).length - 1;

  if (encoding !== 'UTF-8') warnings.push(`File is ${encoding}-encoded, not UTF-8; read with the correct encoding.`);
  if (semis) warnings.push(`Removed ${semis} trailing semicolons from cells.`);
  if (repeats > 0) warnings.push(`Ignored ${repeats} repeated report header block(s).`);
  if (isUsage) {
    if (blankPos) warnings.push(`${blankPos} usage row(s) have a blank UAccessPos.`);
    if (dup) warnings.push(`${dup} duplicate login + RIC row(s).`);
    if (noEmail) warnings.push(`${noEmail} of ${usage.length} rows have no email; emails come from the permission file where logins match.`);
    return { kind: 'lseg_usage', rows: usage, meta, warnings };
  }
  if (noEmail) warnings.push(`${noEmail} permission row(s) have no email address.`);
  const descs = new Map<string, Set<string>>();
  perms.forEach(p => { if (!descs.has(p.service_code)) descs.set(p.service_code, new Set()); descs.get(p.service_code)!.add(p.service_desc.toUpperCase()); });
  const incons = [...descs].filter(([, s]) => s.size > 1).map(([g]) => g);
  if (incons.length) warnings.push(`Services with more than one description: ${incons.join(', ')}. Matching uses Global_Name.`);
  const noFee = perms.filter(p => !p.fee_structure).length;
  if (noFee) warnings.push(`${noFee} row(s) have a blank FeeStructure.`);
  return { kind: 'lseg_permissions', rows: perms, siteServices, meta, warnings };
}

// ---------------------------------------------------------------------------
// Bloomberg B-PIPE usage. There is no single standard export, so columns are
// found by header name. Required: a user column and a security column.
// ---------------------------------------------------------------------------
const BPIPE_COLS: Record<string, RegExp> = {
  login: /^(user ?id|uuid|login|emrs ?user|user|bpipe ?user|application ?name)$/i,
  user_name: /^(user ?name|name|full ?name|display ?name)$/i,
  cost_centre: /^(cost ?cent(re|er)|cost ?ctr|cc)$/i,
  email: /^(e-?mail|email ?address)$/i,
  item: /^(security|ticker|instrument|identifier|security ?name|bbg ?ticker)$/i,
  service_code: /^(exchange( ?code)?|eid|service|entitlement|exch)$/i,
};
export function parseBpipeUsage(raw: string[][], encoding: string): ParsedSource {
  const rows = raw.map(r => r.map(clean));
  const hi = rows.slice(0, 30).findIndex(r => r.some(c => BPIPE_COLS.item.test(c)) && r.some(c => BPIPE_COLS.login.test(c)));
  if (hi < 0) throw new Error('Not a recognised file. Expected a DACS export, or a B-PIPE usage CSV with a user column (e.g. "User ID") and a security column (e.g. "Security").');
  const H = rows[hi];
  const idx = Object.fromEntries(Object.entries(BPIPE_COLS).map(([k, re]) => [k, H.findIndex(h => re.test(h))]));
  const out: UsageRow[] = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i]; if (isBlank(r)) continue;
    const g = (k: string) => (idx[k] >= 0 ? r[idx[k]] ?? '' : '');
    const o: UsageRow = { login: g('login'), user_name: g('user_name'), user_group: '', cost_centre: g('cost_centre'),
      email: g('email'), service_code: g('service_code'), service_desc: '', item: g('item') };
    if (o.login && o.item) out.push(o);
  }
  const warnings: string[] = [];
  if (encoding !== 'UTF-8') warnings.push(`File is ${encoding}-encoded, not UTF-8.`);
  const missing = ['user_name', 'cost_centre', 'email', 'service_code'].filter(k => idx[k] < 0);
  if (missing.length) warnings.push(`Optional columns not found: ${missing.join(', ')}.`);
  return { kind: 'bpipe_usage', rows: out, meta: { report: 'B-PIPE usage', version: '', generated: '', period: '' }, warnings };
}

// ---------------------------------------------------------------------------
// Vendor notice spreadsheet (first sheet as an array of rows)
// ---------------------------------------------------------------------------
export function parseNoticeSheet(aoa: unknown[][]): ParsedNoticeSheet {
  const warnings: string[] = [];
  const isHdr = (r: unknown[]) => r.some(c => /\b(ric|ticker|instrument|symbol|identifier|security)s?\b/i.test(String(c)));
  let hi = aoa.slice(0, 20).findIndex(isHdr);
  let H: string[];
  if (hi < 0) { hi = -1; H = (aoa[0] ?? []).map((_, i) => `Column ${i + 1}`); warnings.push('No header row found; using the first column as the instrument.'); }
  else H = aoa[hi].map(c => String(c).trim());
  const find = (re: RegExp, not?: RegExp) => H.findIndex(h => re.test(h) && !(not && not.test(h)));
  let instrument = find(/(old|current|existing|from).*(ric|ticker|security)|^(ric|ticker|instrument|symbol|security)s?$/i);
  if (instrument < 0) instrument = find(/ric|ticker|instrument|symbol|security/i, /new/i);
  if (instrument < 0) instrument = 0;
  const new_code = find(/new.*(ric|ticker|security)|(ric|ticker).*new|^to$/i);
  const change = find(/change|action|event|type/i);
  const effective = find(/effective|date/i);
  const rows: NoticeRow[] = [];
  for (let i = hi + 1; i < aoa.length; i++) {
    const r = aoa[i] ?? [];
    const v = String(r[instrument] ?? '').trim();
    if (!v) continue;
    let e: unknown = effective >= 0 ? r[effective] : '';
    if (e instanceof Date) e = e.toISOString().slice(0, 10);
    rows.push({ current_code: v, new_code: new_code >= 0 ? String(r[new_code] ?? '').trim() : '',
      change_type: change >= 0 ? String(r[change] ?? '').trim() : '', effective_label: String(e ?? '') });
  }
  if (!rows.length) warnings.push('No instrument rows found.');
  return { header: H, columns: { instrument, new_code, change, effective }, rows, warnings };
}

// ---------------------------------------------------------------------------
// LSEG Quarterly Change Summary (one row per service change; several rows can
// share a Notification ID). Returns rows keyed for import_change_summary().
// ---------------------------------------------------------------------------
export type ChangeSummaryRow = {
  notification_id: string; title: string; change_type: string; effective_from: string; effective_to: string;
  summary: string; description: string; published_date: string; revision_reason: string; affected_band: string;
  old_pdp: string; new_pdp: string; old_price: string; new_price: string; old_pe: string; new_pe: string;
  status: string; version: string; associated_ids: string; associated_products: string; content_set: string;
  related_links: string;
};
const SUMMARY_COLS: Record<keyof ChangeSummaryRow, RegExp> = {
  notification_id: /^notification id$/i, title: /^title$/i, change_type: /^change type$/i,
  effective_from: /^effective from$/i, effective_to: /^effective to$/i, summary: /^summary$/i,
  description: /^description$/i, published_date: /^version published date$/i, revision_reason: /^revision reason$/i,
  affected_band: /^number of affected instruments$/i, old_pdp: /^old service package/i, new_pdp: /^new service package/i,
  old_price: /^old price$/i, new_price: /^new price$/i, old_pe: /^old resource group/i, new_pe: /^new resource group/i,
  status: /^status$/i, version: /^version$/i, associated_ids: /^associated notification/i,
  associated_products: /^associated products$/i, content_set: /^content set$/i, related_links: /^related links$/i,
};
/** Excel dates arrive as Date (local midnight), serial numbers or strings. Return YYYY-MM-DD. */
export function toIsoDate(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) { const d = new Date(v.getTime() + 12 * 3600 * 1000); return d.toISOString().slice(0, 10); }
  if (typeof v === 'number') { const d = new Date(Math.round((v - 25569) * 86400 * 1000)); return d.toISOString().slice(0, 10); }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; // UK d/m/y
  return '';
}
export function isChangeSummary(aoa: unknown[][]): boolean {
  return aoa.slice(0, 10).some(r => r.some(c => /^notification id$/i.test(String(c).trim())));
}
export function parseChangeSummary(aoa: unknown[][]): { rows: ChangeSummaryRow[]; notices: number; warnings: string[] } {
  const hi = aoa.slice(0, 10).findIndex(r => r.some(c => /^notification id$/i.test(String(c).trim())));
  if (hi < 0) throw new Error('Not a Quarterly Change Summary: no "Notification ID" column found.');
  const H = aoa[hi].map(c => String(c).trim());
  const idx = Object.fromEntries(Object.entries(SUMMARY_COLS).map(([k, re]) => [k, H.findIndex(h => re.test(h))])) as Record<keyof ChangeSummaryRow, number>;
  const dates = new Set(['effective_from', 'effective_to', 'published_date']);
  const rows: ChangeSummaryRow[] = [];
  let badDates = 0;
  for (let i = hi + 1; i < aoa.length; i++) {
    const r = aoa[i] ?? [];
    const id = String(r[idx.notification_id] ?? '').trim();
    if (!id) continue;
    const o = {} as ChangeSummaryRow;
    for (const k of Object.keys(SUMMARY_COLS) as (keyof ChangeSummaryRow)[]) {
      const v = idx[k] >= 0 ? r[idx[k]] : '';
      if (dates.has(k)) { o[k] = toIsoDate(v); if (v !== '' && v != null && !o[k]) badDates++; }
      else o[k] = String(v ?? '').replace(/ /g, ' ').trim();
    }
    o.affected_band = o.affected_band.replace(/^'+|'+$/g, '');
    o.notification_id = id;
    rows.push(o);
  }
  const warnings: string[] = [];
  const missing = (Object.keys(SUMMARY_COLS) as (keyof ChangeSummaryRow)[]).filter(k => idx[k] < 0);
  if (missing.length) warnings.push(`Columns not found: ${missing.join(', ')}.`);
  if (badDates) warnings.push(`${badDates} date cell(s) could not be read.`);
  const notices = new Set(rows.map(r => r.notification_id)).size;
  return { rows, notices, warnings };
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
// Reads the vendor spreadsheet attached to a notice (in the "notice-files"
// bucket), stores its instruments and returns the match summary.

Deno.serve(req => handle(req, async () => {
  const { notice_id, storage_path, file_name } = await req.json();
  if (!notice_id || !storage_path) throw new HttpError(400, 'notice_id and storage_path are required.');
  const db = userClient(req);

  const { data: notice, error: nErr } = await db.from('notices').select('id, tenant_id, vendor, kind').eq('id', notice_id).single();
  if (nErr || !notice) throw new HttpError(404, 'Notice not found, or you do not have access to it.');
  if (!String(storage_path).startsWith(`${notice.tenant_id}/`)) throw new HttpError(400, 'storage_path must start with the tenant id.');

  const { data: blob, error: dlErr } = await db.storage.from('notice-files').download(storage_path);
  if (dlErr || !blob) throw new HttpError(404, `Couldn't read ${storage_path}: ${dlErr?.message ?? 'not found'}`);
  const wb = XLSX.read(new Uint8Array(await blob.arrayBuffer()), { type: 'array', cellDates: true });
  const sheet = wb.SheetNames[0];
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: '', raw: false }) as unknown[][];
  const parsed = parseNoticeSheet(aoa);
  if (!parsed.rows.length) throw new HttpError(400, 'No instrument rows found. Check the first sheet has a RIC or ticker column.');

  const H = parsed.header, c = parsed.columns;
  const name = (i: number) => (i >= 0 ? H[i] : null);
  const { data: file, error: fErr } = await db.from('notice_files').insert({
    tenant_id: notice.tenant_id, notice_id, file_name: file_name ?? storage_path.split('/').pop(), storage_path, sheet_name: sheet,
    detected_columns: { instrument: name(c.instrument), new_code: name(c.new_code), change: name(c.change), effective: name(c.effective) },
    row_count: parsed.rows.length,
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
  return json({ file_id: file.id, rows: parsed.rows.length, detected_columns: parsed.columns, warnings: parsed.warnings, impact });
}));
