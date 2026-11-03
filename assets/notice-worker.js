// Reads a vendor notice spreadsheet off the main thread, so large LSEG files
// (hundreds of thousands of rows) don't freeze the page.
// Message in:  { buffer: ArrayBuffer, vendor: 'LSEG'|'Bloomberg', codes: string[], chains: string[] }
// Message out: { ok: true, result } or { ok: false, error }, plus { progress } updates.
import * as XLSX from 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/xlsx.mjs';
import { parseNoticeWorkbook, sheetToRows, normaliseCode } from '../supabase/functions/_shared/notice-workbook.js';

self.onmessage = e => {
  const { buffer, vendor, codes, chains } = e.data;
  try {
    self.postMessage({ progress: 'Opening the spreadsheet…' });
    const wb = XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: true, dense: true });
    self.postMessage({ progress: 'Matching instruments against your usage…' });
    const used = new Set(codes);
    const chainBases = new Set(chains);
    const keep = code => { const c = normaliseCode(code, vendor); return used.has(c) || chainBases.has(c); };
    const result = parseNoticeWorkbook(wb.SheetNames.map(name => ({ name, load: () => sheetToRows(XLSX, wb.Sheets[name]) })), { keep });
    self.postMessage({ ok: true, result });
  } catch (err) {
    self.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
