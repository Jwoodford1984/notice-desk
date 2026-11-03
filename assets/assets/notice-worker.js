// Reads a vendor notice spreadsheet off the main thread, so large LSEG files
// (hundreds of thousands of rows) don't freeze the page.
// Message in:  { buffer: ArrayBuffer, vendor: 'LSEG'|'Bloomberg', codes?: string[], chains?: string[], pack?: boolean }
//   codes/chains: keep only rows whose code is in usage (omit to keep every row)
//   pack: return rows packed for the library upload ({ sets, packed }) instead of objects
// Message out: { ok: true, result } or { ok: false, error }, plus { progress } updates.
import * as XLSX from 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/xlsx.mjs';
import { parseNoticeWorkbook, sheetToRows, normaliseCode } from '../supabase/functions/_shared/notice-workbook.js';
import { packRows } from './library.js';

self.onmessage = e => {
  const { buffer, vendor, codes, chains, pack } = e.data;
  try {
    self.postMessage({ progress: 'Opening the spreadsheet…' });
    const wb = XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: true, dense: true });
    self.postMessage({ progress: codes ? 'Matching instruments against your usage…' : 'Reading every row…' });
    let keep;
    if (codes) {
      const used = new Set(codes); const chainBases = new Set(chains || []);
      keep = code => { const c = normaliseCode(code, vendor); return used.has(c) || chainBases.has(c); };
    }
    const result = parseNoticeWorkbook(wb.SheetNames.map(name => ({ name, load: () => sheetToRows(XLSX, wb.Sheets[name]) })), { keep });
    if (pack) {
      const { sets, packed } = packRows(result.rows, vendor);
      result.rows = []; result.sets = sets; result.packed = packed;
    }
    self.postMessage({ ok: true, result });
  } catch (err) {
    self.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
