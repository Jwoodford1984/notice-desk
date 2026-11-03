// Parsers for LSEG DACS exports, Bloomberg B-PIPE usage CSVs and vendor
// notice spreadsheets. Pure functions with no Deno or Supabase imports, so
// they run in Edge Functions, in Node tests and in a browser.

export type UsageRow = {
  login: string; user_name: string; user_group: string; cost_centre: string; email: string;
  service_code: string; service_desc: string; item: string;
  /** DACS VService: IDN (LSEG), BPIPE (Bloomberg via DACS), ICE, ... and the site the row came from */
  v_service?: string; site?: string;
};
export type PermissionRow = {
  login: string; user_name: string; email: string; service_code: string; service_desc: string;
  fee_structure: string; activated_label: string;
  v_service?: string; site?: string;
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
  // A report can hold several sites, each with its own user table.
  const heads: number[] = [];
  rows.forEach((r, i) => { if (r[0] === 'SiteName' && r[1] === 'VService') heads.push(i); });
  if (!heads.length) throw new Error("Couldn't find the user table (a header row starting SiteName, VService).");
  const H0 = rows[heads[0]];
  const isUsage = H0.includes('Item');
  const isPerms = !isUsage && H0.includes('FeeStructure');
  if (!isUsage && !isPerms) throw new Error('Unsupported DACS report. Use Usage Detail by User or Active Permission by Exchange.');

  const usage: UsageRow[] = [], perms: PermissionRow[] = [];
  let blankPos = 0, dup = 0, noEmail = 0;
  const seen = new Set<string>();
  for (const hi of heads) {
  const H = rows[hi];
  const col = (n: string) => H.indexOf(n);
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    if (isBlank(r)) break;
    const g = (n: string) => (col(n) >= 0 ? r[col(n)] ?? '' : '');
    if (isUsage) {
      const o: UsageRow = { login: g('Login'), user_name: g('UName'), user_group: g('UGroup'), cost_centre: g('UCostCtr'),
        email: g('Email'), service_code: g('Global_Name'), service_desc: g('Description'), item: g('Item'),
        v_service: g('VService'), site: g('SiteName') };
      if (!o.item || !o.login) continue;
      if (!g('UAccessPos')) blankPos++;
      if (!o.email) noEmail++;
      const k = o.login + '|' + o.item; if (seen.has(k)) dup++; seen.add(k);
      usage.push(o);
    } else {
      const o: PermissionRow = { login: g('Login'), user_name: g('UName'), email: g('Email'), service_code: g('Global_Name'),
        service_desc: g('Description'), fee_structure: g('FeeStructure'), activated_label: g('Activation'),
        v_service: g('VService'), site: g('SiteName') };
      if (!o.login || !o.service_code) continue;
      if (!o.email) noEmail++;
      perms.push(o);
    }
  }
  }
  if (heads.length > 1) warnings.push(`Read ${heads.length} site tables (${[...new Set((isUsage ? usage : perms).map(r => r.site))].join(', ')}).`);
  const siteServices: SiteServiceRow[] = [];
  const mi = rows.findIndex(r => r[0] === 'mapsite');
  if (mi >= 0) for (let j = mi + 1; j < rows.length && !isBlank(rows[j]); j++) {
    const r = rows[j]; siteServices.push({ site_name: r[0], service_code: r[2], service_desc: r[3], fee_structure: r[4] });
  }
  const repeats = Math.max(0, rows.filter(r => r[0] === meta.report).length - heads.length);

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
  let badDates = 0, skipped = 0;
  for (let i = hi + 1; i < aoa.length; i++) {
    const r = aoa[i] ?? [];
    const id = String(r[idx.notification_id] ?? '').trim();
    if (!id) continue;
    if (/\s/.test(id) || id.length > 20) { skipped++; continue; } // footnotes and notes below the table
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
  if (skipped) warnings.push(`Skipped ${skipped} row(s) that aren't notices (notes below the table).`);
  const notices = new Set(rows.map(r => r.notification_id)).size;
  return { rows, notices, warnings };
}

// ---------------------------------------------------------------------------
// Bloomberg quarterly notice report (Real-Time Feeds & Technology). One row per
// notice; entitlements are Bloomberg EIDs ("14440-UBS Investment Bank::...").
// Rows come out in the same shape as parseChangeSummary, with EIDs in
// old_pdp/new_pdp and the EID names in old_pe/new_pe, plus action_required.
// ---------------------------------------------------------------------------
export type BbgReportRow = ChangeSummaryRow & { action_required: string };
const BBG_COLS: Record<string, RegExp> = {
  ref: /^ref\.? ?id/i, product: /^product$/i, release: /^release date/i, published: /^published date/i, summary: /^summary$/i,
  description: /^description$/i, category: /^category$/i, action: /^action required/i, subproducts: /^sub-?products/i,
  oldEid: /^old eid/i, newEid: /^new eid/i, asset: /^asset class/i, region: /^region$/i, revStatus: /^revision status/i,
  revDetails: /^revision details/i, fields: /^impacted bloomberg fields/i, attachments: /^attachments/i, driver: /^change driver/i,
};
export function isBbgReport(aoa: unknown[][]): boolean {
  return aoa.slice(0, 10).some(r => r.some(c => BBG_COLS.ref.test(String(c).trim())) && r.some(c => /eid/i.test(String(c))));
}
/** "14440-UBS Investment Bank::Zurich FX\n84936-EPEX SPOT SE" -> { ids: ['14440','84936'], names: [...] } */
export function parseEids(v: unknown): { ids: string[]; names: string[] } {
  const ids: string[] = [], names: string[] = [];
  for (const line of String(v ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
    if (/^n\/?a$/i.test(line) || /^does not apply/i.test(line)) continue;
    const m = line.match(/^(\d{3,})\s*(?:-\s*(.*))?$/);
    if (m) { ids.push(m[1]); names.push(m[2] ? `${m[1]} ${m[2]}` : m[1]); }
  }
  return { ids, names };
}
export function parseBbgReport(aoa: unknown[][]): { rows: BbgReportRow[]; notices: number; warnings: string[] } {
  const hi = aoa.slice(0, 10).findIndex(r => r.some(c => BBG_COLS.ref.test(String(c).trim())));
  if (hi < 0) throw new Error('Not a Bloomberg notice report: no "Ref. ID" column found.');
  const H = aoa[hi].map(c => String(c).replace(/\s+/g, ' ').trim());
  const idx = Object.fromEntries(Object.entries(BBG_COLS).map(([k, re]) => [k, H.findIndex(h => re.test(h))]));
  const g = (r: unknown[], k: string) => (idx[k] >= 0 ? String(r[idx[k]] ?? '').replace(/ /g, ' ').trim() : '');
  const raw = (r: unknown[], k: string) => (idx[k] >= 0 ? r[idx[k]] : '');
  const rows: BbgReportRow[] = []; let skipped = 0;
  for (let i = hi + 1; i < aoa.length; i++) {
    const r = aoa[i] ?? [];
    const ref = g(r, 'ref');
    if (!ref) continue;
    if (!/^\d+$/.test(ref)) { skipped++; continue; }
    const rel = raw(r, 'release');
    const relDates = typeof rel === 'string' ? (rel.match(/\d{4}-\d{2}-\d{2}/g) || []) : [];
    const from = relDates[0] || toIsoDate(rel); const to = relDates[1] || '';
    const oldE = parseEids(raw(r, 'oldEid')), newE = parseEids(raw(r, 'newEid'));
    const action = g(r, 'action');
    const actionHead = action.split(/\r?\n/)[0].trim();
    const actionBody = action.split(/\r?\n/).slice(1).join(' ').replace(/\s+/g, ' ').trim();
    const extra = [
      actionBody && `Action required (${actionHead}): ${actionBody}`,
      g(r, 'revDetails') && `Revision: ${g(r, 'revDetails')}`,
      g(r, 'fields') && `Impacted fields: ${g(r, 'fields').replace(/\r?\n/g, ', ')}`,
      g(r, 'driver') && `Change driver: ${g(r, 'driver')}`,
    ].filter(Boolean).join('\n\n');
    rows.push({
      notification_id: ref, title: g(r, 'summary') || ref, change_type: g(r, 'category'), effective_from: from, effective_to: to,
      summary: g(r, 'description'), description: [g(r, 'description'), extra].filter(Boolean).join('\n\n'),
      published_date: toIsoDate(raw(r, 'published')), revision_reason: g(r, 'revDetails'), affected_band: '',
      old_pdp: oldE.ids.join(','), new_pdp: newE.ids.join(','), old_price: '', new_price: '',
      old_pe: oldE.names.join('; '), new_pe: newE.names.join('; '),
      status: g(r, 'revStatus'), version: '', associated_ids: '', associated_products: g(r, 'subproducts').replace(/\r?\n/g, ', '),
      content_set: [g(r, 'asset'), g(r, 'region')].filter(v => v && !/^n\/a$/i.test(v)).join(' · '),
      related_links: g(r, 'attachments').replace(/\r?\n/g, ', '), action_required: actionHead,
    });
  }
  const warnings: string[] = [];
  if (skipped) warnings.push(`Skipped ${skipped} row(s) that aren't notices.`);
  const missing = ['ref', 'release', 'category', 'action', 'oldEid', 'newEid'].filter(k => idx[k] < 0);
  if (missing.length) warnings.push(`Columns not found: ${missing.join(', ')}.`);
  return { rows, notices: new Set(rows.map(r => r.notification_id)).size, warnings };
}
