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
GitHub Pages serves index.html + the seed. The page checks its own ETag every 10 min (and on
returning to the foreground) and reloads at an idle moment when a new version is published.
The browser starts fetching the seed the moment the page opens (before the code is typed), caches it in localStorage so repeat opens are instant, polls
the tiny stock-meta.json every 60s, and re-fetches the seed only when asOf changes.
```

| File | Role |
|---|---|
| `index.html` | the whole app — lock screen, search, camera scanner, bin view |
| `stock-seed.json` / `stock-meta.json` | DATA ONLY, written by the bot; the page caches the seed on-device and only refetches when meta says asOf changed |
| `stock-fetch.js` | NetSuite → seed (bins at loc 2, floor at loc 22) + Shopify POS prices merged per SKU |
| `shopify.js` / `shopify-prices.js` | Shopify Admin API (client credentials, shared with the siblings) and the variant pull — price, plus productType and audience/category tags for the kind filters: price = what POS rings up, compareAt > price = on sale. Only ACTIVE products; anything else shows "not on POS". Falls back to the previous seed's prices if Shopify is down |
| `netsuite.js` / `creds.js` | shared with the sibling repos, plus `suiteqlAll()` offset paging |
| `img/<style>.webp` | 192px product thumbnails, one per style-colour, cut from the Assets bank by `tools/build_thumbs.py` (filename = parent with anything outside `[A-Za-z0-9._-]` → `_`). Lazy-loaded per card; a missing file just shows a placeholder |
| `tools/build_thumbs.py` | hero picker + thumbnail cutter (Nike view-code priority PHSLH000 → … , other brands first file / `Hero/` folder). Rerun after new imagery lands: `python3 tools/build_thumbs.py --all` then commit `img/` |
| `vendor/barcode-detector.min.js` + `vendor/zxing_reader.wasm` | BarcodeDetector ponyfill (ZXing C++ → WebAssembly) used for camera scanning everywhere except Android Chrome; iOS Safari has no native barcode API |
| `.github/workflows/sync.yml` | the cloud refresh |

## Pick

Tap a bin chip (or a row in bin view) to add that SKU-from-that-bin to the pick; tap again for
another, capped at what's in the bin. A gold pill at the bottom opens the pick in bin walk
order (aisle → bay → shelf → slot): tick lines off while walking, − / + / × per line, Remove
ticked, Clear all. Stored per device in `localStorage` (`sf_pick`); nothing is written to
NetSuite. Typing a bin code still opens that bin's contents.

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
| `Nike - socks` / `Jordan - hat or cap` / `Adidas - backpack` | style cards of that brand filtered to a KIND of item. Kinds map plain words to Shopify product types (hat → Cap, Bucket Hat, Beanie; socks → all sock types; bag → all bag types; shoes → Low/Mid/High Cut …) and audience tags (mens, womens, kids). Words with no synonym prefix-match the product type, then the name. `,` or `or` = either; several words = all of them |
| `Adidas - womens shorts M` | kinds and sizes together: flat list of that brand's womens shorts in M |
| `Kobe 8 - 44` / `Sabrina 4 - 46` / `Jordan - eu44` | EU sizes (35–53) are converted **per style** to the US size the SKU carries: Womens-tagged styles use womens US (Sabrina 4 EU 46 → 13.5), Youth/Kids use Y sizes, everything else mens; brand charts for Nike/Jordan/Li-Ning/WoW, Adidas/Reebok, New Balance, Puma, Converse. The EU shows in gold under the size and the conversion used shows in the result line. Roman numerals in names count as digits (KOBE VIII = Kobe 8) |
| `Sabrina 4 - m10` / `Kobe 8 - w11.5` / `Nike - mens 10` | a US size on a stated scale, converted to each shoe's own scale using the brand's mens↔womens offset (Nike 1.5, Adidas 1, NB/Puma 1.5, Converse 2): Sabrina is womens so m10 → 11.5; Kobe is mens so w11.5 → 10. Shown as "= M 10" under the size |
