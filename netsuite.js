/* netsuite.js — direct SuiteQL over NetSuite REST using Token-Based Auth (OAuth 1.0a,
   HMAC-SHA256). Works headless/cron — no claude.ai connector, no interactive auth.
   Same module as courtside-fulfilment / courtside-sales-tracker, plus offset pagination:
     suiteql(q)          → first page of rows (≤1000)            [compat with the siblings]
     suiteqlPage(q, o)   → { items, hasMore, totalResults } for one page
     suiteqlAll(q)       → EVERY row, paging 1000 at a time     [use this for big pulls]
   Reads creds from ~/.config/fulfilment-sync/credentials.json (chmod 600) or FS_* env vars.
   CLI:  node netsuite.js "SELECT COUNT(*) AS n FROM itembinquantity" */
const crypto = require('crypto');
const https  = require('https');

const c = require('./creds');                 // local file OR FS_* env vars (cloud)

// RFC-3986 percent-encoding
const pe = s => encodeURIComponent(String(s))
  .replace(/[!*'()]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());

// OAuth 1.0a: query-string params MUST be part of the signature base string, so `query`
// (e.g. {limit, offset}) is merged into the sorted parameter list before signing.
function authHeader(method, url, query) {
  const oauth = {
    oauth_consumer_key:     c.consumerKey,
    oauth_token:            c.tokenId,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_nonce:            crypto.randomBytes(16).toString('hex'),
    oauth_version:          '1.0',
  };
  const all = Object.assign({}, query || {}, oauth);
  const paramStr = Object.keys(all).sort()
    .map(k => pe(k) + '=' + pe(all[k])).join('&');
  const base = method.toUpperCase() + '&' + pe(url) + '&' + pe(paramStr);
  const signingKey = pe(c.consumerSecret) + '&' + pe(c.tokenSecret);
  const signature = crypto.createHmac('sha256', signingKey).update(base).digest('base64');
  return 'OAuth realm="' + c.account + '", ' +
    Object.keys(oauth).map(k => pe(k) + '="' + pe(oauth[k]) + '"').join(', ') +
    ', oauth_signature="' + pe(signature) + '"';
}

function suiteqlPage(q, { limit = 1000, offset = 0 } = {}) {
  const host = c.account.toLowerCase().replace(/_/g, '-') + '.suitetalk.api.netsuite.com';
  const reqPath = '/services/rest/query/v1/suiteql';
  const url = 'https://' + host + reqPath;
  const query = { limit: String(limit), offset: String(offset) };
  const qs = '?limit=' + query.limit + '&offset=' + query.offset;
  const body = JSON.stringify({ q });
  return new Promise((resolve, reject) => {
    const req = https.request({
      host, path: reqPath + qs, method: 'POST',
      headers: {
        'Authorization':  authHeader('POST', url, query),
        'Content-Type':   'application/json',
        'Prefer':         'transient',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', d => (data += d));
      res.on('end', () => {
        let j; try { j = JSON.parse(data); } catch (e) { return reject(new Error('NS parse error: ' + data.slice(0, 300))); }
        if (res.statusCode >= 400) return reject(new Error('NS HTTP ' + res.statusCode + ': ' + data.slice(0, 400)));
        resolve({ items: Array.isArray(j.items) ? j.items : [], hasMore: !!j.hasMore, totalResults: j.totalResults });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const suiteql = q => suiteqlPage(q).then(p => p.items);

// Pull every row. The query MUST have an ORDER BY on a unique key, or NetSuite's paging
// silently duplicates and drops rows between pages.
async function suiteqlAll(q, pageSize = 1000) {
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const p = await suiteqlPage(q, { limit: pageSize, offset });
    out.push(...p.items);
    if (!p.hasMore || p.items.length === 0) break;
  }
  return out;
}

module.exports = { suiteql, suiteqlPage, suiteqlAll };

if (require.main === module) {
  const q = process.argv[2] || "SELECT COUNT(*) AS n FROM itembinquantity";
  suiteql(q).then(r => console.log(JSON.stringify(r, null, 2)))
            .catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
}
