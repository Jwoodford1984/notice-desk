// Loading notice spreadsheets into the shared library. Used by the admin page
// in the browser and by the test loader in tests/. No DOM or Supabase imports:
// the caller passes `rpc(name, args)` which returns the function's result.
import { normaliseCode } from '../supabase/functions/_shared/notice-workbook.js';

/** Work out the notice reference from a file name: "DN217322.xlsx" -> "DN217322". */
export function refFromFileName(name) {
  const base = String(name).replace(/\.[^.]+$/, '');
  const dn = base.match(/\bDN\s?-?\s?(\d{5,})/i);
  if (dn) return 'DN' + dn[1];
  return base.trim();
}

/** Spot the Quarterly Change Summary among dropped files. */
export const isSummaryFileName = name => /change summary|quarterly/i.test(name);

/**
 * Pack parsed rows for upload: distinct PDP/PE combinations are sent once
 * ("sets") and each row refers to its set by number.
 */
export function packRows(rows, vendor) {
  const setIdx = new Map(); const sets = []; const packed = [];
  for (const r of rows) {
    let i = '';
    if (r.old_pdp || r.new_pdp || r.old_pe || r.new_pe) {
      const key = `${r.old_pdp}\u0001${r.new_pdp}\u0001${r.old_pe}\u0001${r.new_pe}`;
      i = setIdx.get(key);
      if (!i) { sets.push([r.old_pdp || '', r.new_pdp || '', r.old_pe || '', r.new_pe || '']); i = sets.length; setIdx.set(key, i); }
    }
    packed.push([normaliseCode(r.current_code, vendor), r.new_code || '', r.change_type || '', i, r.ric_name || '', r.exchange_code || '']);
  }
  return { sets, packed };
}

/**
 * Load one parsed notice file (from parseNoticeWorkbook) into the library.
 * @param {(name: string, args: object) => Promise<any>} rpc
 */
export async function loadIntoLibrary(rpc, { vendor, ref, fileName, quarter, parsed }, onProgress = () => {}) {
  const { sets, packed } = parsed.packed ? parsed : packRows(parsed.rows, vendor);
  const fileId = await rpc('lib_begin_file', {
    p_vendor: vendor, p_ref: ref, p_file_name: fileName, p_total: parsed.total,
    p_sheets: parsed.sheets, p_columns: parsed.columns, p_quarter: quarter || null,
  });
  for (let i = 0; i < sets.length; i += 2000) {
    await rpc('lib_add_sets', { p_file_id: fileId, p_sets: sets.slice(i, i + 2000), p_offset: i });
  }
  const step = 10000;
  for (let i = 0; i < packed.length; i += step) {
    await rpc('lib_add_rows', { p_file_id: fileId, p_rows: packed.slice(i, i + step) });
    onProgress(Math.min(i + step, packed.length), packed.length);
  }
  await rpc('lib_finish_file', { p_file_id: fileId });
  return { fileId, rows: packed.length, sets: sets.length };
}
