/* stock-fetch.js — builds the Stock Finder data file from NetSuite.
   Two paginated SuiteQL pulls:
     A. Loc-2 warehouse bins with stock (active bins only), per SKU per bin, AVAILABLE qty
     B. Loc-22 sales floor (non-bin) AVAILABLE qty per SKU
   Plus the Warehouse Sale (loc 27, no bins) on hand per SKU — item[13] — and, for those SKUs, the
   loc-2 bins the stock left from with a qty each (item[14] = [[bin, qty]…]), read off SWISH's send
   transfers: SND-… (one per WHS tote, apparel + accessories) and SNF-… (footwear, the boxes stay on
   their shelves). The moved qty is shared out over loc 27's on hand, so sales take it down. item[15] =
   the WH Sale price (size price / WHS26-* tag price / % off RRP from whsale-prices.json, never above the POS price), so the
   page can flag sale stock with what it rings up at. All non-fatal and empty outside the sale.
   Plus the Shopify POS price per SKU (shopify-prices.js): price + compare-at (full price when on
   sale). If Shopify fails, prices are carried over from the previous seed so a hiccup never blanks
   them. Merged by SKU and written to stock-seed.json + stock-meta.json (asOf only, what the browser polls). Non-fatal by design: on any fetch error, or an implausibly small
   result, it exits non-zero WITHOUT writing so a NetSuite hiccup never clobbers a good seed.
   Usage: node stock-fetch.js [stock-seed.json path] */
const fs   = require('fs');
const path = require('path');
const { suiteqlAll } = require('./netsuite');
const { fetchPrices } = require('./shopify-prices');

const SEED_PATH = path.resolve(process.argv[2] || 'stock-seed.json');
const META_PATH = path.join(path.dirname(SEED_PATH), 'stock-meta.json');
const TZ = 'Australia/Melbourne';

// `onhandavail` / `quantityavailable` (not on-hand): units already committed to open web
// orders are spoken for, and the floor must not promise them to a walk-in customer.
const Q_BINS = `
  SELECT i.itemid AS sku, i.displayname AS name, i.upccode AS barcode,
         BUILTIN.DF(i.parent) AS parent, BUILTIN.DF(i.cseg_ps_brand) AS brand,
         BUILTIN.DF(ibq.bin) AS bin, ibq.onhandavail AS avail, ibq.onhand AS onhand
  FROM itembinquantity ibq
  JOIN item i ON i.id = ibq.item
  JOIN bin  b ON b.id = ibq.bin
  WHERE b.location = 2 AND b.isinactive = 'F' AND ibq.onhand > 0
  ORDER BY ibq.item, ibq.bin`;

const Q_FLOOR = `
  SELECT i.itemid AS sku, i.displayname AS name, i.upccode AS barcode,
         BUILTIN.DF(i.parent) AS parent, BUILTIN.DF(i.cseg_ps_brand) AS brand,
         ail.quantityavailable AS floor, ail.quantityonhand AS flooroh
  FROM aggregateitemlocation ail
  JOIN item i ON i.id = ail.item
  WHERE ail.location = 22 AND ail.quantityonhand > 0
  ORDER BY ail.item`;

// Warehouse Sale (Nov 2026): SWISH moves marked footwear loc 2 → 27 straight out of its bins (the boxes
// physically stay put). 27 has no bins, so the bins come from those transfers' inventory detail.
const Q_SALE = `
  SELECT i.itemid AS sku, i.displayname AS name, i.upccode AS barcode,
         BUILTIN.DF(i.parent) AS parent, BUILTIN.DF(i.cseg_ps_brand) AS brand,
         ail.quantityonhand AS sale
  FROM aggregateitemlocation ail
  JOIN item i ON i.id = ail.item
  WHERE ail.location = 27 AND ail.quantityonhand > 0
  ORDER BY ail.item`;
const SNF = `t.recordtype = 'inventorytransfer' AND (t.externalid LIKE 'SNF-%' OR t.externalid LIKE 'SND-%')`;
const Q_SNF_LINES = `
  SELECT tl.transaction AS tid, tl.id AS lid, i.itemid AS sku
  FROM transactionline tl JOIN transaction t ON t.id = tl.transaction JOIN item i ON i.id = tl.item
  WHERE ${SNF} AND tl.mainline = 'F'
  ORDER BY tl.transaction, tl.id`;
const Q_SNF_BINS = `
  SELECT ia.id AS iaid, ia.transaction AS tid, ia.transactionline AS lid, BUILTIN.DF(ia.bin) AS bin, ia.quantity AS qty
  FROM inventoryassignment ia JOIN transaction t ON t.id = ia.transaction
  WHERE ${SNF} AND ia.bin IS NOT NULL
  ORDER BY ia.id`;

/* SKU → Map(bin → units its Warehouse Sale moves took out of that bin) */
async function saleBins() {
  const lines = await suiteqlAll(Q_SNF_LINES);
  if (!lines.length) return new Map();
  const skuOf = new Map(lines.map(l => [`${l.tid}:${l.lid}`, String(l.sku || '').trim().toUpperCase()]));
  const out = new Map();
  for (const a of await suiteqlAll(Q_SNF_BINS)) {
    const sku = skuOf.get(`${a.tid}:${a.lid}`), bin = String(a.bin || '').trim();
    if (!sku || !bin) continue;
    if (!out.has(sku)) out.set(sku, new Map());
    const m = out.get(sku); m.set(bin, (m.get(bin) || 0) + Math.abs(Number(a.qty) || 0));
  }
  return out;
}

/* WH Sale price rules (a copy of the wh-sale-pricing discount's config): prices = WHS26-* tag → $,
   percentOff = tag → % off RRP (compare-at when marked down, else price), skuPrices = one size → $ */
function loadSalePrices() {
  try { const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'whsale-prices.json'), 'utf8')); return { prices: j.prices || {}, percentOff: j.percentOff || {}, skuPrices: j.skuPrices || {} }; }
  catch (e) { console.error('whsale-prices.json unreadable: ' + e.message); return { prices: {}, percentOff: {}, skuPrices: {} }; }
}

/* what the WHSALE-NOV26 code rings a SKU up at: the lowest of its size price, tag price and % off,
   never above the POS price — the same rule as the discount function. null = not in the sale */
function salePrice(ws, sku, pr) {
  const c = [ws.skuPrices[sku.toUpperCase()]];
  if (pr && pr.w) {
    c.push(ws.prices[pr.w]);
    if (ws.percentOff[pr.w] != null) c.push(Math.round(Math.max(pr.p, pr.c || 0) * (100 - ws.percentOff[pr.w])) / 100);
  }
  const ok = c.map(Number).filter(v => isFinite(v) && v >= 0);
  if (!ok.length) return null;
  return pr && pr.p != null ? Math.min(pr.p, ...ok) : Math.min(...ok);
}

// sanity floors — a pull far below these means NetSuite returned a partial result
const MIN_BIN_ROWS = 2000, MIN_FLOOR_ROWS = 500;

function melbourneNow() {
  const now = new Date();
  // hourCycle:'h23' is REQUIRED — hour12:false renders midnight as "24:00" (invalid ISO).
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const o = {}; for (const p of f.formatToParts(now)) o[p.type] = p.value;
  const off = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
    .formatToParts(now).find(x => x.type === 'timeZoneName').value.replace('GMT', '') || '+10:00';
  return `${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}:${o.second}${off}`;
}

async function main() {
  const t0 = Date.now();
  const bins  = await suiteqlAll(Q_BINS);
  const floor = await suiteqlAll(Q_FLOOR);
  if (bins.length < MIN_BIN_ROWS)   throw new Error(`only ${bins.length} bin rows — looks partial, not writing`);
  if (floor.length < MIN_FLOOR_ROWS) throw new Error(`only ${floor.length} floor rows — looks partial, not writing`);

  // Warehouse Sale — non-fatal (empty outside the sale)
  let sale = [], sBins = new Map(), saleNote = '';
  try { sale = await suiteqlAll(Q_SALE); if (sale.length) sBins = await saleBins(); }
  catch (e) { console.error('warehouse sale stock FAILED (skipped): ' + e.message); saleNote = ' (sale pull failed)'; }

  // Shopify POS prices — non-fatal: fall back to the previous seed's prices
  let prices = null, priceNote = '';
  try { prices = await fetchPrices(); priceNote = `${prices.size} priced (${[...prices.values()].filter(v => v.c).length} on sale)`; }
  catch (e) {
    console.error('shopify prices FAILED (carrying over previous): ' + e.message);
    prices = new Map();
    try { for (const it of JSON.parse(fs.readFileSync(SEED_PATH, 'utf8')).items) if (it[7] != null) prices.set(it[0], { p: it[7], c: it[8] || 0, t: it[9] || '', g: it[10] || '', o: it[11] || 0, ws: it[15] ?? null }); } catch (e2) {}
    priceNote = `${prices.size} carried over`;
  }

  // item record: [sku, name, brand, barcode, parent(style-colour), floorAvail, [[bin, avail, held], ...], price|null, compareAt|0, productType, tags, online 1|0, floorHeld, whSale?, [[saleBin, qty]…]?, whSalePrice?]
  // held = on hand minus available = units committed to open orders (on the shelf, but spoken for)
  // price = what Shopify POS rings up (ACTIVE products only); compareAt > 0 = on sale, compareAt is the full price
  const by = new Map();
  const rec = r => {
    const sku = String(r.sku || '').trim(); if (!sku) return null;
    if (!by.has(sku)) { const pr = prices.get(sku); by.set(sku, [sku, r.name || '', r.brand || '', r.barcode || '', r.parent || sku, 0, [], pr ? pr.p : null, pr ? pr.c : 0, pr ? pr.t : '', pr ? pr.g : '', pr ? pr.o : 0, 0]); }
    return by.get(sku);
  };
  for (const r of bins)  { const it = rec(r); if (!it) continue; const a = Number(r.avail) || 0, oh = Number(r.onhand) || 0; if (a > 0 || oh > 0) it[6].push([r.bin, a, Math.max(0, oh - a)]); }
  for (const r of floor) { const it = rec(r); if (!it) continue; it[5] = Number(r.floor) || 0; it[12] = Math.max(0, (Number(r.flooroh) || 0) - it[5]); }
  // whSale = on hand at the Warehouse Sale (loc 27); saleBins = where it physically sits — the moved qty per
  // bin, shared out over what's still on hand in bin order (sales take it down); salePrice = the WH Sale price
  const wsPrices = loadSalePrices();
  for (const r of sale) {
    const it = rec(r); if (!it) continue;
    let left = it[13] = Number(r.sale) || 0;
    const b = sBins.get(it[0].toUpperCase());
    if (b && b.size) it[14] = [...b].sort((x, y) => x[0].localeCompare(y[0], 'en', { numeric: true })).map(([bin, q]) => { const n = Math.max(0, Math.min(q, left)); left -= n; return [bin, n]; });
    const pr = prices.get(it[0]), tp = pr && pr.ws != null ? pr.ws : salePrice(wsPrices, it[0], pr);
    if (tp != null) it[15] = it[7] != null ? Math.min(Number(tp), it[7]) : Number(tp);
  }
  // keep SKUs with anything on hand anywhere — fully-held stock still shows, flagged as held
  const items = [...by.values()].filter(it => it[6].length || it[5] > 0 || it[12] > 0 || it[13] > 0).sort((a, b) => a[0].localeCompare(b[0]));

  const units = items.reduce((a, it) => a + it[6].reduce((x, b) => x + b[1], 0), 0), held = items.reduce((a, it) => a + it[6].reduce((x, b) => x + (b[2] || 0), 0) + (it[12] || 0), 0);
  const binRows = items.reduce((a, it) => a + it[6].length, 0);
  const priced = items.filter(it => it[7] != null).length, onSale = items.filter(it => it[8]).length, online = items.filter(it => it[11]).length;
  const whSale = items.reduce((a, it) => a + (it[13] || 0), 0);
  const seed = { asOf: melbourneNow(), counts: { skus: items.length, binRows, units, held, floorSkus: floor.length, priced, onSale, online, whSale }, items };

  // plain JSON (not a JS file) so the browser can fetch + cache it and store it locally
  fs.writeFileSync(SEED_PATH, JSON.stringify(seed) + '\n');
  fs.writeFileSync(META_PATH, JSON.stringify({ asOf: seed.asOf, ...seed.counts }) + '\n');
  console.log(`stock-fetch OK: ${items.length} SKUs, ${binRows} bin rows, ${units} units avail in bins, ${floor.length} floor SKUs · prices: ${priceNote}, ${priced} in-stock SKUs priced, ${onSale} on sale, ${online} online · ${held} units held · ${whSale} at the Warehouse Sale${saleNote} · ${((Date.now() - t0) / 1000).toFixed(1)}s · ${(fs.statSync(SEED_PATH).size / 1024).toFixed(0)} KB`);
}
main().catch(e => { console.error('stock-fetch FAILED: ' + e.message); process.exit(1); });
