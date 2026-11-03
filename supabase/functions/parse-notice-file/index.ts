// POST { notice_id, storage_path, file_name }
// Reads a vendor notice spreadsheet attached to a notice (in the "notice-files"
// bucket), stores every instrument row and returns the match summary.
// Every sheet is read, so LSEG files with remove / addNew / update tabs work.
// Edge Functions have tight CPU limits: for files over a few thousand rows the
// web app reads the file in the browser instead and stores only matched rows.
import * as XLSX from 'npm:xlsx@0.18.5';
import { parseNoticeWorkbook, sheetToRows } from '../_shared/notice-workbook.js';
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
