// Parses the LSEG Exchange Prices workbook and loads it into the local test library.
// Usage: npx tsx prices.test.mts "<Q4 Exchange Prices 2026.xlsx>"   (PG* env vars select the database)
import fs from 'node:fs'; import * as XLSX from 'xlsx'; import pg from 'pg';
import { parseLsegPriceList, isPriceWorkbook } from '../supabase/functions/_shared/parsers.mts';
const wb = XLSX.read(fs.readFileSync(process.argv[2]), { type: 'buffer' });
console.log('price workbook:', isPriceWorkbook(wb.SheetNames));
const p = parseLsegPriceList(wb.SheetNames.map(n => ({ name: n, aoa: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '', raw: true }) as unknown[][] })));
console.log(p.rows.length, 'PDPs', p.warnings, p.rows.filter(r => ['BSM', 'IE2', 'CBL', 'SA8', 'OE1'].includes(r.pdp)).map(r => [r.pdp, r.user_charge, r.currency, r.price_gbp, r.billed_by, r.source]));
const db = new pg.Client(); await db.connect();
await db.query("select set_config('request.jwt.claim.sub','11111111-aaaa-4aaa-8aaa-111111111111',false)"); await db.query('set role authenticated');
console.log('imported', (await db.query('select lib_import_prices($1,$2,$3::jsonb) n', ['LSEG', 'Q4 2026', JSON.stringify(p.rows)])).rows[0].n);
await db.end();
