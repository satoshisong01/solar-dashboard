// FIRST C&D company-style report (Letter, Pretendard) from a JSON spec.
// Usage: NODE_PATH=$(npm root -g) node render-docx.js report.json out.docx
// Blocks: h2 | p | note | bold | bullets | numbers | table | image | callout | pagebreak | sources
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, Footer, AlignmentType, LevelFormat,
  ExternalHyperlink, HeadingLevel, SectionType, BorderStyle, WidthType, ShadingType, VerticalAlign, PageNumber, PageBreak, ImageRun,
} = require('docx');

const [, , inPath, outPath] = process.argv;
const spec = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const base = path.dirname(path.resolve(inPath));

const FONT = 'Pretendard';
const fontSet = { ascii: FONT, eastAsia: FONT, hAnsi: FONT, cs: FONT };
const C = { ink: '222222', blue: '4081ED', muted: '858585', head: 'DCE6F2', rule: 'C9D0DA', tint: 'EEF3FC' };
const PAGE = { w: 12240, h: 15840, mx: 1584, my: 1440 };
const CW = PAGE.w - PAGE.mx * 2;
const pt = (n) => Math.round(n * 2); // half-points
const sp = (n) => Math.round(n * 20); // twips

const tr = (o) => new TextRun({ font: fontSet, ...(typeof o === 'string' ? { text: o } : o) });

// **bold** inline markup
function runs(text, base = {}) {
  const out = [];
  let last = 0;
  const s = String(text ?? '');
  for (const m of s.matchAll(/\*\*([^*]+)\*\*/g)) {
    if (m.index > last) out.push(tr({ text: s.slice(last, m.index), ...base }));
    out.push(tr({ text: m[1], ...base, bold: true }));
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(tr({ text: s.slice(last), ...base }));
  return out.length ? out : [tr({ text: '', ...base })];
}

const P = (text, { size = 10.5, color = C.ink, bold = false, align, before = 2, after = 4, line = 1.22, ...rest } = {}) =>
  new Paragraph({
    alignment: align, spacing: { before: sp(before), after: sp(after), line: Math.round(240 * line) }, ...rest,
    children: runs(text, { size: pt(size), color, bold }),
  });

let figNo = 0, tblNo = 0;
const border = (color = C.rule) => ({ style: BorderStyle.SINGLE, size: 4, color });
const borders = { top: border(), bottom: border(), left: border(), right: border() };

function table(b) {
  tblNo += 1;
  const ratios = b.columns.map((c) => c.w ?? 1);
  const total = ratios.reduce((a, x) => a + x, 0);
  const widths = ratios.map((r) => Math.floor((CW * r) / total));
  widths[widths.length - 1] += CW - widths.reduce((a, x) => a + x, 0);
  const size = pt(b.size ?? 9);
  const align = (i) => (b.columns[i].align === 'left' ? AlignmentType.LEFT : AlignmentType.CENTER);
  const cell = (content, i, header) => new TableCell({
    borders, width: { size: widths[i], type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER,
    shading: header ? { fill: C.head, type: ShadingType.CLEAR, color: 'auto' } : undefined,
    margins: { top: 18, bottom: 18, left: 80, right: 80 },
    children: String(content ?? '').split('\n').map((line) => new Paragraph({
      alignment: align(i), spacing: { before: 0, after: 0, line: 246 },
      children: runs(line, { size, bold: header, color: C.ink }),
    })),
  });
  const out = [];
  if (b.title) out.push(P(`[표 ${tblNo}] ${b.title}`, { size: 10, bold: true, color: C.blue, before: 5, after: 3, keepNext: true }));
  out.push(new Table({
    width: { size: CW, type: WidthType.DXA }, columnWidths: widths,
    rows: [
      new TableRow({ tableHeader: true, children: b.columns.map((c, i) => cell(c.header, i, true)) }),
      ...b.rows.map((r) => new TableRow({ children: r.map((v, i) => cell(v, i, false)) })),
    ],
  }));
  out.push(b.note ? P(b.note, { size: 9, color: C.muted, before: 3, after: 6 }) : P('', { after: 3 }));
  return out;
}

function image(b) {
  figNo += 1;
  const file = path.resolve(base, b.path);
  const buf = fs.readFileSync(file);
  const wpx = buf.readUInt32BE(16), hpx = buf.readUInt32BE(20); // PNG IHDR
  const widthPx = Math.round(Math.min(b.widthIn ?? 4.8, 4.8) * 96);
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { before: sp(4), after: 0 }, keepNext: true,
      children: [new ImageRun({ type: 'png', data: buf, transformation: { width: widthPx, height: Math.round((widthPx * hpx) / wpx) },
        altText: { title: b.caption, description: b.caption, name: path.basename(file) } })],
    }),
    P(`[그림 ${figNo}] ${b.caption}`, { size: 9.5, color: C.muted, align: AlignmentType.CENTER, before: 2, after: 6 }),
  ];
}

function callout(b) {
  const children = [];
  if (b.title) children.push(P(b.title, { size: 11, bold: true, color: C.blue, before: 0, after: 3 }));
  for (const t of [].concat(b.text)) children.push(P(t, { size: 10.5, before: 0, after: 2 }));
  return [
    new Table({
      width: { size: CW, type: WidthType.DXA }, columnWidths: [CW],
      rows: [new TableRow({ children: [new TableCell({
        width: { size: CW, type: WidthType.DXA },
        borders: { top: border(C.tint), bottom: border(C.tint), left: { style: BorderStyle.SINGLE, size: 24, color: C.blue }, right: border(C.tint) },
        shading: { fill: C.tint, type: ShadingType.CLEAR, color: 'auto' }, margins: { top: 80, bottom: 80, left: 200, right: 200 }, children,
      })] })],
    }),
    P('', { after: 3 }),
  ];
}

const list = (items, reference) => items.map((it) => new Paragraph({
  numbering: { reference, level: 0 }, spacing: { before: 0, after: sp(2), line: 282 }, children: runs(it, { size: pt(10.5) }),
}));

let numberedLists = 0;
function block(b) {
  switch (b.t) {
    case 'h2': return [P(b.text, { size: 13, bold: true, color: C.blue, before: 7, after: 3, keepNext: true })];
    case 'p': return [P(b.text)];
    case 'bold': return [P(b.text, { bold: true })];
    case 'note': return [P(b.text, { size: 10, color: C.muted })];
    case 'bullets': return list(b.items, 'bullets');
    case 'numbers': numberedLists += 1; return list(b.items, `num-${numberedLists}`);
    case 'table': return table(b);
    case 'image': return image(b);
    case 'callout': return callout(b);
    case 'pagebreak': return [new Paragraph({ children: [new PageBreak()] })];
    case 'sources': return b.items.map((s, i) => new Paragraph({
      spacing: { before: 0, after: sp(1), line: 246 },
      children: [
        tr({ text: `[${s.n ?? i + 1}] ${s.title} `, size: pt(8.5), color: C.ink }),
        new ExternalHyperlink({ link: s.url, children: [tr({ text: s.url, size: pt(8), color: C.blue })] }),
      ],
    }));
    default: throw new Error(`unknown block ${b.t}`);
  }
}

const m = spec.meta;
const numberedCount = spec.chapters.reduce((n, ch) => n + ch.blocks.filter((b) => b.t === 'numbers').length, 0);

const cover = [
  P('', { before: 150 }),
  P(m.kicker, { size: 16, bold: true, color: C.muted, align: AlignmentType.CENTER, after: 6 }),
  P(m.title, { size: 30, bold: true, align: AlignmentType.CENTER, after: 10, line: 1.2 }),
  P(m.subtitle, { size: 13, color: C.blue, align: AlignmentType.CENTER, after: 6 }),
  P('', { before: 200 }),
  P(m.company, { size: 14, bold: true, align: AlignmentType.CENTER, after: 4 }),
  P(`작성일 ${m.date}`, { size: 12, color: C.muted, align: AlignmentType.CENTER, after: 4 }),
  ...(m.basis ? [P(m.basis, { size: 11, color: C.muted, align: AlignmentType.CENTER, after: 4 })] : []),
  new Paragraph({ children: [new PageBreak()] }),
  P('목    차', { size: 18, bold: true, align: AlignmentType.CENTER, before: 20, after: 14 }),
  ...spec.chapters.map((ch) => P(`${ch.number}. ${ch.title}`, { size: 13, before: 0, after: 8, indent: { left: sp(60) } })),
  new Paragraph({ children: [new PageBreak()] }),
];

const bodySections = [{ columns: 1, children: [] }];
spec.chapters.forEach((ch, i) => {
  if (ch.columns && ch.columns > 1) bodySections.push({ columns: ch.columns, children: [] });
  else if (ch.pageBreak && i > 0) bodySections[bodySections.length - 1].children.push(new Paragraph({ children: [new PageBreak()] }));
  const body = bodySections[bodySections.length - 1].children;
  body.push(new Paragraph({
    heading: HeadingLevel.HEADING_1, keepNext: true,
    spacing: { before: sp(i === 0 || ch.pageBreak ? 2 : 11), after: sp(6) },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.blue, space: 4 } },
    children: [tr({ text: `${ch.number}. ${ch.title}`, size: pt(17), bold: true, color: C.blue })],
  }));
  for (const b of ch.blocks) body.push(...block(b));
});

const doc = new Document({
  creator: m.company, title: m.title, description: m.subtitle,
  styles: {
    default: { document: { run: { font: fontSet, size: pt(11), color: C.ink } } },
    paragraphStyles: [{ id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
      run: { font: fontSet, size: pt(17), bold: true, color: C.blue }, paragraph: { outlineLevel: 0 } }],
  },
  numbering: {
    config: [
      { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 440, hanging: 260 } } } }] },
      ...Array.from({ length: numberedCount }, (_, k) => ({ reference: `num-${k + 1}`, levels: [{ level: 0, format: LevelFormat.DECIMAL,
        text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 440, hanging: 300 } } } }] })),
    ],
  },
  sections: [
    { properties: { page: { size: { width: PAGE.w, height: PAGE.h }, margin: { top: PAGE.my, bottom: PAGE.my, left: PAGE.mx, right: PAGE.mx } } }, children: cover },
    ...bodySections.map((sec, si) => ({
      properties: {
        ...(si > 0 ? { type: SectionType.NEXT_PAGE } : {}),
        column: sec.columns > 1 ? { count: sec.columns, space: 360 } : undefined,
        page: { size: { width: PAGE.w, height: PAGE.h }, margin: { top: PAGE.my, bottom: PAGE.my, left: PAGE.mx, right: PAGE.mx }, ...(si === 0 ? { pageNumbers: { start: 1 } } : {}) },
      },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER,
        children: [tr({ children: [PageNumber.CURRENT], size: pt(9), color: C.muted })] })] }) },
      children: sec.children,
    })),
  ],
});

Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(outPath, buf); console.log(`wrote ${outPath} (${buf.length} bytes)`); });
