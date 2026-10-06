// Builds the end-user guides from one shared content definition:
//   docs/Worker-Guide.docx, docs/Admin-Guide.docx  (Word, editable)
//   docs/Worker-Guide.pdf,  docs/Admin-Guide.pdf   (PDF, printed with Chromium via Playwright)
//
//   APP_LINK=https://sensoria-attendance.example.workers.dev node docs/build-guides.cjs
//
// Without APP_LINK the guides show a highlighted YOUR-LINK placeholder to fill in.
// PDFs need Playwright with Chromium (set PLAYWRIGHT_PATH to the playwright module if it isn't installed locally).

const fs = require('node:fs');
const path = require('node:path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, ShadingType,
  BorderStyle, AlignmentType, LevelFormat, ExternalHyperlink, Footer, PageNumber,
} = require('docx');

const LINK = (process.env.APP_LINK || '').replace(/\/+$/, '');
const TEAL = '0F766E';
const GREY = '5F6B76';

// ---------------------------------------------------------------------------
// Content. Inline text uses **bold**; { link: '/path' } inserts the app link.
// ---------------------------------------------------------------------------

const L = (p) => ({ link: p });

const WORKER = {
  file: 'Worker-Guide',
  title: 'Attendance App: Worker Guide',
  subtitle: 'How to clock in and out for your shifts',
  blocks: [
    { t: 'box', paras: [
      ['**Your app link:**  ', L('/')],
      ['**Sign in with:** your phone number (or staff ID) and the PIN your supervisor gave you.'],
    ] },
    { t: 'h', text: 'First time (before your first shift)' },
    { t: 'steps', items: [
      ['Open the link above **on your own phone**.'],
      ['Sign in with your phone number and PIN.'],
      ['Optional: add it to your home screen so it opens like an app. Do this **before your first clock-in**, and from then on always open it the same way.'],
      ['When your phone asks for your location, tap **Allow**.'],
    ] },
    { t: 'bullets', items: [
      ['**iPhone (Safari):** tap the Share button → **Add to Home Screen**'],
      ['**Android (Chrome):** tap the ⋮ menu → **Add to Home screen**'],
    ] },
    { t: 'h', text: 'Every shift' },
    { t: 'steps', items: [
      ['At the venue, open the app and tap the green **Clock IN** button.'],
      ['When you finish, tap the red **Clock OUT** button.'],
      ['That’s it. Your supervisor approves your hours.'],
    ] },
    { t: 'h', text: 'Good to know' },
    { t: 'bullets', items: [
      ['**Hours are rounded to the nearest 15 minutes.** Example: in at 1:13 pm, out at 3:24 pm counts as 1:15 to 3:30 = **2 h 15 min**.'],
      ['Tap **My hours** to see each shift, whether it is approved, who approved it and when.'],
      ['Use **only your own phone**. Clocking in for someone else, or on someone else’s phone, is flagged to your supervisor.'],
      ['Your location is checked when you clock in and out, so do it **at the venue**.'],
    ] },
    { t: 'h', text: 'Problems?' },
    { t: 'table', widths: [0.32, 0.68], rows: [
      [['Problem'], ['What to do']],
      [['Forgot to clock out'], ['Tell your supervisor what time you finished. You can still clock in next time as normal.']],
      [['“Location denied” message'], ['Turn on GPS / Location, then allow location for the site in your browser settings and try again.']],
      [['Forgot your PIN'], ['Ask your supervisor to reset it.']],
      [['Got a new phone'], ['Tell your supervisor so they can register your new phone.']],
    ] },
  ],
};

const ADMIN = {
  file: 'Admin-Guide',
  title: 'Attendance App: Admin Guide',
  subtitle: 'For supervisors and managers',
  blocks: [
    { t: 'h', text: 'Links' },
    { t: 'table', widths: [0.36, 0.64], rows: [
      [['What'], ['Link']],
      [['**First-time setup:** creates the first admin (owner, **once only**)'], [L('/setup')]],
      [['**Sign in:** same page for everyone'], [L('/login')]],
      [['**Worker:** clock in / out'], [L('/')]],
      [['**Worker:** my hours'], [L('/me')]],
      [['**Admin:** dashboard (today)'], [L('/admin')]],
      [['**Admin:** approvals (all pending)'], [L('/admin/pending')]],
      [['**Admin:** people, add accounts, reset PINs'], [L('/admin/people')]],
      [['**Admin:** monthly export (CSV)'], [L('/admin/export')]],
      [['**Admin:** settings and work sites'], [L('/admin/settings')]],
    ] },
    { t: 'p', parts: ['**Accounts:** workers cannot sign up themselves. An admin creates every account, for workers and other admins, under **People**.'] },
    { t: 'h', text: 'One-time setup' },
    { t: 'steps', items: [
      ['Open ', L('/setup'), ' and create your admin account (username + password of 8 or more characters).'],
      ['**Settings → Work sites:** stand at the venue, tap **Use my current location**, then **Add site**. A radius of 150 m works well.'],
      ['**People:** add each worker with name, **phone number** (their sign-in ID), a **PIN** (4 or more digits) and, optionally, an hourly rate. Add other admins here too (Role: Supervisor).'],
      ['Send each worker the **Worker Guide** and their sign-in details (message template at the end).'],
    ] },
    { t: 'h', text: 'Every day (Dashboard)' },
    { t: 'bullets', items: [
      ['The cards at the top show **Working now**, **Clocked out**, **Not clocked in** and **To approve**.'],
      ['Tick the shifts under **Check-ins today**, then tap **Approve selected**. Ideally do this the same day.'],
      ['Shifts with a yellow flag: tap **View** first to see the location (with a map link) and the phone used.'],
      ['**Wrong time / forgot to clock out:** View → enter the correct times → **Save**. Every change is kept in the shift history.'],
      ['**Someone couldn’t clock in:** under **Not clocked in**, tap **+ add shift**.'],
      ['**Reject a shift:** View → type a reason → **Reject**. The worker sees the reason.'],
    ] },
    { t: 'h', text: 'What the flags mean' },
    { t: 'table', widths: [0.38, 0.62], rows: [
      [['Flag'], ['Meaning / what to do']],
      [['Checked in outside area · No GPS'], ['Not at the venue, or GPS was off. Check the map, then ask the worker.']],
      [['Not their registered phone'], ['They used a different phone. If they changed phone, register the new one (see Phones).']],
      [['Device also used by another worker'], ['Two workers used the same phone. Possibly someone clocking in for a friend.']],
      [['Many different phones lately (red banner)'], ['Strong warning sign. Check with the worker.']],
      [['Never clocked out'], ['Enter the real finish time before approving.']],
    ] },
    { t: 'h', text: 'Phones' },
    { t: 'p', parts: ['A worker’s first phone is registered automatically. If they genuinely change phone: **People → their name → Phones → Register** the new one, and **Unregister** the old one.'] },
    { t: 'h', text: 'Month end (Export)' },
    { t: 'bullets', items: [
      ['Approve everything still pending first. **Only approved hours count as payable.**'],
      ['**Summary CSV:** one row per worker with total hours and pay, plus hours for every day of the month.'],
      ['**Detailed CSV:** every shift with actual and rounded times, who approved it and when.'],
      ['Hours are rounded to the **nearest 15 minutes** (e.g. 1:13 → 1:15, 3:24 → 3:30).'],
    ] },
    { t: 'h', text: 'People admin' },
    { t: 'bullets', items: [
      ['**Reset a PIN:** People → name → type a new PIN → Save.'],
      ['**Someone leaves:** People → name → untick **Active** → Save. Their history is kept.'],
    ] },
    { t: 'h', text: 'Message template for workers' },
    { t: 'box', paras: [
      ['Hi [name], here’s our attendance app: ', L('/')],
      ['Sign in with your phone number [number] and PIN [PIN].'],
      ['Please use your own phone, allow location, and tap Clock IN / Clock OUT at the venue each shift.'],
    ] },
  ],
};

// Split "a **b** c" into [{text, bold}].
function segments(str) {
  return String(str).split(/(\*\*[^*]+\*\*)/).filter(Boolean)
    .map((s) => (s.startsWith('**') ? { text: s.slice(2, -2), bold: true } : { text: s, bold: false }));
}
const linkText = (p) => (LINK ? LINK + (p === '/' ? '' : p) : `YOUR-LINK${p === '/' ? '' : p}`);

// ---------------------------------------------------------------------------
// Word renderer
// ---------------------------------------------------------------------------

const PAGE_W = 11906; // A4
const MARGIN = 1134; // 2 cm
const CONTENT_W = PAGE_W - 2 * MARGIN;
const cellBorder = { style: BorderStyle.SINGLE, size: 4, color: 'D5DCE2' };

function docxInline(parts, { linkSize, ...base } = {}) {
  return parts.flatMap((part) => {
    if (typeof part === 'object') {
      const text = linkText(part.link);
      const size = linkSize ? { size: linkSize } : {};
      if (!LINK) return [new TextRun({ text, bold: true, highlight: 'yellow', ...size })];
      return [new ExternalHyperlink({ link: LINK + part.link, children: [new TextRun({ text, style: 'Hyperlink', ...size })] })];
    }
    return segments(part).map((s) => new TextRun({ text: s.text, bold: s.bold || base.bold, ...base, ...(s.bold ? { bold: true } : {}) }));
  });
}

function buildDocx(guide) {
  const numbering = [{
    reference: 'bullets',
    levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 400, hanging: 260 } } } }],
  }];
  let n = 0;
  const children = [
    new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: guide.title, bold: true, size: 40, color: TEAL })] }),
    new Paragraph({
      spacing: { after: 240 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: TEAL, space: 6 } },
      children: [new TextRun({ text: guide.subtitle, color: GREY, size: 22 })],
    }),
  ];
  for (const b of guide.blocks) {
    if (b.t === 'h') {
      children.push(new Paragraph({ spacing: { before: 280, after: 100 }, keepNext: true, children: [new TextRun({ text: b.text, bold: true, size: 28, color: TEAL })] }));
    } else if (b.t === 'p') {
      children.push(new Paragraph({ spacing: { before: 120, after: 100 }, children: docxInline(b.parts) }));
    } else if (b.t === 'steps' || b.t === 'bullets') {
      let reference = 'bullets';
      if (b.t === 'steps') {
        reference = `steps-${++n}`;
        numbering.push({ reference, levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 400, hanging: 300 } } } }] });
      }
      for (const item of b.items) children.push(new Paragraph({ numbering: { reference, level: 0 }, spacing: { after: 80 }, children: docxInline(item) }));
    } else if (b.t === 'table') {
      const widths = b.widths.map((f) => Math.round(f * CONTENT_W));
      widths[widths.length - 1] = CONTENT_W - widths.slice(0, -1).reduce((a, w) => a + w, 0);
      children.push(new Table({
        width: { size: CONTENT_W, type: WidthType.DXA },
        columnWidths: widths,
        rows: b.rows.map((row, r) => new TableRow({
          tableHeader: r === 0,
          cantSplit: true,
          children: row.map((cell, c) => new TableCell({
            width: { size: widths[c], type: WidthType.DXA },
            borders: { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder },
            shading: r === 0 ? { fill: 'E6F2F1', type: ShadingType.CLEAR, color: 'auto' } : undefined,
            margins: { top: 70, bottom: 70, left: 110, right: 110 },
            children: [new Paragraph({ children: docxInline(cell, r === 0 ? { bold: true } : { linkSize: 18 }) })],
          })),
        })),
      }));
    } else if (b.t === 'box') {
      const edge = { style: BorderStyle.SINGLE, size: 4, color: TEAL };
      children.push(new Table({
        width: { size: CONTENT_W, type: WidthType.DXA },
        columnWidths: [CONTENT_W],
        rows: [new TableRow({
          children: [new TableCell({
            width: { size: CONTENT_W, type: WidthType.DXA },
            borders: { top: edge, bottom: edge, right: edge, left: { style: BorderStyle.SINGLE, size: 24, color: TEAL } },
            shading: { fill: 'F1F7F6', type: ShadingType.CLEAR, color: 'auto' },
            margins: { top: 120, bottom: 120, left: 180, right: 180 },
            children: b.paras.map((para, i) => new Paragraph({ spacing: { after: i < b.paras.length - 1 ? 80 : 0 }, children: docxInline(para) })),
          })],
        })],
      }));
    }
  }
  const short = guide.title.split(': ')[1];
  return new Document({
    title: guide.title,
    creator: 'Attendance app',
    styles: { default: { document: { run: { font: 'Arial', size: 22 } } } },
    numbering: { config: numbering },
    sections: [{
      properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: `${short} · page `, color: GREY, size: 16 }), new TextRun({ children: [PageNumber.CURRENT], color: GREY, size: 16 })],
          })],
        }),
      },
      children,
    }],
  });
}

// ---------------------------------------------------------------------------
// HTML renderer (printed to PDF)
// ---------------------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function htmlInline(parts) {
  return parts.map((part) => {
    if (typeof part === 'object') {
      // Allow a line break only between the address and the path.
      const text = esc(linkText(part.link)).replace(/(\.dev|LINK)\//, '$1<wbr>/');
      return LINK ? `<a href="${esc(LINK + part.link)}">${text}</a>` : `<mark>${text}</mark>`;
    }
    return segments(part).map((s) => (s.bold ? `<b>${esc(s.text)}</b>` : esc(s.text))).join('');
  }).join('');
}

function buildHtml(guide) {
  const body = guide.blocks.map((b) => {
    if (b.t === 'h') return `<h2>${esc(b.text)}</h2>`;
    if (b.t === 'p') return `<p>${htmlInline(b.parts)}</p>`;
    if (b.t === 'steps') return `<ol>${b.items.map((i) => `<li>${htmlInline(i)}</li>`).join('')}</ol>`;
    if (b.t === 'bullets') return `<ul>${b.items.map((i) => `<li>${htmlInline(i)}</li>`).join('')}</ul>`;
    if (b.t === 'box') return `<div class="box">${b.paras.map((p) => `<p>${htmlInline(p)}</p>`).join('')}</div>`;
    if (b.t === 'table') {
      const cols = b.widths.map((w) => `<col style="width:${(w * 100).toFixed(1)}%">`).join('');
      const [head, ...rows] = b.rows;
      return `<table><colgroup>${cols}</colgroup><thead><tr>${head.map((c) => `<th>${htmlInline(c)}</th>`).join('')}</tr></thead>`
        + `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${htmlInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
    return '';
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(guide.title)}</title><style>
    @page { size: A4; margin: 20mm 20mm 18mm; }
    body { font: 10.5pt/1.45 Arial, Helvetica, sans-serif; color: #17202a; margin: 0; }
    h1 { color: #${TEAL}; font-size: 20pt; margin: 0 0 2pt; }
    .sub { color: #${GREY}; margin: 0 0 14pt; padding-bottom: 6pt; border-bottom: 1.5pt solid #${TEAL}; }
    h2 { color: #${TEAL}; font-size: 13.5pt; margin: 16pt 0 5pt; break-after: avoid; }
    p { margin: 6pt 0; }
    ol, ul { margin: 4pt 0; padding-left: 18pt; }
    li { margin: 3pt 0; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; margin: 4pt 0; }
    th, td { border: 0.6pt solid #d5dce2; padding: 4pt 6pt; text-align: left; vertical-align: top; }
    td a, td mark { font-size: 9pt; white-space: nowrap; }
    th { background: #e6f2f1; }
    tr { break-inside: avoid; }
    .box { background: #f1f7f6; border: 0.6pt solid #${TEAL}; border-left: 3pt solid #${TEAL}; padding: 6pt 10pt; break-inside: avoid; }
    .box p { margin: 3pt 0; }
    mark { background: #fff176; font-weight: bold; padding: 0 2pt; }
    a { color: #${TEAL}; }
  </style></head><body><h1>${esc(guide.title)}</h1><p class="sub">${esc(guide.subtitle)}</p>${body}</body></html>`;
}

async function buildPdfs(guides) {
  let playwright;
  try {
    playwright = require(process.env.PLAYWRIGHT_PATH || 'playwright');
  } catch {
    console.log('Playwright not found: skipped PDFs (set PLAYWRIGHT_PATH to build them).');
    return;
  }
  const launch = {};
  if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
  const browser = await playwright.chromium.launch(launch);
  const page = await browser.newPage();
  for (const g of guides) {
    await page.setContent(buildHtml(g), { waitUntil: 'load' });
    const short = g.title.split(': ')[1];
    await page.pdf({
      path: path.join(__dirname, `${g.file}.pdf`),
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;font:8pt Arial;color:#${GREY};text-align:right;padding-right:20mm">${short} · page <span class="pageNumber"></span></div>`,
      margin: { top: '20mm', bottom: '18mm', left: '20mm', right: '20mm' },
    });
  }
  await browser.close();
}

(async () => {
  const guides = [WORKER, ADMIN];
  for (const g of guides) fs.writeFileSync(path.join(__dirname, `${g.file}.docx`), await Packer.toBuffer(buildDocx(g)));
  await buildPdfs(guides);
  console.log(`Built guides (${LINK || 'placeholder YOUR-LINK'})`);
})();
