// FIRST C&D company-style deck (20x11.25in, Pretendard) from a JSON spec.
// Usage: NODE_PATH=$(npm root -g) node render-pptx.js deck.json out.pptx
// Paths in the spec (logo, chart images) are resolved relative to the spec file.
const fs = require('fs');
const path = require('path');
const pptxgen = require('pptxgenjs');

const [, , inPath, outPath] = process.argv;
const spec = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const base = path.dirname(path.resolve(inPath));
const asset = (p) => path.resolve(base, p);

const F = 'Pretendard';
const LANG = 'ko-KR'; // Korean word-unit line breaking in PowerPoint
const C = {
  ink: '222222', blue: '4081ED', blueBar: '3E7EE7', rule: 'D9DEE6', tint: 'EEF3FC', head: 'DCE6F2',
  bg: 'FAFAFA', muted: '858585', sub: '5F6368', white: 'FFFFFF',
};
const W = 20, H = 11.25, X = 1.0, CW = 18.0;
const CONTENT_TOP = 3.55;
const FOOT_Y = 10.45; // single footnote baseline for every slide
const BOTTOM = (sl) => (sl.footnote || sl.chartNote ? 10.1 : 10.45);
const GAP = 0.3;

const pres = new pptxgen();
pres.defineLayout({ name: 'FIRST', width: W, height: H });
pres.layout = 'FIRST';
pres.author = spec.meta.company;
pres.title = spec.meta.title;

const txt = (s, t, o) => s.addText(t, { fontFace: F, margin: 0, color: C.ink, valign: 'top', lang: LANG, ...o });
const rect = (s, o) => s.addShape(pres.shapes.RECTANGLE, { line: { type: 'none' }, ...o });
const card = (s, x, y, w, h, bar = false) => {
  rect(s, { x, y, w, h, fill: { color: C.white }, line: { color: C.rule, width: 1 } });
  if (bar) rect(s, { x, y, w, h: 0.07, fill: { color: C.blueBar } });
};
const bullets = (items, o = {}) => items.map((it, i) => ({
  text: it,
  options: { bullet: { code: '2022', indent: 22 }, breakLine: i < items.length - 1, paraSpaceAfter: 8, lang: LANG, ...o },
}));
const pngSize = (file) => { const b = fs.readFileSync(file); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };

function frame(s, sl) {
  s.background = { color: C.bg };
  s.addImage({ path: asset(spec.meta.logo), x: 16.35, y: 0.55, w: 2.7, h: 0.42 });
  txt(s, sl.num, { x: X, y: 0.62, w: 5, h: 1.15, fontSize: 66, bold: true, color: C.blue, valign: 'bottom' });
  txt(s, sl.title, { x: X, y: 1.75, w: 17.5, h: 1.35, fontSize: 44, bold: true, valign: 'middle' });
  rect(s, { x: X, y: 3.12, w: CW, h: 0.02, fill: { color: C.rule } });
  rect(s, { x: X, y: 3.09, w: 3.1, h: 0.07, fill: { color: C.blueBar } });
  const note = [sl.chartNote, sl.footnote].filter(Boolean).join('   ');
  if (note) txt(s, note, { x: X, y: FOOT_Y, w: CW, h: 0.4, fontSize: 16, color: C.sub, valign: 'middle' });
}

function calloutH(w, co) {
  const c = typeof co === "string" ? { text: co } : co;
  return (c.title ? 0.42 : 0) + lines(c.text, 20, w - 0.7) * 0.36 + 0.6;
}

function callout(s, x, y, w, h, co) {
  const c = typeof co === 'string' ? { text: co } : co;
  rect(s, { x, y, w, h, fill: { color: C.tint } });
  const runs = [];
  if (c.title) runs.push({ text: c.title, options: { bold: true, color: C.blue, fontSize: 22, breakLine: true, paraSpaceAfter: 4 } });
  runs.push({ text: c.text, options: { color: C.ink, fontSize: 20 } });
  txt(s, runs, { x: x + 0.35, y: y + 0.12, w: w - 0.7, h: h - 0.24, valign: 'middle' });
}

// rough wrapped-line estimate for Korean text (≈1 em per Hangul glyph, 0.55 em for Latin/digits)
function lines(text, fontPt, widthIn) {
  const em = fontPt / 72;
  let width = 0;
  for (const ch of String(text)) width += /[㄰-㆏가-힣]/.test(ch) ? em * 0.9 : em * 0.52;
  return Math.max(1, Math.ceil(width / Math.max(widthIn, 0.5)));
}

function table(s, x, y, w, t) {
  const fs = t.fontSize ?? 19;
  const ratios = t.columns.map((c) => c.w ?? 1);
  const sum = ratios.reduce((a, b) => a + b, 0);
  const colW = ratios.map((r) => (w * r) / sum);
  const align = (i) => t.columns[i].align ?? 'center';
  const cellText = (v) => (typeof v === 'object' && v !== null ? v.text : String(v));
  const head = t.columns.map((c, i) => ({ text: c.header, options: { bold: true, fill: { color: C.head }, align: align(i), fontSize: fs, lang: LANG } }));
  const body = t.rows.map((r) => r.map((v, i) => ({ text: cellText(v), options: { align: align(i), fontSize: fs, color: C.ink, lang: LANG } })));
  const rowH = t.rowH ?? 0.7;
  const heights = [t.columns, ...t.rows].map((r) => Math.max(rowH,
    Math.max(...r.map((v, i) => lines(typeof v === 'string' ? v : cellText(v.header ?? v), fs, colW[i] - 0.25))) * (fs / 72) * 1.22 + 0.16));
  s.addTable([head, ...body], {
    x, y, w, colW, rowH: heights, fontFace: F, color: C.ink, fill: { color: C.white }, valign: 'middle',
    border: { type: 'solid', pt: 1, color: C.rule }, margin: [0.05, 0.15, 0.05, 0.15], autoPage: false,
  });
  return y + heights.reduce((a, b) => a + b, 0);
}

const L = {};

L.title = (s, sl) => {
  s.background = { color: C.bg };
  rect(s, { x: 0, y: 0, w: W, h: 0.28, fill: { color: C.blueBar } });
  s.addImage({ path: asset(spec.meta.logo), x: 1.0, y: 1.15, w: 3.4, h: 0.53 });
  txt(s, sl.kicker, { x: 1.0, y: 3.7, w: 18, h: 0.7, fontSize: 30, bold: true, color: C.sub });
  rect(s, { x: 1.0, y: 4.42, w: 4.2, h: 0.08, fill: { color: C.blueBar } });
  txt(s, [
    { text: sl.title, options: { fontSize: 76, bold: true, color: C.ink, breakLine: true } },
    { text: sl.subtitle, options: { fontSize: 30, color: C.blue, paraSpaceBefore: 14 } },
  ], { x: 1.0, y: 4.6, w: 18, h: 2.9 });
  rect(s, { x: 1.0, y: 9.1, w: 7.4, h: 1.15, fill: { color: C.tint } });
  txt(s, `${spec.meta.company}      |      작성일 ${spec.meta.date}`, { x: 1.35, y: 9.1, w: 7.6, h: 1.15, fontSize: 22, bold: true, valign: 'middle' });
};

L.labelRows = (s, sl) => {
  frame(s, sl);
  const n = sl.rows.length, gap = 0.2;
  const h = Math.min(1.45, (BOTTOM(sl) - CONTENT_TOP - gap * (n - 1)) / n);
  sl.rows.forEach((r, i) => {
    const y = CONTENT_TOP + i * (h + gap);
    card(s, X, y, CW, h);
    rect(s, { x: X, y, w: 3.2, h, fill: { color: C.tint } });
    txt(s, r.label, { x: X, y, w: 3.2, h, fontSize: 26, bold: true, color: C.blue, align: 'center', valign: 'middle' });
    txt(s, r.text, { x: 4.55, y, w: 14.1, h, fontSize: r.fontSize ?? 22, valign: 'middle' });
  });
};

L.stats = (s, sl) => {
  frame(s, sl);
  const k = sl.stats.length, gap = GAP, top = CONTENT_TOP;
  const w = (CW - gap * (k - 1)) / k;
  sl.stats.forEach((st, i) => {
    const x = X + i * (w + gap);
    const sh = sl.callout ? 2.1 : 2.35;
    card(s, x, top, w, sh);
    rect(s, { x, y: top, w, h: 0.1, fill: { color: C.blueBar } });
    txt(s, [
      { text: st.value, options: { fontSize: st.value.length > 8 ? 40 : 50, bold: true, color: C.blue, breakLine: true } },
      { text: st.label, options: { fontSize: 18, color: C.sub } },
    ], { x: x + 0.2, y: top + 0.2, w: w - 0.4, h: (sl.callout ? 2.1 : 2.35) - 0.4, align: 'center', valign: 'middle' });
  });
  let y = top + (sl.callout ? 2.1 : 2.35) + 0.35;
  if (sl.subtitle) { txt(s, sl.subtitle, { x: X, y, w: CW, h: 0.6, fontSize: 24, bold: true }); y += 0.7; }
  if (sl.table) y = table(s, X, y, CW, sl.table) + 0.35;
  if (sl.callout) { const h = calloutH(CW, sl.callout); callout(s, X, Math.min(y, BOTTOM(sl) - h), CW, h, sl.callout); }
};

L.chartSide = (s, sl) => {
  frame(s, sl);
  const top = 3.55, bottom = BOTTOM(sl);
  const file = asset(sl.chart), { w: pw, h: ph } = pngSize(file);
  const cw = 10.6, chH = Math.min(bottom - top, (cw * ph) / pw);
  s.addImage({ path: file, x: X, y: top, w: (chH * pw) / ph, h: chH });
  card(s, 12.2, top, 6.8, chH);
  txt(s, [
    { text: sl.side.heading, options: { fontSize: 24, bold: true, color: C.blue, breakLine: true, paraSpaceAfter: 14 } },
    ...bullets(sl.side.items, { fontSize: sl.side.fontSize ?? 21, color: C.ink, paraSpaceAfter: 12 }),
  ], { x: 12.6, y: top + 0.35, w: 6.0, h: chH - 0.7, valign: 'middle' });
};

L.twoCharts = (s, sl) => {
  frame(s, sl);
  const halves = [[X, 9.7], [10.3, 19.0]];
  const ch = calloutH(CW, sl.callout);
  const maxChartH = BOTTOM(sl) - ch - GAP - 3.95;
  let chartsEnd = 0;
  [sl.left, sl.right].forEach((c, i) => {
    const [x0, x1] = halves[i];
    txt(s, c.heading, { x: x0, y: 3.35, w: x1 - x0, h: 0.55, fontSize: 22, bold: true });
    const file = asset(c.chart), { w: pw, h: ph } = pngSize(file);
    let w = x1 - x0, h = (w * ph) / pw;
    if (h > maxChartH) { h = maxChartH; w = (h * pw) / ph; }
    s.addImage({ path: file, x: x0 + (x1 - x0 - w) / 2, y: 3.95, w, h });
    chartsEnd = Math.max(chartsEnd, 3.95 + h);
  });
  callout(s, X, chartsEnd + GAP, CW, ch, sl.callout);
};

L.table = (s, sl) => {
  frame(s, sl);
  let y = CONTENT_TOP;
  if (sl.subtitle) { txt(s, sl.subtitle, { x: X, y, w: CW, h: 0.6, fontSize: 24, bold: true }); y += 0.7; }
  const end = table(s, X, y, CW, sl.table);
  if (sl.callout) {
    const h = sl.calloutH ?? Math.max(1.2, calloutH(CW, sl.callout));
    const cy = Math.min(end + 0.4, BOTTOM(sl) - h);
    callout(s, X, cy, CW, h, sl.callout);
  }
};

L.bulletsCallout = (s, sl) => {
  frame(s, sl);
  txt(s, sl.heading, { x: X, y: 3.5, w: CW, h: 0.6, fontSize: 24, bold: true });
  const h = sl.cardH ?? 3.55;
  card(s, X, 4.15, CW, h);
  txt(s, bullets(sl.items, { fontSize: 21, color: C.ink }), { x: 1.45, y: 4.45, w: 17.1, h: h - 0.55 });
  if (sl.callout) callout(s, X, 4.15 + h + GAP, CW, Math.min(1.8, BOTTOM(sl) - (4.15 + h + GAP)), sl.callout);
};

function cardBody(c, size, space = 8) {
  return [
    ...(c.tag ? [{ text: c.tag, options: { fontSize: 16, bold: true, color: C.sub, breakLine: true, paraSpaceAfter: 2 } }] : []),
    { text: c.title, options: { fontSize: 23, bold: true, color: C.blue, breakLine: true, paraSpaceAfter: 10 } },
    ...(Array.isArray(c.body) ? bullets(c.body, { fontSize: size, paraSpaceAfter: space }) : [{ text: c.body, options: { fontSize: size } }]),
  ];
}

L.conclusion = (s, sl) => {
  frame(s, sl);
  const topH = Math.max(1.3, calloutH(CW, sl.top));
  callout(s, X, CONTENT_TOP, CW, topH, sl.top);
  const k = sl.cards.length, top = CONTENT_TOP + topH + GAP;
  const w = (CW - GAP * (k - 1)) / k;
  const ch = Math.min(sl.cardH ?? 4.0, BOTTOM(sl) - top);
  sl.cards.forEach((c, i) => {
    const x = X + i * (w + GAP);
    card(s, x, top, w, ch, true);
    txt(s, cardBody(c, sl.bodySize ?? 17, 14), { x: x + 0.35, y: top + 0.35, w: w - 0.7, h: ch - 0.6 });
  });
};

L.cards = (s, sl) => {
  frame(s, sl);
  let top = CONTENT_TOP;
  if (sl.lead) { txt(s, sl.lead, { x: X, y: top, w: CW, h: 0.7, fontSize: 21 }); top += 0.85; }
  const k = sl.cards.length, cols = sl.cols ?? Math.min(k, 4), rows = Math.ceil(k / cols);
  const w = (CW - GAP * (cols - 1)) / cols;
  const cH = sl.callout ? calloutH(CW, sl.callout) : 0;
  const bottom = BOTTOM(sl) - (sl.callout ? cH + GAP : 0);
  const h = (bottom - top - GAP * (rows - 1)) / rows;
  sl.cards.forEach((c, i) => {
    const x = X + (i % cols) * (w + GAP), y = top + Math.floor(i / cols) * (h + GAP);
    card(s, x, y, w, h, true);
    txt(s, cardBody(c, sl.bodySize ?? 18), { x: x + 0.3, y: y + 0.3, w: w - 0.6, h: h - 0.45 });
  });
  if (sl.callout) callout(s, X, bottom + GAP, CW, cH, sl.callout);
};

L.flow = (s, sl) => {
  frame(s, sl);
  let top = CONTENT_TOP;
  if (sl.lead) { txt(s, sl.lead, { x: X, y: top, w: CW, h: 0.75, fontSize: 21 }); top += 0.9; }
  const k = sl.steps.length, arrow = 0.5;
  const w = (CW - arrow * (k - 1)) / k, stepH = sl.stepH ?? 1.7;
  if (sl.groups) {
    for (const g of sl.groups) {
      const x0 = X + g.from * (w + arrow), x1 = X + g.to * (w + arrow) + w;
      txt(s, g.label, { x: x0, y: top, w: x1 - x0, h: 0.4, fontSize: 18, bold: true, color: g.strong ? C.blue : C.sub, align: 'center' });
      rect(s, { x: x0, y: top + 0.42, w: x1 - x0, h: 0.03, fill: { color: g.strong ? C.blueBar : C.rule } });
    }
    top += 0.6;
  }
  sl.steps.forEach((st, i) => {
    const x = X + i * (w + arrow);
    rect(s, { x, y: top, w, h: stepH, fill: { color: st.strong ? C.tint : C.white }, line: st.strong ? { type: 'none' } : { color: C.rule, width: 1 } });
    txt(s, [
      { text: st.label, options: { fontSize: 23, bold: true, color: st.strong ? C.blue : C.ink, breakLine: true, paraSpaceAfter: 4 } },
      { text: st.detail, options: { fontSize: 17, color: C.sub } },
    ], { x: x + 0.15, y: top, w: w - 0.3, h: stepH, align: 'center', valign: 'middle' });
    if (i < k - 1) txt(s, '→', { x: x + w, y: top, w: arrow, h: stepH, fontSize: 26, color: C.muted, align: 'center', valign: 'middle' });
  });
  if (sl.cards) {
    const y2 = top + stepH + 0.45;
    const n = sl.cards.length, cw = (CW - GAP * (n - 1)) / n;
    const ch = BOTTOM(sl) - y2;
    sl.cards.forEach((c, i) => {
      const x = X + i * (cw + GAP);
      card(s, x, y2, cw, ch, true);
      txt(s, cardBody(c, sl.bodySize ?? 18), { x: x + 0.3, y: y2 + 0.3, w: cw - 0.6, h: ch - 0.45 });
    });
  }
};

(async () => {
  spec.slides.forEach((sl, i) => {
    const s = pres.addSlide();
    const fn = L[sl.t];
    if (!fn) throw new Error(`unknown slide type ${sl.t} (#${i + 1})`);
    fn(s, sl);
    if (sl.notes) s.addNotes(sl.notes);
  });
  await pres.writeFile({ fileName: outPath });
  console.log(`wrote ${outPath} (${spec.slides.length} slides)`);
})().catch((e) => { console.error(e); process.exit(1); });
