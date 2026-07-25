/**
 * Business Health Data Bridge — computes inventory and customer statistics
 * from the database to feed the Business Health scoring engine.
 */

const { getDb } = require('./database');

const roundTo = (n, d = 1) => {
  const m = 10 ** d;
  return Math.round(n * m) / m;
};

// ---- inventory stats ---------------------------------------------------

function computeInventoryStats() {
  const db = getDb();

  // Total distinct products that have sales (exclude master-list only products)
  const activeRow = db.prepare('SELECT COUNT(DISTINCT product_id) AS cnt FROM fact_sales').get();
  const activeProducts = activeRow ? activeRow.cnt : 0;

  // Total products in the dimension table
  const totalProducts = db.prepare('SELECT COUNT(*) AS cnt FROM dim_product').get().cnt;

  // Total months of data for turnover calculation
  const monthRow = db.prepare(
    "SELECT COUNT(DISTINCT year || '-' || month) AS cnt FROM dim_calendar WHERE id IN (SELECT DISTINCT calendar_id FROM fact_sales)"
  ).get();
  const totalMonths = monthRow ? Math.max(monthRow.cnt, 1) : 1;

  // Sales per product — compute velocity (units per month)
  const turnoverRows = db.prepare(`
    SELECT p.id, p.name,
      COALESCE(SUM(f.quantity), 0) AS unitsSold,
      ROUND(COALESCE(SUM(f.quantity), 0) * 1.0 / ?, 2) AS unitsPerMonth,
      COALESCE(p.standard_cost, 0) AS standardCost
    FROM dim_product p
    LEFT JOIN fact_sales f ON f.product_id = p.id
    GROUP BY p.id
    ORDER BY unitsSold DESC
  `).all(totalMonths);

  // Median turnover: units per month per product (only products with sales)
  const velocities = turnoverRows
    .filter((r) => r.unitsSold > 0)
    .map((r) => r.unitsPerMonth)
    .sort((a, b) => a - b);

  const medianTurnover = velocities.length > 0
    ? velocities[Math.floor(velocities.length / 2)]
    : 0;

  // Dead stock: products with zero units sold (only meaningful if they're in the active set)
  const deadStockRows = turnoverRows.filter((r) => !r.unitsSold || r.unitsSold === 0);
  const deadStockCount = deadStockRows.length;
  const deadStockPct = totalProducts > 0 ? (deadStockCount / totalProducts) * 100 : 0;

  // Near expiry: products discontinued or approaching discontinuation
  const now = new Date();
  const ninetyDaysFromNow = new Date(now.getTime() + 90 * 86400000);
  const ninetyStr = ninetyDaysFromNow.toISOString().substring(0, 10);

  const expiryProducts = db.prepare(`
    SELECT id, name, is_discontinued, discontinued_date
    FROM dim_product
    WHERE is_discontinued = 1 OR is_discontinued = 'Yes'
       OR (discontinued_date IS NOT NULL AND discontinued_date <= ?)
  `).all(ninetyStr);

  const nearExpiryCount = expiryProducts.length;
  const nearExpiryPct = totalProducts > 0 ? (nearExpiryCount / totalProducts) * 100 : 0;

  // Low stock: fast-moving products (top 25% by velocity) that sold well but might run out
  const salesProducts = turnoverRows.filter((r) => r.unitsSold > 0);
  const fastMoverThreshold = velocities.length > 0
    ? velocities[Math.floor(velocities.length * 0.75)]
    : 0;
  const fastMovers = salesProducts.filter((r) => r.unitsPerMonth >= fastMoverThreshold);
  // Low stock risk: fast movers with low or zero standard_cost (no cost data = potential stock issue)
  const lowStockCount = fastMovers.filter((r) => r.standardCost <= 0).length;

  // Overstock: slow-moving products relative to active products
  const slowThreshold = velocities.length > 0
    ? velocities[Math.floor(velocities.length * 0.25)]
    : 0;
  const slowMovers = salesProducts.filter((r) => r.unitsPerMonth <= slowThreshold && r.unitsPerMonth > 0);
  const overstockCount = slowMovers.length;
  const overstockPct = activeProducts > 0 ? (overstockCount / activeProducts) * 100 : 0;

  return {
    turnoverRatio: roundTo(medianTurnover, 2),
    deadStockCount,
    deadStockPct: roundTo(deadStockPct, 1),
    nearExpiryCount,
    nearExpiryPct: roundTo(nearExpiryPct, 1),
    lowStockCount,
    overstockCount,
    overstockPct: roundTo(overstockPct, 1),
    totalProducts,
    activeProducts,
    totalMonths,
  };
}

// ---- customer stats ----------------------------------------------------

function computeCustomerStats() {
  const db = getDb();

  // Total distinct customers
  const totalRow = db.prepare('SELECT COUNT(*) AS cnt FROM dim_customer').get();
  const totalCustomers = totalRow ? totalRow.cnt : 0;
  if (totalCustomers === 0) return null;

  // Check if customer data is meaningful (more than just walk-in)
  const nonWalkIn = db.prepare(
    "SELECT COUNT(*) AS cnt FROM dim_customer WHERE id != 1"
  ).get();
  const hasCustomerData = nonWalkIn && nonWalkIn.cnt > 0;

  if (!hasCustomerData) {
    return { hasCustomerData: false };
  }

  // Returning customers: customers with >1 transaction
  const returningRow = db.prepare(`
    SELECT COUNT(*) AS cnt FROM (
      SELECT customer_id, COUNT(*) AS txCount
      FROM fact_sales
      WHERE customer_id != 1
      GROUP BY customer_id
      HAVING txCount > 1
    )
  `).get();
  const returningCustomers = returningRow ? returningRow.cnt : 0;

  // Total customers with transactions
  const activeRow = db.prepare(`
    SELECT COUNT(DISTINCT customer_id) AS cnt
    FROM fact_sales
    WHERE customer_id != 1
  `).get();
  const activeCustomers = activeRow ? activeRow.cnt : 0;

  const repeatCustomerRate = activeCustomers > 0
    ? (returningCustomers / activeCustomers) * 100
    : 0;

  // Customer growth: compare distinct customers per month
  const monthlyCustomers = db.prepare(`
    SELECT
      c.year || '-' || c.month AS yearMonth,
      COUNT(DISTINCT f.customer_id) AS customerCount
    FROM fact_sales f
    JOIN dim_calendar c ON f.calendar_id = c.id
    WHERE f.customer_id != 1
    GROUP BY c.year, c.month
    ORDER BY c.year, c.month
  `).all();

  let customerGrowthRate = 0;
  if (monthlyCustomers.length >= 2) {
    const growthRates = [];
    for (let i = 1; i < monthlyCustomers.length; i++) {
      const prev = monthlyCustomers[i - 1].customerCount;
      const curr = monthlyCustomers[i].customerCount;
      if (prev > 0) growthRates.push(((curr - prev) / prev) * 100);
    }
    customerGrowthRate = growthRates.length > 0
      ? growthRates.reduce((s, g) => s + g, 0) / growthRates.length
      : 0;
  }

  // Average customer spend
  const spendRow = db.prepare(`
    SELECT AVG(custTotal) AS avgSpend FROM (
      SELECT SUM(f.unit_price * f.quantity) AS custTotal
      FROM fact_sales f
      WHERE f.customer_id != 1
      GROUP BY f.customer_id
    )
  `).get();
  const avgCustomerSpend = spendRow && spendRow.avgSpend ? Math.round(spendRow.avgSpend) : 0;

  // Average purchase frequency
  const freqRow = db.prepare(`
    SELECT AVG(txCount * 1.0) AS avgFreq FROM (
      SELECT COUNT(*) AS txCount
      FROM fact_sales
      WHERE customer_id != 1
      GROUP BY customer_id
    )
  `).get();
  const avgPurchaseFrequency = freqRow && freqRow.avgFreq ? Math.round(freqRow.avgFreq * 10) / 10 : 0;

  return {
    hasCustomerData: true,
    repeatCustomerRate,
    customerGrowthRate,
    avgCustomerSpend,
    avgPurchaseFrequency,
    totalCustomers: activeCustomers,
    returningCustomers,
    newCustomers: activeCustomers - returningCustomers,
  };
}

// ---- combined bridge ---------------------------------------------------

/**
 * Compute all supplemental stats needed by the Business Health scoring engine.
 */
function computeHealthStats() {
  const inventoryStats = computeInventoryStats();
  const customerStats = computeCustomerStats();

  return { inventoryStats, customerStats };
}

module.exports = { computeInventoryStats, computeCustomerStats, computeHealthStats };
