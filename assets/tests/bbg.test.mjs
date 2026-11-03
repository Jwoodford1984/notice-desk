// Loads the Bloomberg quarterly report into the local test library and runs the
// impact report for the DACS B-PIPE permission and usage files.
// Usage: node bbg.test.mjs <BBG report.xlsx> <permissions.csv> <usage.csv>   (PG* env vars select the database)
import fs from 'node:fs';
import pg from 'pg';
import * as XLSX from 'xlsx/xlsx.mjs';
import { decode, parseSource, parseBbgReport } from '../supabase/functions/_shared/parsers.mts';
import { buildReport, vendorUsageCodes } from '../assets/impact.js';
const [reportPath, permPath, usagePath] = process.argv.slice(2);
const db = new pg.Client(); await db.connect();
const ADMIN = '11111111-aaaa-4aaa-8aaa-111111111111';
await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [ADMIN]);
await db.query('set role authenticated');
const wb = XLSX.read(fs.readFileSync(reportPath), { type: 'buffer', cellDates: true });
const b = parseBbgReport(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true }));
console.log('import', (await db.query('select lib_import_summary($1,$2,$3::jsonb) r', ['Bloomberg', 'Q4 2026', JSON.stringify(b.rows)])).rows[0].r);
const perms = parseSource(...Object.values(decode(fs.readFileSync(permPath)))).rows;
const usage = parseSource(...Object.values(decode(fs.readFileSync(usagePath)))).rows;
const notices = (await db.query("select id::int, ref, vendor, title, change_types, to_char(effective_date,'YYYY-MM-DD') effective_date, summary, vendor_status, action_required from lib_notices")).rows;
const prices = (await db.query('select vendor, pdp, service_name, billed_by, user_charge::float, currency, site_licence::float, price_gbp::float from lib_prices')).rows;
const changes = (await db.query('select notice_id::int, old_pdp,new_pdp,old_pe,new_pe,old_price,new_price from lib_service_changes')).rows;
const codes = vendorUsageCodes(usage);
const q = v => db.query('select code, notice_id::int, ref, new_code, change_type, ric_name, exchange_code, old_pdp, new_pdp, old_pe, new_pe from lib_match_codes($1,$2)', [v, codes[v]]);
const matches = (await q('LSEG')).rows, bbgMatches = (await q('Bloomberg')).rows;
await db.end();
const r = buildReport({ usage, perms, notices, changes, matches, bbgMatches, prices, today: '2026-11-03' });
const st = { ...r.stats }; delete st.by_category; console.log(st, r.stats.by_category);
for (const a of r.actions.filter(a => a.vendor === 'Bloomberg').slice(0, 14)) console.log(`[${a.category}] ${a.ref} | ${a.text.slice(0, 150)} | ${a.site ? 'ALL B-PIPE' : a.users.length + ' users'} | tickers ${a.rics.length}`);
console.log('bbg ric detail', r.ricDetail.filter(d => d.via === 'eid').slice(0, 4));
