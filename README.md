# CourtSide Stock Finder

Read-only lookup for retail staff: search any SKU (or scan its barcode) and see which
Loc-2 warehouse bins hold it, how many are **available** per bin, how many are on the
sales floor, and what it rings up at on Shopify POS (with sale price and % off when discounted). No NetSuite login needed. Data refreshes every ~5 minutes.

Live: https://masonbosdorf.github.io/courtside-stock-finder/ — six-digit access code on open.

## How it works

```
cron-job.org (every 5 min) → workflow_dispatch → GitHub Actions "stock-sync"
  └─ node stock-fetch.js  → 2 paginated SuiteQL pulls (TBA / OAuth 1.0a)
  └─ writes stock-seed.json + stock-meta.json (asOf)
  └─ commits + pushes only if the data changed
GitHub Pages serves index.html + the seed. The browser starts fetching the seed the moment the
page opens (before the code is typed), caches it in localStorage so repeat opens are instant, polls
the tiny stock-meta.json every 60s, and re-fetches the seed only when asOf changes.
```

| File | Role |
|---|---|
| `index.html` | the whole app — lock screen, search, camera scanner, bin view |
| `stock-seed.json` / `stock-meta.json` | DATA ONLY, written by the bot; the page caches the seed on-device and only refetches when meta says asOf changed |
| `stock-fetch.js` | NetSuite → seed (bins at loc 2, floor at loc 22) + Shopify POS prices merged per SKU |
| `shopify.js` / `shopify-prices.js` | Shopify Admin API (client credentials, shared with the siblings) and the variant price pull: price = what POS rings up, compareAt > price = on sale. Only ACTIVE products; anything else shows "not on POS". Falls back to the previous seed's prices if Shopify is down |
| `netsuite.js` / `creds.js` | shared with the sibling repos, plus `suiteqlAll()` offset paging |
| `img/<style>.webp` | 192px product thumbnails, one per style-colour, cut from the Assets bank by `tools/build_thumbs.py` (filename = parent with anything outside `[A-Za-z0-9._-]` → `_`). Lazy-loaded per card; a missing file just shows a placeholder |
| `tools/build_thumbs.py` | hero picker + thumbnail cutter (Nike view-code priority PHSLH000 → … , other brands first file / `Hero/` folder). Rerun after new imagery lands: `python3 tools/build_thumbs.py --all` then commit `img/` |
| `vendor/barcode-detector.min.js` + `vendor/zxing_reader.wasm` | BarcodeDetector ponyfill (ZXing C++ → WebAssembly) used for camera scanning everywhere except Android Chrome; iOS Safari has no native barcode API |
| `.github/workflows/sync.yml` | the cloud refresh |

## Access codes

Codes are checked in the browser as SHA-256 hashes in `index.html` (`CODES` array). To add
one: `python3 -c "import hashlib;print(hashlib.sha256(b'123456').hexdigest())"` and append
the hash. To revoke one, delete its hash — devices holding it lock on next load. This is a
loose gate for a public URL, not real security: the seed file itself is fetchable by anyone
with the URL.

## Run the fetch locally

```
node stock-fetch.js            # uses ~/.config/fulfilment-sync/credentials.json
```

## Searching

| Type | Gets |
|---|---|
| `HF2881` / `sabrina 3` / `nike pro short` | style cards, all sizes, bins per size |
| `HF2881-303-10` or a scanned Code 128 / EAN barcode | that style, size row highlighted |
| `A-041` / `A-041-03-011` | bin view — everything in that bin (or all bins under a prefix) |
| `Nike - 7, 8` / `New Era - M` / `mitchell - L` / `Li-Ning - 9` | one flat SKU-ordered list of that brand in ONLY those sizes. The separator is a dash with a space on at least one side, so hyphenated brands and style codes never split; brand matches by prefix; `&`/`and` are interchangeable. |
| `sabrina 3 - 10` | same flat list, but the left side is a normal search instead of a brand |
