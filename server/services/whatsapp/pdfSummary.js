/**
 * Full visual business report via pdfkit — styled to read like the web
 * dashboard (KPI cards, health meters, a revenue trend chart, ranked
 * products, prioritized actions), not a plain text dump. Stays dependency-free
 * (no headless browser) since pdfkit can draw everything it needs with
 * vector primitives; the only real constraint that matters now is that a
 * pharmacy owner can open it on a phone and understand their business at a
 * glance, the way they would on the website.
 *
 * IMPORTANT: pdfkit's built-in Helvetica uses WinAnsiEncoding, which has no
 * slot for ₦ (U+20A6) — confirmed by generating a test PDF and re-extracting
 * its text with pdfjs-dist: the Naira sign came back as "¦" (broken bar),
 * not ₦. So this file formats currency with a plain "N" prefix instead of
 * the Unicode symbol. WhatsApp text messages (summaryText.js) are unaffected
 * — phones render ₦ correctly there; only pdfkit's built-in font can't.
 */

const PDFDocument = require('pdfkit');

const PAGE_MARGIN = 40;
const PAGE_WIDTH = 595.28; // A4 pt
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const PAGE_HEIGHT = 841.89;
// Reserves room for the footer below the last content block. Crucially,
// this must stay comfortably inside PDFKit's own configured margin box
// (PAGE_HEIGHT - PAGE_MARGIN) — writing text even slightly past that
// boundary silently triggers PDFKit's automatic page-break-on-overflow,
// which (confirmed by generating a test PDF) inserted a blank extra page
// every time the footer loop redrew text below the margin line.
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

function fmtN(n) {
  if (n == null) return 'N/A';
  return `N${Number(n).toLocaleString('en-NG', { maximumFractionDigits: 0 })}`;
}

function bandColors(band) {
  switch (band) {
    case 'good': return { fg: COLOR.emerald, bg: COLOR.emeraldMuted };
    case 'fair': return { fg: COLOR.gold, bg: COLOR.goldMuted };
    case 'warning': return { fg: COLOR.amber, bg: COLOR.amberMuted };
    default: return { fg: COLOR.red, bg: COLOR.redMuted };
  }
}

function impactColors(impact) {
  if (impact >= 3) return { fg: COLOR.red, bg: COLOR.redMuted };
  if (impact === 2) return { fg: COLOR.amber, bg: COLOR.amberMuted };
  return { fg: COLOR.emerald, bg: COLOR.emeraldMuted };
}

// Short form: same bar-chart width constraint as the dashboard PDF — the
// label sits under a bar sized CONTENT_WIDTH / number-of-months.
const { monthShort: monthLabel } = require('../monthFormat');

/** Adds a new page (with the standard footer space reserved) if `needed` pt won't fit before PAGE_BOTTOM. */
function ensureSpace(doc, cursor, needed) {
  if (cursor + needed > PAGE_BOTTOM) {
    doc.addPage();
    return PAGE_MARGIN;
  }
  return cursor;
}

function drawSectionTitle(doc, y, title) {
  doc.fillColor(COLOR.ink).font('Helvetica-Bold').fontSize(13).text(title, PAGE_MARGIN, y);
  return y + 20;
}

function drawHeader(doc, pharmacyName) {
  const headerHeight = 90;
  doc.rect(0, 0, PAGE_WIDTH, headerHeight).fill(COLOR.emeraldDark);
  doc.fillColor(COLOR.white).font('Helvetica-Bold').fontSize(20).text(pharmacyName, PAGE_MARGIN, 28, { width: CONTENT_WIDTH - 140 });
  doc.font('Helvetica').fontSize(10).fillColor('#CFE3DD').text('Business Analysis Report', PAGE_MARGIN, 54);
  doc.font('Helvetica').fontSize(9).fillColor('#CFE3DD').text(
    new Date().toLocaleDateString('en-NG', { year: 'numeric', month: 'long', day: 'numeric' }),
    PAGE_WIDTH - PAGE_MARGIN - 140, 30, { width: 140, align: 'right' },
  );
  return headerHeight + 24;
}

function drawKpiCards(doc, y, overview) {
  const cards = [
    { label: 'Total Revenue', value: fmtN(overview.totalRevenue) },
    {
      label: 'Gross Profit',
      value: overview.grossProfit != null ? fmtN(overview.grossProfit) : 'N/A',
      sub: overview.grossMargin != null ? `${overview.grossMargin}% margin` : null,
    },
    { label: 'Transactions', value: String(overview.transactionCount ?? 0) },
    { label: 'Avg. Transaction', value: fmtN(overview.averageTransactionValue) },
  ];

  const gap = 12;
  const cardWidth = (CONTENT_WIDTH - gap) / 2;
  const cardHeight = 62;
  let cx = PAGE_MARGIN;
  let cy = y;

  cards.forEach((card, i) => {
    if (i === 2) { cx = PAGE_MARGIN; cy += cardHeight + gap; }
    doc.roundedRect(cx, cy, cardWidth, cardHeight, 6).fillAndStroke(COLOR.panel, COLOR.border);
    doc.rect(cx, cy, 4, cardHeight).fill(COLOR.emerald);
    doc.fillColor(COLOR.muted).font('Helvetica').fontSize(9).text(card.label, cx + 16, cy + 12, { width: cardWidth - 28 });
    doc.fillColor(COLOR.ink).font('Helvetica-Bold').fontSize(17).text(card.value, cx + 16, cy + 26, { width: cardWidth - 28 });
    if (card.sub) doc.fillColor(COLOR.muted).font('Helvetica').fontSize(8).text(card.sub, cx + 16, cy + 46, { width: cardWidth - 28 });
    if (i !== 2) cx += cardWidth + gap;
  });

  return cy + cardHeight + 28;
}

function drawHealthSection(doc, startY, bizHealth) {
  let y = ensureSpace(doc, startY, 140);
  y = drawSectionTitle(doc, y, 'Business Health');

  const overall = bandColors(bizHealth.rating === 'Excellent' || bizHealth.rating === 'Good' ? 'good'
    : bizHealth.rating === 'Fair' ? 'fair' : bizHealth.rating === 'Poor' ? 'warning' : 'critical');

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
  const months = (monthlyRevenue || []).slice(-6);
  if (months.length < 2) return startY;

  const chartHeight = 110;
  let y = ensureSpace(doc, startY, chartHeight + 40);
  y = drawSectionTitle(doc, y, 'Revenue Trend');

  const maxRev = Math.max(...months.map((m) => m.revenue), 1);
  const gap = 14;
  const barWidth = (CONTENT_WIDTH - gap * (months.length - 1)) / months.length;
  const baseY = y + chartHeight;

  months.forEach((m, i) => {
    const barH = Math.max(3, (chartHeight - 18) * (m.revenue / maxRev));
    const bx = PAGE_MARGIN + i * (barWidth + gap);
    doc.fillColor(COLOR.muted).font('Helvetica').fontSize(7).text(fmtN(m.revenue), bx, baseY - barH - 12, { width: barWidth, align: 'center' });
    doc.roundedRect(bx, baseY - barH, barWidth, barH, 3).fill(COLOR.emerald);
    doc.fillColor(COLOR.muted).font('Helvetica').fontSize(8).text(monthLabel(m.month), bx, baseY + 4, { width: barWidth, align: 'center' });
  });

  return baseY + 24;
}

function drawTopProducts(doc, startY, top10) {
  const products = (top10 || []).slice(0, 5);
  if (products.length === 0) return startY;

  let y = ensureSpace(doc, startY, 30 + products.length * 30);
  y = drawSectionTitle(doc, y, 'Top Products');

  const maxShare = Math.max(...products.map((p) => p.revenueShare || 0), 1);
  products.forEach((p, i) => {
    doc.roundedRect(PAGE_MARGIN, y, 18, 18, 4).fill(COLOR.emeraldMuted);
    doc.fillColor(COLOR.emerald).font('Helvetica-Bold').fontSize(9).text(String(i + 1), PAGE_MARGIN, y + 4, { width: 18, align: 'center' });
    doc.fillColor(COLOR.ink).font('Helvetica').fontSize(10).text(p.name, PAGE_MARGIN + 26, y + 2, { width: CONTENT_WIDTH - 26 - 110 });
    doc.fillColor(COLOR.ink).font('Helvetica-Bold').fontSize(10).text(fmtN(p.revenue), PAGE_MARGIN + CONTENT_WIDTH - 100, y + 2, { width: 100, align: 'right' });
    const barY = y + 16;
    const barW = CONTENT_WIDTH - 26;
    doc.roundedRect(PAGE_MARGIN + 26, barY, barW, 5, 2.5).fill(COLOR.border);
    doc.roundedRect(PAGE_MARGIN + 26, barY, Math.max(4, (barW * (p.revenueShare || 0)) / maxShare), 5, 2.5).fill(COLOR.gold);
    y += 30;
  });

  return y + 14;
}

function drawPriorities(doc, startY, bizInsights) {
  const items = (bizInsights || []).slice(0, 3);
  if (items.length === 0) return startY;

  let y = startY;
  y = ensureSpace(doc, y, 30);
  y = drawSectionTitle(doc, y, 'Priorities');

  items.forEach((ins, i) => {
    const c = impactColors(ins.impact || 1);
    const obsHeight = doc.font('Helvetica-Bold').fontSize(10).heightOfString(ins.observation, { width: CONTENT_WIDTH - 20 });
    const actHeight = doc.font('Helvetica').fontSize(9).heightOfString(ins.recommendedAction || '', { width: CONTENT_WIDTH - 20 });
    const cardHeight = obsHeight + actHeight + 24;

    y = ensureSpace(doc, y, cardHeight + 10);
    doc.roundedRect(PAGE_MARGIN, y, CONTENT_WIDTH, cardHeight, 4).fill(c.bg);
    doc.rect(PAGE_MARGIN, y, 4, cardHeight).fill(c.fg);
    doc.fillColor(COLOR.ink).font('Helvetica-Bold').fontSize(10).text(`${i + 1}. ${ins.observation}`, PAGE_MARGIN + 14, y + 8, { width: CONTENT_WIDTH - 24 });
    doc.fillColor(COLOR.muted).font('Helvetica').fontSize(9).text(ins.recommendedAction || '', PAGE_MARGIN + 14, y + 8 + obsHeight + 6, { width: CONTENT_WIDTH - 24 });
    y += cardHeight + 10;
  });

  return y;
}

function drawFooter(doc) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.fillColor(COLOR.muted).font('Helvetica').fontSize(8).text(
      'Generated by Alafia — SterlingRx Advisors',
      PAGE_MARGIN, PAGE_HEIGHT - PAGE_MARGIN - 16, { width: CONTENT_WIDTH, align: 'center' },
    );
  }
}

/**
 * @param {string} pharmacyName
 * @param {Awaited<ReturnType<import('./uploadPipeline').processUpload>>} result
 * @returns {Promise<Buffer>}
 */
function buildSummaryPdf(pharmacyName, result) {
  return new Promise((resolve, reject) => {
    const { rowCount, skippedCount, analytics, metrics, bizHealth, bizInsights } = result;
    const { overview, products } = metrics;

    const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let y = drawHeader(doc, pharmacyName);

    doc.fillColor(COLOR.muted).font('Helvetica').fontSize(8).text(
      `Based on ${rowCount} rows processed${skippedCount > 0 ? ` (${skippedCount} skipped — missing/invalid data)` : ''}.`,
      PAGE_MARGIN, y, { width: CONTENT_WIDTH },
    );
    y += 18;

    y = drawKpiCards(doc, y, overview);
    if (bizHealth) y = drawHealthSection(doc, y, bizHealth);
    if (analytics && analytics.monthlyRevenue) y = drawTrendChart(doc, y, analytics.monthlyRevenue);
    if (products && products.top10) y = drawTopProducts(doc, y, products.top10);
    if (bizInsights) y = drawPriorities(doc, y, bizInsights);

    drawFooter(doc);
    doc.end();
  });
}

module.exports = { buildSummaryPdf };
