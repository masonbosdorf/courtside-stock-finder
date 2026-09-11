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
 * The Stock Finder POSTs one batch per "Log transfer" tap. Each line becomes one row on the
 * "Form Responses 1" tab in the same columns the Google Form writes, so nothing downstream changes:
 *   Timestamp | Employee | SKU | Column 10 | Quantity | From Bin | To Bin | Notes (Not Sizes) | Notes | Received to Bin
 *
 * Re-deploy (Deploy → Manage deployments → edit → New version) after any change to this file.
 */

const SHEET_NAME = 'Form Responses 1';
const SECRET = 'cs-stock-finder-2026';          // must match TRANSFER_SECRET in the Stock Finder's index.html
const SOURCE_TAG = 'Stock Finder';               // goes in "Notes (Not Sizes)" so these rows are easy to filter

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.secret !== SECRET) return json_({ ok: false, error: 'bad secret' });
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return json_({ ok: false, error: 'no rows' });

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
    const now = new Date();
    const staff = String(body.staff || '').trim() || 'Stock Finder';
    const out = rows.map(r => [
      now,                                            // Timestamp
      staff,                                          // Employee
      String(r.sku || '').trim(),                     // SKU - 1 Per Entry + SIZE PLEASE
      '',                                             // Column 10
      Number(r.qty) || 0,                             // Quantity
      String(r.from || '').trim(),                    // From Bin
      String(r.to || 'SALES FLOOR').trim(),           // To Bin
      SOURCE_TAG + (body.device ? ' · ' + body.device : ''),   // Notes (Not Sizes)
      String(r.note || '').trim(),                    // Notes
      '',                                             // Received to Bin
    ]).filter(r => r[2] && r[4] > 0 && r[5]);

    if (!out.length) return json_({ ok: false, error: 'nothing valid' });
    // append in one write so a batch is all-or-nothing
    const lock = LockService.getScriptLock(); lock.waitLock(10000);
    try { sh.getRange(sh.getLastRow() + 1, 1, out.length, out[0].length).setValues(out); }
    finally { lock.releaseLock(); }
    return json_({ ok: true, appended: out.length, batch: body.batch || null });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// health check: open the web app URL in a browser → {"ok":true,...}
function doGet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  return json_({ ok: true, sheet: sh.getName(), rows: sh.getLastRow() - 1 });
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
