// POST { tenant_id, storage_path, file_name, expected_kind? }
// Reads a usage or permission file the user has uploaded to the "source-files"
// bucket, loads its rows and makes it the current source for that kind.
import { decode, parseSource } from '../_shared/parsers.mts';
import { handle, HttpError, insertChunked, json, userClient } from '../_shared/supabase.ts';

Deno.serve(req => handle(req, async () => {
  const { tenant_id, storage_path, file_name, expected_kind } = await req.json();
  if (!tenant_id || !storage_path) throw new HttpError(400, 'tenant_id and storage_path are required.');
  if (!String(storage_path).startsWith(`${tenant_id}/`)) throw new HttpError(400, 'storage_path must start with the tenant id.');
  const db = userClient(req);

  const { data: blob, error: dlErr } = await db.storage.from('source-files').download(storage_path);
  if (dlErr || !blob) throw new HttpError(404, `Couldn't read ${storage_path}: ${dlErr?.message ?? 'not found'}`);
  const { text, encoding } = decode(new Uint8Array(await blob.arrayBuffer()));
  const parsed = parseSource(text, encoding);
  if (expected_kind && parsed.kind !== expected_kind) {
    throw new HttpError(400, `This file is a ${parsed.kind.replace('_', ' ')} report, not ${String(expected_kind).replace('_', ' ')}.`);
  }

  const { data: src, error: srcErr } = await db.from('data_sources').insert({
    tenant_id, kind: parsed.kind, file_name: file_name ?? storage_path.split('/').pop(), storage_path,
    report_version: parsed.meta.version || null, generated_label: parsed.meta.generated || null,
    period_label: parsed.meta.period || null, row_count: parsed.rows.length, warnings: parsed.warnings, is_current: false,
  }).select('id').single();
  if (srcErr) throw new HttpError(400, srcErr.message);

  try {
    if (parsed.kind === 'lseg_permissions') {
      await insertChunked(db, 'permissions', parsed.rows.map(r => ({ ...r, tenant_id, source_id: src.id })));
      await insertChunked(db, 'site_services', parsed.siteServices.map(r => ({ ...r, tenant_id, source_id: src.id })));
    } else {
      const vendor = parsed.kind === 'bpipe_usage' ? 'Bloomberg' : 'LSEG';
      await insertChunked(db, 'usage_items', parsed.rows.map(r => ({ ...r, tenant_id, source_id: src.id, vendor })));
    }
    // Only now does matching switch to the new file
    const { error: actErr } = await db.rpc('activate_source', { p_source_id: src.id });
    if (actErr) throw new HttpError(400, actErr.message);
  } catch (e) {
    await db.from('data_sources').delete().eq('id', src.id); // rows cascade
    throw e;
  }

  return json({ source_id: src.id, kind: parsed.kind, rows: parsed.rows.length, meta: parsed.meta, warnings: parsed.warnings });
}));
