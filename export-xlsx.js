/* export-xlsx.js — the Export button's engine.

   Exports EVERY result of the current search (not just the rendered page) as a two-sheet workbook:
     "Variants" — one row per SKU size
     "Parents"  — one row per style, quantities and bins rolled up
   Both sheets:  IMAGE · SKU · NAME · QTY · BIN · Online Store

   - QTY  = units available in warehouse bins (held/committed units are already excluded upstream).
   - BIN  = the bin; where stock sits in several, each bin carries its own quantity.
   - Online Store = Y on green / N on red. On Parents, Y if any size of the style is online.

   No dependencies. An .xlsx is a zip, so it is built here with CompressionStream (STORE fallback),
   and the pictures are Excel "Place in Cell" rich values — the same OOXML shape as
   ~/Cowork/Courtside/Projects/Assortment File Image Embedding/incell.py, which Excel accepts — so a
   picture sorts, filters and resizes with its row instead of floating over it. One rich value per
   style, shared by both sheets.
   ⚠ Rich-value images need Microsoft 365 Excel. Older Excel, Google Sheets and LibreOffice show the
   #VALUE! fallback in the IMAGE column; every other column still reads normally.

   window.SFExport = { rowsFor, parentRows, buildBlob, run, filename, MAX_IMAGES }
*/
(function (root) {
  'use strict';

  const MAX_IMAGES = 500;     // beyond this the rows still export, the pictures are dropped
  const THUMB = 96;           // px square written into the workbook
  const ROW_PT = 74;          // row height in points (96px ≈ 72pt) so the picture has room
  const te = new TextEncoder();
  const X = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const thumbFile = parent => String(parent).replace(/[^A-Za-z0-9._-]/g, '_') + '.webp';
  const bySku = (a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);

  // ---------------------------------------------------------------- rows

  /* Flatten whatever search() returned into variant rows. Every mode ends up in the same shape, so
     the file looks the same whether the query was a style, a brand+size, a bin or a scan.
     helpers: { nice, BY_SKU } from the app (passed in, so this file has no hidden globals). */
  function rowsFor(result, helpers) {
    const h = helpers || {};
    const nice = h.nice || (s => s);
    const index = h.BY_SKU || new Map();
    const out = new Map();                       // sku -> row (a SKU can arrive via several bins)

    const add = (it, onlyBins) => {
      if (!it) return;
      const [sku, name, , , parent, , bins] = it;
      let list = (bins || []).filter(b => b[1] > 0);
      if (onlyBins) list = list.filter(b => onlyBins.has(b[0]));
      const row = out.get(sku) || { sku, parent, name: nice(name) || parent, qty: 0, bins: [], online: !!it[11] };
      for (const b of list) {
        if (row.bins.some(x => x.bin === b[0])) continue;
        row.bins.push({ bin: b[0], qty: b[1] });
        row.qty += b[1];
      }
      out.set(sku, row);
    };

    if (result && result.mode === 'flat') {
      (result.rows || []).forEach(it => add(it));
    } else if (result && result.mode === 'bin') {
      for (const b of result.bins || []) {
        const only = new Set([b.bin]);
        for (const r of b.rows || []) add(index.get(String(r.s.sku).toUpperCase()), only);
      }
    } else if (result && result.mode === 'search') {
      for (const p of result.styles || []) for (const s of p.sizes || []) add(index.get(String(s.sku).toUpperCase()));
    }

    const rows = [...out.values()];
    for (const r of rows) r.bins.sort((a, b) => (a.bin < b.bin ? -1 : 1));
    rows.sort(bySku);                            // SKU order, as the seed is built
    return rows;
  }

  /* Variant rows → one row per style: quantities summed, bins merged, online if any size is. */
  function parentRows(rows) {
    const by = new Map();
    for (const r of rows) {
      const p = by.get(r.parent) || { sku: r.parent, parent: r.parent, name: r.name, qty: 0, bins: [], online: false };
      p.qty += r.qty;
      p.online = p.online || r.online;
      for (const b of r.bins) {
        const ex = p.bins.find(x => x.bin === b.bin);
        if (ex) ex.qty += b.qty; else p.bins.push({ bin: b.bin, qty: b.qty });
      }
      by.set(r.parent, p);
    }
    const out = [...by.values()];
    for (const p of out) p.bins.sort((a, b) => (a.bin < b.bin ? -1 : 1));
    out.sort(bySku);
    return out;
  }

  const binText = r => r.bins.length === 0 ? '—'
    : r.bins.length === 1 ? r.bins[0].bin
    : r.bins.map(b => `${b.bin} (${b.qty})`).join(', ');

  // ---------------------------------------------------------------- images

  function canvasPNG(bmp) {
    const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(THUMB, THUMB)
      : Object.assign(document.createElement('canvas'), { width: THUMB, height: THUMB });
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, THUMB, THUMB);
    const k = Math.min(THUMB / bmp.width, THUMB / bmp.height);
    const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
    g.drawImage(bmp, Math.round((THUMB - w) / 2), Math.round((THUMB - h) / 2), w, h);
    return c.convertToBlob ? c.convertToBlob({ type: 'image/png' }) : new Promise(res => c.toBlob(res, 'image/png'));
  }

  /* Excel will not embed WebP, so every thumbnail is decoded and re-encoded as PNG here. One fetch
     per style (a size run shares one picture), so a 200-row export is usually ~60 images. */
  async function loadImages(parents, onProgress) {
    const out = new Map();
    const list = [...parents];
    let done = 0;
    const worker = async () => {
      for (;;) {
        const parent = list.shift();
        if (parent === undefined) return;
        try {
          const r = await fetch('img/' + thumbFile(parent), { cache: 'force-cache' });
          if (r.ok) {
            const bmp = await createImageBitmap(await r.blob());
            const png = await canvasPNG(bmp);
            if (bmp.close) bmp.close();
            out.set(parent, new Uint8Array(await png.arrayBuffer()));
          }
        } catch (e) { /* missing or undecodable — that row just has no picture */ }
        if (onProgress) onProgress(++done, parents.size);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, list.length) }, worker));
    return out;
  }

  // ---------------------------------------------------------------- zip

  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
    return t;
  })();
  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  async function deflateRaw(u8) {
    if (typeof CompressionStream !== 'function') return null;
    try {
      const cs = new CompressionStream('deflate-raw');
      return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(cs)).arrayBuffer());
    } catch (e) { return null; }   // Safari < 17 has CompressionStream without deflate-raw
  }

  async function zip(files) {
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = te.encode(f.name);
      const raw = f.data;
      const crc = crc32(raw);
      let data = await deflateRaw(raw), method = 8;
      if (!data || data.length >= raw.length) { data = raw; method = 0; }

      const lfh = new DataView(new ArrayBuffer(30));
      lfh.setUint32(0, 0x04034b50, true); lfh.setUint16(4, 20, true); lfh.setUint16(6, 0, true);
      lfh.setUint16(8, method, true); lfh.setUint16(10, 0, true); lfh.setUint16(12, 0, true);
      lfh.setUint32(14, crc, true); lfh.setUint32(18, data.length, true); lfh.setUint32(22, raw.length, true);
      lfh.setUint16(26, name.length, true); lfh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lfh.buffer), name, data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
      cd.setUint16(8, 0, true); cd.setUint16(10, method, true); cd.setUint16(12, 0, true); cd.setUint16(14, 0, true);
      cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, raw.length, true);
      cd.setUint16(28, name.length, true); cd.setUint16(30, 0, true); cd.setUint16(32, 0, true);
      cd.setUint16(34, 0, true); cd.setUint16(36, 0, true); cd.setUint32(38, 0, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), name);

      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((a, b) => a + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(4, 0, true); end.setUint16(6, 0, true);
    end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true); end.setUint16(20, 0, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)],
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // ---------------------------------------------------------------- workbook parts

  const NS_RD = 'http://schemas.microsoft.com/office/spreadsheetml/2017/richdata';
  const IMG_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
  const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

  const STYLES = HEAD +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="4">' +
      '<font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
      '<font><sz val="11"/><color rgb="FF006100"/><name val="Calibri"/></font>' +
      '<font><sz val="11"/><color rgb="FF9C0006"/><name val="Calibri"/></font></fonts>' +
    '<fills count="5">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFEFEFEF"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border><left/><right/><top/><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="7">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="3" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  const RV_STRUCTURE = HEAD + '<rvStructures xmlns="' + NS_RD + '" count="1"><s t="_localImage">' +
    '<k n="_rvRel:LocalImageIdentifier" t="i"/><k n="CalcOrigin" t="i"/><k n="Text" t="s"/></s></rvStructures>';

  const RV_TYPES = HEAD +
    '<rvTypesInfo xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata2"' +
    ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x"' +
    ' xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><global><keyFlags>' +
    '<key name="_Self"><flag name="ExcludeFromFile" value="1"/><flag name="ExcludeFromCalcComparison" value="1"/></key>' +
    ['_DisplayString', '_Flags', '_Format', '_SubLabel', '_Attribution', '_Icon', '_Display', '_CanonicalPropertyNames', '_ClassificationId']
      .map(k => '<key name="' + k + '"><flag name="ExcludeFromCalcComparison" value="1"/></key>').join('') +
    '</keyFlags></global></rvTypesInfo>';

  const COLS = [
    { w: 14, head: 'IMAGE' }, { w: 24, head: 'SKU' }, { w: 48, head: 'NAME' },
    { w: 9, head: 'QTY' }, { w: 38, head: 'BIN' }, { w: 16, head: 'Online Store' },
  ];

  function sheetXML(rows, vmByParent, withImages) {
    const last = rows.length + 1;
    const cols = COLS.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.w}" customWidth="1"/>`).join('');
    const head = '<row r="1" ht="22" customHeight="1">' +
      COLS.map((c, i) => `<c r="${String.fromCharCode(65 + i)}1" t="inlineStr" s="1"><is><t>${X(c.head)}</t></is></c>`).join('') + '</row>';
    const body = rows.map((r, i) => {
      const n = i + 2;
      const vm = vmByParent.get(r.parent);
      const img = vm ? `<c r="A${n}" s="6" t="e" vm="${vm}"><v>#VALUE!</v></c>` : `<c r="A${n}" s="6"/>`;
      const str = (col, v) => `<c r="${col}${n}" t="inlineStr" s="2"><is><t xml:space="preserve">${X(v)}</t></is></c>`;
      return `<row r="${n}"${withImages ? ` ht="${ROW_PT}" customHeight="1"` : ''}>` +
        img + str('B', r.sku) + str('C', r.name) +
        `<c r="D${n}" s="3"><v>${r.qty}</v></c>` +
        str('E', binText(r)) +
        `<c r="F${n}" t="inlineStr" s="${r.online ? 4 : 5}"><is><t>${r.online ? 'Y' : 'N'}</t></is></c>` +
        '</row>';
    }).join('');
    return HEAD +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<dimension ref="A1:F${last}"/>` +
      '<sheetViews><sheetView showGridLines="0" workbookViewId="0">' +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      `<cols>${cols}</cols><sheetData>${head}${body}</sheetData>` +
      `<autoFilter ref="A1:F${last}"/>` +
      '<pageMargins left="0.5" right="0.5" top="0.5" bottom="0.5" header="0.3" footer="0.3"/></worksheet>';
  }

  function richParts(media) {
    const rels = media.map((m, i) => `<Relationship Id="rId${i + 1}" Type="${IMG_REL}" Target="../media/${m.file}"/>`).join('');
    return {
      'xl/richData/rdrichvaluestructure.xml': RV_STRUCTURE,
      'xl/richData/rdRichValueTypes.xml': RV_TYPES,
      'xl/richData/rdrichvalue.xml': HEAD + `<rvData xmlns="${NS_RD}" count="${media.length}">` +
        media.map((m, i) => `<rv s="0"><v>${i}</v><v>5</v><v>${X(m.alt)}</v></rv>`).join('') + '</rvData>',
      'xl/richData/richValueRel.xml': HEAD +
        '<richValueRels xmlns="http://schemas.microsoft.com/office/spreadsheetml/2022/richvaluerel"' +
        ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        media.map((m, i) => `<rel r:id="rId${i + 1}"/>`).join('') + '</richValueRels>',
      'xl/richData/_rels/richValueRel.xml.rels': HEAD +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels + '</Relationships>',
      'xl/metadata.xml': HEAD +
        '<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:xlrd="' + NS_RD + '">' +
        '<metadataTypes count="1"><metadataType name="XLRICHVALUE" minSupportedVersion="120000" copy="1" pasteAll="1"' +
        ' pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1"/></metadataTypes>' +
        `<futureMetadata name="XLRICHVALUE" count="${media.length}">` +
        media.map((m, i) => '<bk><extLst><ext uri="{3e2802c4-a4d2-4d8b-9148-e3be6c30e623}">' +
          `<xlrd:rvb i="${i}"/></ext></extLst></bk>`).join('') + '</futureMetadata>' +
        `<valueMetadata count="${media.length}">` +
        media.map((m, i) => `<bk><rc t="1" v="${i}"/></bk>`).join('') + '</valueMetadata></metadata>',
    };
  }

  function contentTypes(sheetCount, withImages) {
    const sheets = Array.from({ length: sheetCount }, (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
    return HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      (withImages ? '<Default Extension="png" ContentType="image/png"/>' : '') +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      (withImages ?
        '<Override PartName="/xl/metadata.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml"/>' +
        '<Override PartName="/xl/richData/richValueRel.xml" ContentType="application/vnd.ms-excel.richvaluerel+xml"/>' +
        '<Override PartName="/xl/richData/rdrichvalue.xml" ContentType="application/vnd.ms-excel.rdrichvalue+xml"/>' +
        '<Override PartName="/xl/richData/rdrichvaluestructure.xml" ContentType="application/vnd.ms-excel.rdrichvaluestructure+xml"/>' +
        '<Override PartName="/xl/richData/rdRichValueTypes.xml" ContentType="application/vnd.ms-excel.rdrichvaluetypes+xml"/>' : '') +
      '</Types>';
  }

  function workbookRels(sheetCount, withImages) {
    let id = 0;
    const rel = (type, target) => `<Relationship Id="rId${++id}" Type="${type}" Target="${target}"/>`;
    let out = '';
    for (let i = 0; i < sheetCount; i++) out += rel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet', `worksheets/sheet${i + 1}.xml`);
    out += rel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles', 'styles.xml');
    if (withImages) {
      out += rel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata', 'metadata.xml');
      out += rel('http://schemas.microsoft.com/office/2017/06/relationships/rdRichValue', 'richData/rdrichvalue.xml');
      out += rel('http://schemas.microsoft.com/office/2017/06/relationships/rdRichValueStructure', 'richData/rdrichvaluestructure.xml');
      out += rel('http://schemas.microsoft.com/office/2017/06/relationships/rdRichValueTypes', 'richData/rdRichValueTypes.xml');
      out += rel('http://schemas.microsoft.com/office/2022/10/relationships/richValueRel', 'richData/richValueRel.xml');
    }
    return HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + out + '</Relationships>';
  }

  // ---------------------------------------------------------------- build

  /* sheets: [{ name, rows }] → Blob. opts: { images: true, onProgress(phase, done, total) } */
  async function buildBlob(sheets, opts) {
    opts = opts || {};
    const onProgress = opts.onProgress || (() => {});
    const total = sheets.reduce((n, s) => n + s.rows.length, 0);
    const wantImages = opts.images !== false && total <= MAX_IMAGES * sheets.length;

    let pngByParent = new Map();
    if (wantImages) {
      const parents = new Set(sheets.flatMap(s => s.rows.map(r => r.parent)).filter(Boolean));
      onProgress('images', 0, parents.size);
      pngByParent = await loadImages(parents, (d, t) => onProgress('images', d, t));
    }

    // one media file and one rich value per style; both sheets point at the same value
    const media = [], vmByParent = new Map();
    for (const s of sheets) for (const r of s.rows) {
      if (vmByParent.has(r.parent)) continue;
      const png = pngByParent.get(r.parent);
      if (!png) continue;
      media.push({ file: `image${String(media.length + 1).padStart(4, '0')}.png`, alt: r.parent, parent: r.parent });
      vmByParent.set(r.parent, media.length);     // vm is 1-based into valueMetadata
    }
    const withImages = media.length > 0;
    onProgress('building', 0, 1);

    const files = [
      { name: '[Content_Types].xml', data: te.encode(contentTypes(sheets.length, withImages)) },
      { name: '_rels/.rels', data: te.encode(HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
      { name: 'xl/workbook.xml', data: te.encode(HEAD +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
          ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
          sheets.map((s, i) => `<sheet name="${X(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
          '</sheets></workbook>') },
      { name: 'xl/_rels/workbook.xml.rels', data: te.encode(workbookRels(sheets.length, withImages)) },
      { name: 'xl/styles.xml', data: te.encode(STYLES) },
    ];
    sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: te.encode(sheetXML(s.rows, vmByParent, withImages)) }));
    if (withImages) {
      for (const m of media) files.push({ name: 'xl/media/' + m.file, data: pngByParent.get(m.parent) });
      const parts = richParts(media);
      for (const name of Object.keys(parts)) files.push({ name, data: te.encode(parts[name]) });
    }

    const blob = await zip(files);
    onProgress('done', 1, 1);
    return { blob, sheets: sheets.map(s => ({ name: s.name, rows: s.rows.length })), images: media.length, imagesSkipped: !wantImages };
  }

  function filename(query, asOf) {
    const q = String(query || 'all').trim().replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').slice(0, 40);
    const d = asOf ? new Date(asOf) : new Date();
    const stamp = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', day: '2-digit', month: 'short' }).format(d);
    return `Stock Finder - ${q} - ${stamp}.xlsx`;
  }

  /* The button's entry point. opts: { result, query, asOf, nice, BY_SKU, onProgress } */
  async function run(opts) {
    const variants = rowsFor(opts.result, opts);
    if (!variants.length) return { rows: 0 };
    const built = await buildBlob([
      { name: 'Variants', rows: variants },
      { name: 'Parents', rows: parentRows(variants) },
    ], { onProgress: opts.onProgress });
    const name = filename(opts.query, opts.asOf);
    const url = URL.createObjectURL(built.blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return Object.assign(built, { name, rows: variants.length });
  }

  root.SFExport = { rowsFor, parentRows, buildBlob, run, filename, binText, MAX_IMAGES };
})(typeof self !== 'undefined' ? self : this);
