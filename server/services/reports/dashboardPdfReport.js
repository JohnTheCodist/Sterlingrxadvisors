/**
 * The web dashboard's "Export PDF" — a genuine vector report, drawn directly
 * with pdfkit, not a screenshot.
 *
 * The previous implementation rasterized the live DOM with html2canvas and
 * paginated the resulting image with jsPDF: text came out blurry at normal
 * zoom, a chart or KPI card landed however the fixed page-height slice cut
 * it — sometimes clean, usually not — and html2canvas cannot parse the
 * oklch() colors Tailwind v4 generates, which needed a computed-style-inlining
 * hack applied to every DOM node before capture even had a chance of working.
 * Drawing the report with vector primitives sidesteps all of it: crisp text
 * at any zoom, page breaks placed between sections on purpose, and no
 * dependency on whatever the browser happens to be rendering at export time.
 *
 * Deliberately its own file rather than a shared refactor of
 * services/whatsapp/pdfSummary.js, even though the visual language below is
 * close to it on purpose (one brand, one report style). That file is a
 * tested, working WhatsApp export; extracting shared primitives under this
 * task would risk regressing it for a purely cosmetic gain elsewhere.
 *
 * Currency uses a plain "N" prefix rather than the Naira glyph — confirmed in
 * pdfSummary.js that pdfkit's built-in Helvetica (WinAnsiEncoding) has no
 * slot for ₦ and silently substitutes a broken-bar character instead.
 */

const PDFDocument = require('pdfkit');

const PAGE_MARGIN = 40;
const PAGE_WIDTH = 595.28; // A4 pt
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const PAGE_HEIGHT = 841.89;
// Text written past PDFKit's own margin box silently triggers an automatic
// page break — confirmed in pdfSummary.js's development that writing the
// footer even slightly beyond this line inserted a blank trailing page.
const FOOTER_RESERVED = 34;
const PAGE_BOTTOM = PAGE_HEIGHT - PAGE_MARGIN - FOOTER_RESERVED;

const COLOR = {
  emerald: '#1F6F5C',
  emeraldDark: '#164F42',
  emeraldMuted: '#E4EFEC',
  gold: '#B8901F',
  goldMuted: '#F6EED2',
  red: '#B23A2E',
  redMuted: '#F6E3E0',
  amber: '#B4780A',
  amberMuted: '#FAEDD4',
  ink: '#1D2521',
  muted: '#6B756F',
  border: '#E3E5E2',
  panel: '#F5F6F4',
  white: '#FFFFFF',
};

const fmtN = (n) => (n == null ? 'N/A' : `N${Number(n).toLocaleString('en-NG', { maximumFractionDigits: 0 })}`);
const fmtNum = (n) => (n == null ? '0' : Number(n).toLocaleString('en-NG', { maximumFractionDigits: 1 }));

/**
 * KPI values in this file are always built with fmtN/fmtNum above, so they
 * never carry a real ₦. Insight and priority text is different: it comes
 * from recommendations.js and the widget registry, both of which format
 * currency with the real ₦ (U+20A6) glyph — correctly, since the web
 * dashboard and WhatsApp's own text messages render it fine. Only PDFKit's
 * built-in Helvetica can't (confirmed in pdfSummary.js: no WinAnsiEncoding
 * slot for it, silently drawn as a broken-bar "¦" instead) — so any prose
 * string reaching this file from elsewhere in the codebase is sanitized
 * right before it is drawn, never at the source.
 */
const sanitize = (s) => (typeof s === 'string' ? s.replace(/₦/g, 'N') : s);

function bandColors(band) {
  switch (band) {
    case 'good': return { fg: COLOR.emerald, bg: COLOR.emeraldMuted };
    case 'fair': return { fg: COLOR.gold, bg: COLOR.goldMuted };
    case 'warning': return { fg: COLOR.amber, bg: COLOR.amberMuted };
    default: return { fg: COLOR.red, bg: COLOR.redMuted };
  }
}

function severityColors(sev) {
  if (sev === 'high') return { fg: COLOR.red, bg: COLOR.redMuted, label: 'Act now' };
  if (sev === 'medium') return { fg: COLOR.amber, bg: COLOR.amberMuted, label: 'Worth reviewing' };
  if (sev === 'low') return { fg: COLOR.emerald, bg: COLOR.emeraldMuted, label: 'Healthy' };
  return { fg: COLOR.muted, bg: COLOR.panel, label: 'Context' };
}

function impactColors(impact) {
  if (impact >= 3) return { fg: COLOR.red, bg: COLOR.redMuted };
  if (impact === 2) return { fg: COLOR.amber, bg: COLOR.amberMuted };
  return { fg: COLOR.emerald, bg: COLOR.emeraldMuted };
}

function monthLabel(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[parseInt(m, 10) - 1] || m} '${y.slice(2)}`;
}

function ensureSpace(doc, cursor, needed) {
  if (cursor + needed > PAGE_BOTTOM) {
    doc.addPage();
    return PAGE_MARGIN;
  }
  return cursor;
}

function drawSectionTitle(doc, y, title, subtitle) {
  doc.fillColor(COLOR.ink).font('Helvetica-Bold').fontSize(13).text(title, PAGE_MARGIN, y);
  if (subtitle) {
    doc.fillColor(COLOR.muted).font('Helvetica').fontSize(8).text(subtitle, PAGE_MARGIN, y + 16, { width: CONTENT_WIDTH });
    return y + 32;
  }
  return y + 20;
}

function drawHeader(doc, { organizationName, datasetLabel, dateRangeLabel }) {
  const headerHeight = 96;
  doc.rect(0, 0, PAGE_WIDTH, headerHeight).fill(COLOR.emeraldDark);
  doc.fillColor(COLOR.white).font('Helvetica-Bold').fontSize(20)
    .text(organizationName || 'Business Analysis Report', PAGE_MARGIN, 24, { width: CONTENT_WIDTH - 150 });
  doc.font('Helvetica').fontSize(10).fillColor('#CFE3DD')
    .text('Full Dashboard Report', PAGE_MARGIN, 50, { width: CONTENT_WIDTH - 150 });
  if (datasetLabel) {
    doc.font('Helvetica').fontSize(9).fillColor('#CFE3DD')
      .text(datasetLabel, PAGE_MARGIN, 66, { width: CONTENT_WIDTH - 150 });
  }
  doc.font('Helvetica').fontSize(9).fillColor('#CFE3DD').text(
    new Date().toLocaleDateString('en-NG', { year: 'numeric', month: 'long', day: 'numeric' }),
    PAGE_WIDTH - PAGE_MARGIN - 150, 26, { width: 150, align: 'right' },
  );
  if (dateRangeLabel) {
    doc.font('Helvetica').fontSize(8).fillColor('#CFE3DD')
      .text(dateRangeLabel, PAGE_WIDTH - PAGE_MARGIN - 150, 40, { width: 150, align: 'right' });
  }
  return headerHeight + 24;
}

/** A grid of small KPI cards, 2 per row, deliberately reusable for both the sales and inventory sections. */
function drawKpiGrid(doc, startY, cards) {
  const gap = 12;
  const cardWidth = (CONTENT_WIDTH - gap) / 2;
  const cardHeight = 60;
  let cx = PAGE_MARGIN;
  let cy = ensureSpace(doc, startY, cardHeight + 4);

  cards.forEach((card, i) => {
    if (i > 0 && i % 2 === 0) {
      cx = PAGE_MARGIN;
      cy = ensureSpace(doc, cy + cardHeight + gap, cardHeight + 4);
    }
    doc.roundedRect(cx, cy, cardWidth, cardHeight, 6).fillAndStroke(COLOR.panel, COLOR.border);
    doc.rect(cx, cy, 4, cardHeight).fill(card.accent || COLOR.emerald);
    doc.fillColor(COLOR.muted).font('Helvetica').fontSize(9).text(card.label, cx + 16, cy + 10, { width: cardWidth - 28 });
    doc.fillColor(COLOR.ink).font('Helvetica-Bold').fontSize(16).text(card.value, cx + 16, cy + 24, { width: cardWidth - 28 });
    if (card.sub) doc.fillColor(COLOR.muted).font('Helvetica').fontSize(8).text(card.sub, cx + 16, cy + 44, { width: cardWidth - 28 });
    if (i % 2 === 0) cx += cardWidth + gap;
  });

  const rows = Math.ceil(cards.length / 2);
  return cy + cardHeight + (rows > 0 ? 20 : 0);
}

function drawHealthSection(doc, startY, bizHealth) {
  if (!bizHealth) return startY;
  let y = ensureSpace(doc, startY, 140);
  y = drawSectionTitle(doc, y, 'Business Health');

  const overall = bandColors(
    bizHealth.rating === 'Excellent' || bizHealth.rating === 'Healthy' ? 'good'
      : bizHealth.rating === 'Stable' ? 'fair'
        : bizHealth.rating === 'At Risk' ? 'warning' : 'critical',
  );

  doc.roundedRect(PAGE_MARGIN, y, 70, 40, 6).fill(overall.bg);
  doc.fillColor(overall.fg).font('Helvetica-Bold').fontSize(20).text(String(bizHealth.overallScore), PAGE_MARGIN, y + 8, { width: 70, align: 'center' });
  doc.fillColor(COLOR.ink).font('Helvetica-Bold').fontSize(11).text(bizHealth.rating || '', PAGE_MARGIN + 84, y + 6);
  doc.fillColor(COLOR.muted).font('Helvetica').fontSize(8).text('Overall score out of 100', PAGE_MARGIN + 84, y + 22);
  y += 56;

  for (const p of bizHealth.pillars || []) {
    const c = bandColors(p.band);
    doc.fillColor(COLOR.ink).font('Helvetica').fontSize(9).text(p.name, PAGE_MARGIN, y, { width: 150 });
    doc.fillColor(COLOR.muted).font('Helvetica').fontSize(9).text(`${p.score}/100`, PAGE_MARGIN + CONTENT_WIDTH - 40, y, { width: 40, align: 'right' });
    const barX = PAGE_MARGIN + 150;
    const barW = CONTENT_WIDTH - 150 - 44;
    doc.roundedRect(barX, y + 1, barW, 8, 4).fill(COLOR.border);
    doc.roundedRect(barX, y + 1, Math.max(6, (barW * Math.min(100, p.score)) / 100), 8, 4).fill(c.fg);
    y += 18;
  }

  return y + 16;
}

function drawTrendChart(doc, startY, monthlyRevenue) {
  const months = (monthlyRevenue || []).slice(-9);
  if (months.length < 2) return startY;

  const chartHeight = 120;
  let y = ensureSpace(doc, startY, chartHeight + 40);
  y = drawSectionTitle(doc, y, 'Revenue Trend', 'Monthly revenue for the current upload.');

  const maxRev = Math.max(...months.map((m) => m.revenue), 1);
  const gap = 10;
  const barWidth = (CONTENT_WIDTH - gap * (months.length - 1)) / months.length;
  const baseY = y + chartHeight;

  months.forEach((m, i) => {
    const barH = Math.max(3, (chartHeight - 18) * (m.revenue / maxRev));
    const bx = PAGE_MARGIN + i * (barWidth + gap);
    doc.fillColor(COLOR.muted).font('Helvetica').fontSize(6.5).text(fmtN(m.revenue), bx, baseY - barH - 11, { width: barWidth, align: 'center' });
    doc.roundedRect(bx, baseY - barH, barWidth, barH, 3).fill(COLOR.emerald);
    doc.fillColor(COLOR.muted).font('Helvetica').fontSize(7.5).text(monthLabel(m.month), bx, baseY + 4, { width: barWidth, align: 'center' });
  });

  return baseY + 24;
}

function drawTopProducts(doc, startY, topProducts) {
  const products = (topProducts || []).slice(0, 8);
  if (products.length === 0) return startY;

  let y = ensureSpace(doc, startY, 30 + products.length * 28);
  y = drawSectionTitle(doc, y, 'Top Products by Revenue');

  const maxRev = Math.max(...products.map((p) => p.revenue || 0), 1);
  products.forEach((p, i) => {
    y = ensureSpace(doc, y, 28);
    doc.roundedRect(PAGE_MARGIN, y, 18, 18, 4).fill(COLOR.emeraldMuted);
    doc.fillColor(COLOR.emerald).font('Helvetica-Bold').fontSize(9).text(String(i + 1), PAGE_MARGIN, y + 4, { width: 18, align: 'center' });
    doc.fillColor(COLOR.ink).font('Helvetica').fontSize(10).text(p.name, PAGE_MARGIN + 26, y + 2, { width: CONTENT_WIDTH - 26 - 110 });
    doc.fillColor(COLOR.ink).font('Helvetica-Bold').fontSize(10).text(fmtN(p.revenue), PAGE_MARGIN + CONTENT_WIDTH - 100, y + 2, { width: 100, align: 'right' });
    const barY = y + 16;
    const barW = CONTENT_WIDTH - 26;
    doc.roundedRect(PAGE_MARGIN + 26, barY, barW, 5, 2.5).fill(COLOR.border);
    doc.roundedRect(PAGE_MARGIN + 26, barY, Math.max(4, (barW * (p.revenue || 0)) / maxRev), 5, 2.5).fill(COLOR.gold);
    y += 28;
  });

  return y + 14;
}

function drawPriorities(doc, startY, insights) {
  const items = (insights || []).slice(0, 3);
  if (items.length === 0) return startY;

  let y = ensureSpace(doc, startY, 30);
  y = drawSectionTitle(doc, y, 'Top Priorities');

  items.forEach((ins, i) => {
    const c = impactColors(ins.impact || 1);
    const observation = sanitize(ins.observation);
    const action = sanitize(ins.recommendedAction || '');
    const obsHeight = doc.font('Helvetica-Bold').fontSize(10).heightOfString(observation, { width: CONTENT_WIDTH - 24 });
    const actHeight = doc.font('Helvetica').fontSize(9).heightOfString(action, { width: CONTENT_WIDTH - 24 });
    const cardHeight = obsHeight + actHeight + 24;

    y = ensureSpace(doc, y, cardHeight + 10);
    doc.roundedRect(PAGE_MARGIN, y, CONTENT_WIDTH, cardHeight, 4).fill(c.bg);
    doc.rect(PAGE_MARGIN, y, 4, cardHeight).fill(c.fg);
    doc.fillColor(COLOR.ink).font('Helvetica-Bold').fontSize(10).text(`${i + 1}. ${observation}`, PAGE_MARGIN + 14, y + 8, { width: CONTENT_WIDTH - 24 });
    doc.fillColor(COLOR.muted).font('Helvetica').fontSize(9).text(action, PAGE_MARGIN + 14, y + 8 + obsHeight + 6, { width: CONTENT_WIDTH - 24 });
    y += cardHeight + 10;
  });

  return y;
}

/**
 * The insight/action/severity note already computed for every stock-side
 * widget on the live dashboard (see client/src/components/ExecutiveNote.jsx)
 * — carried into the PDF verbatim rather than re-derived, so the report can
 * never disagree with the chart it is summarizing.
 */
function drawInventoryRisk(doc, startY, { kpis, notes }) {
  if ((!kpis || kpis.length === 0) && (!notes || notes.length === 0)) return startY;

  let y = ensureSpace(doc, startY, 30);
  y = drawSectionTitle(doc, y, 'Inventory Risk');

  if (kpis && kpis.length > 0) y = drawKpiGrid(doc, y, kpis);

  const top = (notes || []).slice(0, 4);
  top.forEach((rawNote) => {
    const note = { ...rawNote, insight: sanitize(rawNote.insight), action: sanitize(rawNote.action) };
    const c = severityColors(note.severity);
    const insightHeight = doc.font('Helvetica-Bold').fontSize(9.5).heightOfString(note.insight || '', { width: CONTENT_WIDTH - 24 });
    const actionHeight = note.action
      ? doc.font('Helvetica').fontSize(8.5).heightOfString(note.action, { width: CONTENT_WIDTH - 24 })
      : 0;
    const cardHeight = insightHeight + actionHeight + (note.action ? 22 : 16);

    y = ensureSpace(doc, y, cardHeight + 8);
    doc.roundedRect(PAGE_MARGIN, y, CONTENT_WIDTH, cardHeight, 4).fillAndStroke(COLOR.panel, COLOR.border);
    doc.rect(PAGE_MARGIN, y, 3, cardHeight).fill(c.fg);
    doc.fillColor(c.fg).font('Helvetica-Bold').fontSize(7).text(c.label.toUpperCase(), PAGE_MARGIN + 12, y + 7);
    doc.fillColor(COLOR.ink).font('Helvetica-Bold').fontSize(9.5).text(note.insight || '', PAGE_MARGIN + 12, y + 18, { width: CONTENT_WIDTH - 24 });
    if (note.action) {
      doc.fillColor(COLOR.muted).font('Helvetica').fontSize(8.5)
        .text(note.action, PAGE_MARGIN + 12, y + 18 + insightHeight + 4, { width: CONTENT_WIDTH - 24 });
    }
    y += cardHeight + 8;
  });

  return y + 10;
}

function drawFooter(doc) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.fillColor(COLOR.muted).font('Helvetica').fontSize(8).text(
      `Generated by RxNaija Analytics — page ${i + 1} of ${range.count}`,
      PAGE_MARGIN, PAGE_HEIGHT - PAGE_MARGIN - 16, { width: CONTENT_WIDTH, align: 'center' },
    );
  }
}

/**
 * @param {object} ctx
 * @param {string} ctx.organizationName
 * @param {string} [ctx.datasetLabel] — e.g. "Current upload: pharmacy_daily_sales.xlsx"
 * @param {string} [ctx.dateRangeLabel]
 * @param {object} ctx.kpis — sales KPI cards: [{label, value, sub, accent}]
 * @param {object} [ctx.bizHealth] — { overallScore, rating, pillars }
 * @param {object[]} [ctx.insights] — business-health insights, top 3 used
 * @param {object[]} [ctx.monthlyRevenue] — [{month, revenue}]
 * @param {object[]} [ctx.topProducts] — [{name, revenue}]
 * @param {object} [ctx.inventory] — { kpis: [{label,value,sub,accent}], notes: [{insight,action,severity}] }
 * @returns {Promise<Buffer>}
 */
function buildDashboardPdf(ctx) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let y = drawHeader(doc, ctx);

    if (ctx.kpis && ctx.kpis.length > 0) {
      y = drawSectionTitle(doc, y, 'Sales Overview');
      y = drawKpiGrid(doc, y, ctx.kpis);
    }

    y = drawHealthSection(doc, y, ctx.bizHealth);
    y = drawPriorities(doc, y, ctx.insights);
    y = drawTrendChart(doc, y, ctx.monthlyRevenue);
    y = drawTopProducts(doc, y, ctx.topProducts);
    if (ctx.inventory) y = drawInventoryRisk(doc, y, ctx.inventory);

    drawFooter(doc);
    doc.end();
  });
}

module.exports = { buildDashboardPdf, fmtN, fmtNum };
