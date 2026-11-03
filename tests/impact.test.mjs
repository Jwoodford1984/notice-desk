// Runs the impact engine against the local test library with a DACS permission
// file and a usage file (plus a few real RICs added for the test).
import fs from 'node:fs';
import pg from 'pg';
import { decode, parseSource } from '../assets/dacs-parsers.js';
import { buildReport, usageCodes, reportSheets } from '../assets/impact.js';
const [usagePath, permPath] = process.argv.slice(2);
const usage = parseSource(...Object.values(decode(fs.readFileSync(usagePath)))).rows;
const perms = parseSource(...Object.values(decode(fs.readFileSync(permPath)))).rows;
// Real Q4 RICs on logins from the permission file, to exercise each rule
const add = (login, user_name, item) => usage.push({ login, user_name, user_group: 'TEST', cost_centre: 'TST', email: '', service_code: '', service_desc: '', item });
add('abreg', 'Fabre Guillaume', 'CASaon.BT');        // DN217322: EXALL removed, needs BSM (abreg has EXALL, not BSM)
add('abreg', 'Fabre Guillaume', '/.PE19057');        // DN217236: Milan derivatives -> EUE (abreg has EUE)
add('gheue', 'Gheury Edmond', 'XS3063313616.TXd');   // DN217241
add('vreel', 'Van Reeth Luc', '0#MSI20M27');         // DN217366 (listed as a chain itself)
add('woodf', 'Woodford Jack', 'lERG10000C7.MI');     // DN216614 new market list
add('murex4_prd', 'Murex4 PRD Environment', '11COV.MI'); // DN217583 symbol list
const db = new pg.Client(); await db.connect();
const notices = (await db.query('select id::int, ref, vendor, title, change_types, to_char(effective_date, \'YYYY-MM-DD\') effective_date, summary from lib_notices')).rows;
const prices = (await db.query('select vendor, pdp, service_name, billed_by, user_charge::float, currency, site_licence::float, price_gbp::float from lib_prices')).rows;
const changes = (await db.query('select notice_id::int, old_pdp, new_pdp, old_pe, new_pe, old_price, new_price from lib_service_changes')).rows;
const codes = [...usageCodes(usage).keys()];
const matches = (await db.query('select code, notice_id::int, ref, new_code, change_type, ric_name, exchange_code, old_pdp, new_pdp, old_pe, new_pe from lib_match_codes($1, $2)', ['LSEG', codes])).rows;
await db.end();
const t = Date.now();
const r = buildReport({ usage, perms, notices, changes, matches, prices, today: '2026-11-03' });
console.log('built in', Date.now() - t, 'ms; codes sent', codes.length, 'matches', matches.length);
console.log(JSON.stringify(r.stats, null, 1));
for (const a of r.actions.slice(0, 14)) console.log(`[${a.category}] ${a.ref} ${a.due_label || a.due_date} | ${a.text.slice(0, 120)} | users: ${a.user_names.slice(0, 4).join(', ')}${a.users.length > 4 ? ' +' + (a.users.length - 4) : ''} | rics ${a.rics.length}`);
console.log('ric detail sample', JSON.stringify(r.ricDetail.slice(0, 3)));
const sheets = reportSheets(r, r.people); console.log('sheets', Object.fromEntries(Object.entries(sheets).map(([k, v]) => [k, v.length])));
console.log('cost stats', { urgent_cost_gbp: r.stats.urgent_cost_gbp, price_change_gbp: r.stats.price_change_gbp });
for (const a of r.actions.filter(a => a.cost_note).slice(0, 8)) console.log(`[${a.category}] ${a.ref}: ${a.cost_note}`);
