// Run from tests/: npm install && npm test  (or: npx tsx parsers.test.ts <usage.csv> <permissions.csv>)
// Without arguments it uses the files in sample-data/.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { decode, parseSource, parseNoticeSheet } from '../supabase/functions/_shared/parsers.mts';
import { bpipeCsv } from '../scripts/bpipe-sample.mjs';

const here = (p: string) => new URL(p, import.meta.url);
const usagePath = process.argv[2] ?? here('../sample-data/small_fake_usage_LSEG_Q2.csv');
const permsPath = process.argv[3] ?? here('../sample-data/Latest Permission file 040326.csv');
const ok = (label: string) => console.log('PASS:', label);

// LSEG usage
{
  const { text, encoding } = decode(fs.readFileSync(usagePath));
  const p = parseSource(text, encoding);
  assert.equal(p.kind, 'lseg_usage');
  assert.equal(p.rows.length, 89); ok('usage: 89 rows');
  assert.equal(p.meta.version, 'dacs7.11.0.F1'); ok('usage: DACS version read');
  assert.match(p.meta.period, /^02\/01\/2025/); ok('usage: period read from header, not file name');
  assert.ok(p.rows.every(r => !r.item.endsWith(';'))); ok('usage: trailing semicolons removed');
  assert.ok(p.rows.some(r => r.item === '/ANHQZ5-M6')); ok('usage: delayed RIC prefix kept raw (normalised in DB)');
  assert.ok(p.warnings.some(w => /UAccessPos/.test(w))); ok('usage: blank UAccessPos flagged');
}
// LSEG permissions
{
  const { text, encoding } = decode(fs.readFileSync(permsPath));
  assert.equal(encoding, 'Windows-1252'); ok('permissions: Windows-1252 detected');
  const p = parseSource(text, encoding);
  assert.equal(p.kind, 'lseg_permissions');
  if (p.kind !== 'lseg_permissions') throw new Error();
  assert.equal(p.rows.length, 184); ok('permissions: 184 rows');
  assert.equal(p.siteServices.length, 8); ok('permissions: 8 mapsite services');
  assert.ok(p.rows.some(r => r.user_name === 'Van Mullem Aurélie')); ok('permissions: accented name decoded');
  assert.ok(p.warnings.some(w => /CME, OE1/.test(w))); ok('permissions: inconsistent descriptions flagged');
  assert.ok(p.warnings.some(w => /repeated report header/.test(w))); ok('permissions: repeated headers ignored');
}
// B-PIPE usage
{
  const p = parseSource(bpipeCsv(), 'UTF-8');
  assert.equal(p.kind, 'bpipe_usage');
  assert.equal(p.rows.length, 14); ok('bpipe: 14 rows');
  assert.equal(p.rows[0].service_code, 'PW'); ok('bpipe: exchange code column mapped');
  assert.throws(() => parseSource('foo,bar\n1,2\n', 'UTF-8'), /Not a recognised file/); ok('unknown file rejected with a clear message');
}
// Notice spreadsheet (real .xlsx round trip with a title row above the header)
{
  const aoa = [['LSEG Data Notification DN-26-1142'], [], ['Current RIC', 'New RIC', 'Change Type', 'Effective Date'],
    ['ITEEU5Y36A=MP', 'ITEEU5Y44A=MP', 'RIC rename', new Date('2026-11-20')], ['CDXHY3Y37A=MP', '', 'Discontinued', new Date('2026-11-20')], ['', '', '', '']];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa, { cellDates: true }), 'Affected');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const back = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const rows = XLSX.utils.sheet_to_json(back.Sheets[back.SheetNames[0]], { header: 1, defval: '', raw: false }) as unknown[][];
  const p = parseNoticeSheet(rows);
  assert.deepEqual(p.columns, { instrument: 0, new_code: 1, change: 2, effective: 3 }); ok('notice: header found below title rows, columns detected');
  assert.equal(p.rows.length, 2); ok('notice: blank rows skipped');
  assert.equal(p.rows[0].new_code, 'ITEEU5Y44A=MP'); ok('notice: new RIC read');
  const t = parseNoticeSheet([['Old Ticker', 'New Ticker'], ['NGB1 PW Equity', 'NGX1 PW Equity']]);
  assert.equal(t.rows[0].current_code, 'NGB1 PW Equity'); ok('notice: Bloomberg ticker sheet detected');
}
console.log('All parser tests passed');
