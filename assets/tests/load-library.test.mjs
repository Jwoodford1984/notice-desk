// Loads the Q4 LSEG summary and notice files into a local test database the
// same way the admin page does, then reports timings and database size.
// Usage: node load-library.test.mjs <folder with the LSEG files>   (PG* env vars select the database)
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import * as XLSX from 'xlsx/xlsx.mjs';
import { parseNoticeWorkbook, sheetToRows } from '../supabase/functions/_shared/notice-workbook.js';
import { parseChangeSummary } from '../supabase/functions/_shared/parsers.mts';
import { loadIntoLibrary, refFromFileName, isSummaryFileName } from '../assets/library.js';

const dir = process.argv[2];
const db = new pg.Client(); await db.connect();
const ADMIN = '11111111-aaaa-4aaa-8aaa-111111111111';
await db.query(`insert into auth.users(id, email) values ($1, 'admin@cjc-test.example') on conflict do nothing`, [ADMIN]);
await db.query(`insert into public.app_admins(user_id) values ($1) on conflict do nothing`, [ADMIN]);
await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [ADMIN]);
await db.query(`set role authenticated`);
const JSONB = new Set(['p_sets', 'p_rows', 'p_sheets', 'p_columns']);
const rpc = async (name, args) => {
  const keys = Object.keys(args);
  const sql = `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}${JSONB.has(k) ? '::jsonb' : ''}`).join(', ')}) as r`;
  const res = await db.query(sql, keys.map(k => JSONB.has(k) ? JSON.stringify(args[k]) : args[k]));
  return res.rows[0].r;
};
const files = fs.readdirSync(dir).filter(f => /\.xlsx$/i.test(f));
const t0 = Date.now();
for (const f of files.filter(isSummaryFileName)) {
  const wb = XLSX.read(fs.readFileSync(path.join(dir, f)), { type: 'buffer', cellDates: true });
  const p = parseChangeSummary(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true }));
  console.log(f, JSON.stringify(await rpc('lib_import_summary', { p_vendor: 'LSEG', p_quarter: 'Q4 2026', p_rows: p.rows })));
}
for (const f of files.filter(f => !isSummaryFileName(f) && /^DN/i.test(f))) {
  const t = Date.now();
  const wb = XLSX.read(fs.readFileSync(path.join(dir, f)), { type: 'buffer', cellDates: true, dense: true });
  const parsed = parseNoticeWorkbook(wb.SheetNames.map(name => ({ name, load: () => sheetToRows(XLSX, wb.Sheets[name]) })));
  const tp = Date.now();
  const r = await loadIntoLibrary(rpc, { vendor: 'LSEG', ref: refFromFileName(f), fileName: f, quarter: 'Q4 2026', parsed });
  console.log(`${f}: ${parsed.total} rows, ${r.sets} PDP sets, parse ${tp - t}ms, upload ${Date.now() - tp}ms`);
}
await db.query('reset role');
const size = await db.query(`select pg_size_pretty(pg_total_relation_size('public.lib_instruments')) instr, pg_size_pretty(pg_total_relation_size('public.lib_pdp_sets')) sets, (select count(*) from public.lib_instruments) n`);
console.log('total', Date.now() - t0, 'ms', size.rows[0]);
await db.end();
