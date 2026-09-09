/* stock-fetch.js — builds the Stock Finder data file from NetSuite.
   Two paginated SuiteQL pulls:
     A. Loc-2 warehouse bins with stock (active bins only), per SKU per bin, AVAILABLE qty
     B. Loc-22 sales floor (non-bin) AVAILABLE qty per SKU
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
         BUILTIN.DF(ibq.bin) AS bin, ibq.onhandavail AS avail
  FROM itembinquantity ibq
  JOIN item i ON i.id = ibq.item
  JOIN bin  b ON b.id = ibq.bin
  WHERE b.location = 2 AND b.isinactive = 'F' AND ibq.onhand > 0
  ORDER BY ibq.item, ibq.bin`;

const Q_FLOOR = `
  SELECT i.itemid AS sku, i.displayname AS name, i.upccode AS barcode,
         BUILTIN.DF(i.parent) AS parent, BUILTIN.DF(i.cseg_ps_brand) AS brand,
         ail.quantityavailable AS floor
  FROM aggregateitemlocation ail
  JOIN item i ON i.id = ail.item
  WHERE ail.location = 22 AND ail.quantityavailable > 0
  ORDER BY ail.item`;

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

  // Shopify POS prices — non-fatal: fall back to the previous seed's prices
  let prices = null, priceNote = '';
  try { prices = await fetchPrices(); priceNote = `${prices.size} priced (${[...prices.values()].filter(v => v.c).length} on sale)`; }
  catch (e) {
    console.error('shopify prices FAILED (carrying over previous): ' + e.message);
    prices = new Map();
    try { for (const it of JSON.parse(fs.readFileSync(SEED_PATH, 'utf8')).items) if (it[7] != null) prices.set(it[0], { p: it[7], c: it[8] || 0 }); } catch (e2) {}
    priceNote = `${prices.size} carried over`;
  }

  // item record: [sku, name, brand, barcode, parent(style-colour), floorAvail, [[bin, avail], ...], price|null, compareAt|0]
  // price = what Shopify POS rings up (ACTIVE products only); compareAt > 0 = on sale, compareAt is the full price
  const by = new Map();
  const rec = r => {
    const sku = String(r.sku || '').trim(); if (!sku) return null;
    if (!by.has(sku)) { const pr = prices.get(sku); by.set(sku, [sku, r.name || '', r.brand || '', r.barcode || '', r.parent || sku, 0, [], pr ? pr.p : null, pr ? pr.c : 0]); }
    return by.get(sku);
  };
  for (const r of bins)  { const it = rec(r); if (!it) continue; const a = Number(r.avail) || 0; if (a > 0) it[6].push([r.bin, a]); }
  for (const r of floor) { const it = rec(r); if (!it) continue; it[5] = Number(r.floor) || 0; }
  // drop SKUs that ended up with nothing available anywhere (all bin stock committed)
  const items = [...by.values()].filter(it => it[6].length || it[5] > 0).sort((a, b) => a[0].localeCompare(b[0]));

  const units = items.reduce((a, it) => a + it[6].reduce((x, b) => x + b[1], 0), 0);
  const binRows = items.reduce((a, it) => a + it[6].length, 0);
  const priced = items.filter(it => it[7] != null).length, onSale = items.filter(it => it[8]).length;
  const seed = { asOf: melbourneNow(), counts: { skus: items.length, binRows, units, floorSkus: floor.length, priced, onSale }, items };

  // plain JSON (not a JS file) so the browser can fetch + cache it and store it locally
  fs.writeFileSync(SEED_PATH, JSON.stringify(seed) + '\n');
  fs.writeFileSync(META_PATH, JSON.stringify({ asOf: seed.asOf, ...seed.counts }) + '\n');
  console.log(`stock-fetch OK: ${items.length} SKUs, ${binRows} bin rows, ${units} units avail in bins, ${floor.length} floor SKUs · prices: ${priceNote}, ${priced} in-stock SKUs priced, ${onSale} on sale · ${((Date.now() - t0) / 1000).toFixed(1)}s · ${(fs.statSync(SEED_PATH).size / 1024).toFixed(0)} KB`);
}
main().catch(e => { console.error('stock-fetch FAILED: ' + e.message); process.exit(1); });
