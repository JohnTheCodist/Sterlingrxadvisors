/**
 * Category Evidence — real, read-only lookups the Decision Intelligence
 * Engine uses to turn an abstract category signal ("Anti-Malarial demand
 * expected to increase") into pharmacy-specific evidence ("current stock
 * covers only 8 days"). No writes, no schema changes, no business-logic
 * changes to any existing service — pure reads against data that already
 * exists (same non-invasive pattern as weatherDecisionRules.js).
 *
 * Reuses weatherDecisionRules.js's CATEGORY_KEYWORDS and
 * categoryDemandEvidence (both already additively exported) rather than
 * duplicating that matching table a third time.
 */

const { CATEGORY_KEYWORDS, categoryDemandEvidence } = require('../weatherDecisionRules');
const { getSql, assertOrgId } = require('../db');

function categoryWhereFragment(sqlTag, keywords) {
  return keywords
    .map((kw) => `%${kw}%`)
    .map((like) => sqlTag`(p.category ilike ${like} or p.name ilike ${like} or p.resolved_generic ilike ${like})`)
    .reduce((acc, frag) => sqlTag`${acc} or ${frag}`);
}

/**
 * Days of stock remaining for a category, estimated from current stock
 * (uploaded inventory data, if any) divided by recent sales velocity
 * (last 30 days). Returns null — never a guess — when either side of that
 * calculation isn't available.
 */
async function getCategoryCoverageDays(organizationId, category) {
  assertOrgId(organizationId);
  const keywords = CATEGORY_KEYWORDS[category];
  if (!keywords) return null;

  let inventoryRecords = [];
  try {
    inventoryRecords = (await require('../factStore').query(organizationId, 'FactInventory')) || [];
  } catch (_) { inventoryRecords = []; }

  const isMatch = (name, cat) => {
    const haystack = `${name || ''} ${cat || ''}`.toLowerCase();
    return keywords.some((kw) => haystack.includes(kw));
  };

  const stockRows = inventoryRecords.filter((r) => r.current_stock != null && isMatch(r.product_name, r.category));
  if (stockRows.length === 0) return null;
  const totalStock = stockRows.reduce((sum, r) => sum + (Number(r.current_stock) || 0), 0);

  const db = getSql();
  const whereFragment = categoryWhereFragment(db, keywords);
  const [velocityRow] = await db`
    select sum(s.quantity) as qty, count(distinct s.sale_date) as days
    from sale s
    join product p on s.product_id = p.id
    where s.organization_id = ${organizationId}
      and (${whereFragment})
      and s.sale_date >= current_date - interval '30 days'
  `;

  const qty = velocityRow ? Number(velocityRow.qty) : 0;
  const days = velocityRow ? Number(velocityRow.days) : 0;
  if (!qty || !days) return null;
  const dailyVelocity = qty / days;
  if (dailyVelocity <= 0) return null;

  return Math.round(totalStock / dailyVelocity);
}

/**
 * Recent-vs-prior-30-day revenue trend for a category, and the category's
 * current recent-period revenue (used for financial-impact estimates).
 * Returns { available: false, reason } — never a guess — when there isn't
 * enough real sales history to compare.
 */
async function getCategoryTrend(organizationId, category) {
  const keywords = CATEGORY_KEYWORDS[category];
  if (!keywords) return { available: false, reason: `No keyword mapping for category "${category}".` };
  return categoryDemandEvidence(organizationId, keywords, null);
}

module.exports = { getCategoryCoverageDays, getCategoryTrend };
