/**
 * Short WhatsApp text digest of a processed upload — the PDF has the full
 * detail, this is the "here's what I found" chat reply. Transparently
 * notes skipped rows rather than hiding degraded data, matching this
 * project's established never-hide-limitations pattern.
 */

function fmtNaira(n) {
  if (n == null) return 'N/A';
  return `₦${Number(n).toLocaleString('en-NG', { maximumFractionDigits: 0 })}`;
}

/**
 * @param {Awaited<ReturnType<import('./uploadPipeline').processUpload>>} result
 */
function buildSummaryText(result) {
  const { rowCount, skippedCount, metrics, bizHealth, bizInsights } = result;
  const { overview, products } = metrics;

  const lines = [];
  lines.push(`Processed ${rowCount} rows${skippedCount > 0 ? ` (${skippedCount} skipped — missing/invalid data)` : ''}.`);
  lines.push('');
  lines.push(`Revenue: ${fmtNaira(overview.totalRevenue)}`);
  if (overview.grossProfit != null) {
    lines.push(`Profit: ${fmtNaira(overview.grossProfit)} (${overview.grossMargin != null ? overview.grossMargin + '%' : 'N/A'} margin)`);
  }
  lines.push(`Transactions: ${overview.transactionCount}`);

  if (products.top10 && products.top10.length > 0) {
    lines.push('');
    lines.push(`Top product: ${products.top10[0].name} (${fmtNaira(products.top10[0].revenue)})`);
  }

  if (bizHealth) {
    lines.push('');
    lines.push(`Business health: ${bizHealth.overallScore}/100 (${bizHealth.rating})`);
  }

  if (bizInsights && bizInsights.length > 0) {
    lines.push('');
    lines.push(`Top priority: ${bizInsights[0].observation}`);
    lines.push(bizInsights[0].recommendedAction);
  }

  lines.push('');
  lines.push("I'll send the full one-page summary as a PDF next. Ask me anything about these numbers any time.");

  return lines.join('\n');
}

module.exports = { buildSummaryText, fmtNaira };
