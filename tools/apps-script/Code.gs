/**
 * Courtside Internal Transfers — Stock Finder logger
 * ---------------------------------------------------
 * Paste this into the "Courtside Internal Transfers" spreadsheet:
 *   Extensions → Apps Script → replace everything in Code.gs with this file → Save
 *   Deploy → New deployment → type: Web app
 *     Description: Stock Finder logger
 *     Execute as:  Me
 *     Who has access: Anyone
 *   → Deploy → authorise when asked → copy the Web app URL and send it to Claude.
 *
 * The Stock Finder POSTs one batch per "Log transfer" tap. Each line becomes one row on "Sheet1".
 * If Sheet1 is empty the script writes these headers first; if it already has a header row, values
 * are placed by matching header names (timestamp / employee / sku / quantity / from / to / notes /
 * source / batch / status), and any header it doesn't recognise is left blank:
 *   Timestamp | Employee | SKU | Quantity | From Bin | To Bin | Notes | Source | Batch | Status
 *
 * Re-deploy (Deploy → Manage deployments → edit → New version) after any change to this file.
 */

const SHEET_NAME = 'Sheet1';                     // created with clean headers if it doesn't exist / is empty
const SECRET = 'cs-stock-finder-2026';          // must match TRANSFER_SECRET in the Stock Finder's index.html
const SOURCE_TAG = 'Stock Finder';               // goes in "Notes (Not Sizes)" so these rows are easy to filter

const HEADERS = ['Timestamp', 'Employee', 'SKU', 'Quantity', 'From Bin', 'To Bin', 'Notes', 'Source', 'Batch', 'Status'];

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.secret !== SECRET) return json_({ ok: false, error: 'bad secret' });
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return json_({ ok: false, error: 'no rows' });

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName(SHEET_NAME);
    if (!sh) sh = ss.insertSheet(SHEET_NAME);
    if (sh.getLastRow() === 0) { sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold'); sh.setFrozenRows(1); }

    // map our fields onto whatever headers the sheet has
    const hdr = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(h => String(h).toLowerCase());
    const col = key => { const i = hdr.findIndex(h => h.includes(key)); return i; };
    const idx = { ts: col('timestamp') >= 0 ? col('timestamp') : col('date'), emp: col('employee') >= 0 ? col('employee') : col('staff'), sku: col('sku') >= 0 ? col('sku') : col('item'),
                  qty: col('quantity') >= 0 ? col('quantity') : col('qty'), from: col('from'), to: col('to bin') >= 0 ? col('to bin') : col('to'), note: col('note'), src: col('source'), batch: col('batch'), status: col('status') };
    const width = Math.max(hdr.length, HEADERS.length);
    const now = new Date();
    const staff = String(body.staff || '').trim() || 'Stock Finder';
    const out = [];
    for (const r of rows) {
      const sku = String(r.sku || '').trim(), qty = Number(r.qty) || 0, from = String(r.from || '').trim();
      if (!sku || qty <= 0 || !from) continue;
      const row = new Array(width).fill('');
      const put = (i, v) => { if (i >= 0) row[i] = v; };
      put(idx.ts, now); put(idx.emp, staff); put(idx.sku, sku); put(idx.qty, qty); put(idx.from, from);
      put(idx.to, String(r.to || 'SALES FLOOR').trim()); put(idx.note, String(r.note || '').trim());
      put(idx.src, SOURCE_TAG + (body.device ? ' · ' + body.device : '')); put(idx.batch, String(body.batch || '')); put(idx.status, '');
      out.push(row);
    }
    if (!out.length) return json_({ ok: false, error: 'nothing valid' });
    // append in one write so a batch is all-or-nothing
    const lock = LockService.getScriptLock(); lock.waitLock(10000);
    try { sh.getRange(sh.getLastRow() + 1, 1, out.length, width).setValues(out); }
    finally { lock.releaseLock(); }
    return json_({ ok: true, appended: out.length, sheet: sh.getName(), batch: body.batch || null });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// health check: open the web app URL in a browser → {"ok":true,...}
function doGet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_NAME);
  return json_({ ok: true, sheet: sh ? sh.getName() : SHEET_NAME + ' (will be created)', rows: sh ? Math.max(0, sh.getLastRow() - 1) : 0 });
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
