// POST { notice_id, storage_path, file_name }
// Reads the vendor spreadsheet attached to a notice (in the "notice-files"
// bucket), stores its instruments and returns the match summary.
import * as XLSX from 'npm:xlsx@0.18.5';
import { parseNoticeSheet } from '../_shared/parsers.mts';
import { handle, HttpError, insertChunked, json, userClient } from '../_shared/supabase.ts';

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
