// Change summary import test.
// Run: SUMMARY_XLSX="/path/Q4 2026 Quarterly Change Summary.xlsx" npx tsx summary.test.mts > /tmp/summary_test.sql
// then: psql -d <test db> -f /tmp/summary_test.sql   (after run-db-tests.sh has built the database)
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { decode, parseSource, parseChangeSummary, toIsoDate } from '../supabase/functions/_shared/parsers.mts';
import fs from 'node:fs';

const file = process.env.SUMMARY_XLSX;
if (!file) { console.error('Set SUMMARY_XLSX to the Quarterly Change Summary path'); process.exit(1); }
const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer', cellDates: true });
const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true }) as unknown[][];
const p = parseChangeSummary(aoa);
const log = (m: string) => console.error('PASS:', m);
assert.ok(p.rows.length >= 200); log(`${p.rows.length} summary rows read`);
assert.equal(p.notices, 56); log('56 notifications');
assert.equal(p.rows.find(r => r.notification_id === 'DN216827')!.effective_from, '2026-10-05'); log('Excel dates read as 5 Oct 2026, not 4 Oct (timezone safe)');
assert.equal(p.rows.find(r => r.notification_id === 'DN216827')!.affected_band, '100-499'); log('affected band quotes stripped');
assert.equal(toIsoDate('05/10/2026'), '2026-10-05'); log('UK date strings read day-first');
assert.equal(p.warnings.length, 0, p.warnings.join('; ')); log('all columns found');

// Emit SQL: import twice into the demo tenant, then load the real DACS permission file into a second tenant
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const T = '00000000-0000-4000-8000-000000000001', R = '99999999-9999-4999-8999-999999999999';
const json = q(JSON.stringify(p.rows));
const perm = parseSource(decode(fs.readFileSync(new URL('../sample-data/Latest Permission file 040326.csv', import.meta.url))).text, 'Windows-1252');
let sql = `\\set ON_ERROR_STOP 1
begin;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if not ok then raise exception 'FAIL: %', label; end if; raise notice 'PASS: %', label; end $$;
select public.import_change_summary('${T}', 'Q4 2026 Quarterly Change Summary.xlsx', ${json}::jsonb) as first_import;
select pg_temp.check((select count(*) from notices where tenant_id='${T}' and source='LSEG Quarterly Change Summary') = 56, '56 notices created');
select pg_temp.check((select count(*) from notice_service_changes where tenant_id='${T}') = ${p.rows.length}, 'one service change per summary row');
update notices set status='in_review' where tenant_id='${T}' and ref='DN217021';
select pg_temp.check((public.import_change_summary('${T}', 'again.xlsx', ${json}::jsonb)->>'notices_updated')::int = 56, 're-import updates instead of duplicating');
select pg_temp.check((select status from notices where tenant_id='${T}' and ref='DN217021') = 'in_review', 're-import keeps the status you set');
select pg_temp.check((select effective_date from notices where tenant_id='${T}' and ref='DN216827') = date '2026-10-05', 'effective date stored');
select pg_temp.check((select split_codes(E'IT1, IT2, ITD,\\u00a0ID2,\\tIT2-WB')) = array['IT1','IT2','ITD','ID2','IT2-WB'], 'PDP lists with odd separators split cleanly');
-- Real permission file in its own tenant
insert into tenants(id,name,slug) values ('${R}','Real permissions','real-perms');
insert into data_sources(id,tenant_id,kind,file_name,row_count,is_current) values ('99999999-0000-4000-8000-0000000000b1','${R}','lseg_permissions','Latest Permission file 040326.csv',${perm.rows.length},true);
insert into permissions(tenant_id,source_id,login,user_name,email,service_code,service_desc,fee_structure,activated_label)
select '${R}','99999999-0000-4000-8000-0000000000b1',login,user_name,email,service_code,service_desc,fee_structure,activated_label
from jsonb_populate_recordset(null::permissions, ${q(JSON.stringify(perm.rows))}::jsonb);
select public.import_change_summary('${R}', 'Q4 2026 Quarterly Change Summary.xlsx', ${json}::jsonb);
select pg_temp.check((select count(*) from notice_impact where tenant_id='${R}' and cardinality(your_pdps) > 0) = 18, '18 of 56 notices touch PDPs in the real permission file');
\\echo
\\echo Notices affecting the real permission file:
select ref, effective_date, left(title, 60) as title, your_pdps, logins_permissioned from notice_impact where tenant_id='${R}' and cardinality(your_pdps) > 0 order by effective_date, ref;
select public.create_actions_for_notice((select id from notices where tenant_id='${R}' and ref='DN217021')) as actions_for_DN217021;
select owner_name, logins from actions a join notices n on n.id=a.notice_id where n.ref='DN217021' and a.tenant_id='${R}' order by owner_name;
rollback;
`;
console.log(sql);
