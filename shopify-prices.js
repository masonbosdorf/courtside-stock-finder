/* shopify-prices.js — the price a SKU rings up at on Shopify POS.
   Pulls every product variant (sku, price, compareAtPrice, product status) via the Admin API and
   returns Map<sku, { p: price, c: compareAtPrice|0, t: productType, g: tags, o: 1|0 online }> (o = ACTIVE and published to the
   Online Store — `onlineStoreUrl` is only set when the product is live on that channel) (g = the audience/category
   tags the search uses: Mens Womens Unisex Youth Kids Toddler Boys Girls APPAREL FOOTWEAR ACCESSORIES …). Only ACTIVE products are sellable at POS —
   DRAFT/ARCHIVED variants are skipped so the page shows "not on POS" instead of a dead price.
   compareAtPrice > price means the item is on sale: compareAt is the full price, price is what
   the customer pays. ~40 pages of 250, well inside the Plus throttle (20k bucket, 1k/s restore).
   Module: const { fetchPrices } = require('./shopify-prices'); const m = await fetchPrices();
   CLI:    node shopify-prices.js            (prints counts + a few samples) */
const { graphql } = require('./shopify');

const KEEP_TAGS = new Set(['Mens','Womens','Unisex','Youth','Kids','Toddler','Boys','Girls','Adult','APPAREL','FOOTWEAR','ACCESSORIES','Lifestyle','Basketball','Training','Hydration']);
const Q = `query($a:String){ productVariants(first:250, after:$a){
  nodes{ sku price compareAtPrice product{ status productType tags onlineStoreUrl publishedAt } }
  pageInfo{ hasNextPage endCursor } } }`;

async function gql(vars) {
  for (let i = 0; i < 6; i++) {
    try { return await graphql(Q, vars); }
    catch (e) { if (/THROTTLED|Throttled|exceeded/i.test(e.message) && i < 5) { await new Promise(r => setTimeout(r, 1500 * (i + 1))); continue; } throw e; }
  }
}

async function fetchPrices() {
  const out = new Map();
  let after = null, pages = 0, variants = 0;
  for (;;) {
    const d = await gql({ a: after });
    const pv = d.productVariants;
    for (const v of pv.nodes) {
      variants++;
      const sku = String(v.sku || '').trim();
      if (!sku || (v.product && v.product.status !== 'ACTIVE')) continue;
      const p = Number(v.price), c = v.compareAtPrice != null ? Number(v.compareAtPrice) : 0;
      if (!isFinite(p)) continue;
      // duplicate SKUs across variants: keep the first ACTIVE one seen
      if (!out.has(sku)) out.set(sku, { p, c: c > p ? c : 0, t: (v.product && v.product.productType) || '', g: ((v.product && v.product.tags) || []).filter(x => KEEP_TAGS.has(x)).join(' '), o: (v.product && (v.product.onlineStoreUrl || v.product.publishedAt)) ? 1 : 0 });
    }
    pages++;
    if (!pv.pageInfo.hasNextPage) break;
    after = pv.pageInfo.endCursor;
  }
  return Object.assign(out, { pages, variants });
}

module.exports = { fetchPrices };

if (require.main === module) {
  fetchPrices().then(m => {
    const onSale = [...m.values()].filter(v => v.c).length;
    console.log(`variants=${m.variants} pages=${m.pages} priced ACTIVE skus=${m.size} on sale=${onSale}`);
    console.log([...m.entries()].slice(0, 3));
  }).catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
}
