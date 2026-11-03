// POST { tenant_id, storage_path, file_name }
// Reads an LSEG Quarterly Change Summary uploaded to the "notice-files" bucket
// and creates or updates one notice per Notification ID.
import * as XLSX from 'npm:xlsx@0.18.5';
import { parseChangeSummary } from '../_shared/parsers.mts';
import { handle, HttpError, json, userClient } from '../_shared/supabase.ts';

Deno.serve(req => handle(req, async () => {
  const { tenant_id, storage_path, file_name } = await req.json();
  if (!tenant_id || !storage_path) throw new HttpError(400, 'tenant_id and storage_path are required.');
  if (!String(storage_path).startsWith(`${tenant_id}/`)) throw new HttpError(400, 'storage_path must start with the tenant id.');
  const db = userClient(req);

  const { data: blob, error: dlErr } = await db.storage.from('notice-files').download(storage_path);
  if (dlErr || !blob) throw new HttpError(404, `Couldn't read ${storage_path}: ${dlErr?.message ?? 'not found'}`);
  const wb = XLSX.read(new Uint8Array(await blob.arrayBuffer()), { type: 'array', cellDates: true });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true }) as unknown[][];
  const parsed = parseChangeSummary(aoa);
  if (!parsed.rows.length) throw new HttpError(400, 'The summary has no notification rows.');

  const { data, error } = await db.rpc('import_change_summary', {
    p_tenant_id: tenant_id, p_file_name: file_name ?? storage_path.split('/').pop(), p_rows: parsed.rows, p_storage_path: storage_path,
  });
  if (error) throw new HttpError(400, error.message);
  return json({ ...data, notices_in_file: parsed.notices, warnings: parsed.warnings });
}));
