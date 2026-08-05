/**
 * Business Health Data Bridge — computes inventory and customer statistics
 * from the database to feed the Business Health scoring engine.
 *
 * Note: the Postgres schema drops the old "default walk-in customer id=1"
 * convention from the SQLite version — a sale with no named customer now
 * simply has customer_id IS NULL (see db.js's loadFactRecords). Every query
 * below that used to filter `customer_id != 1` now filters
 * `customer_id IS NOT NULL`, which is the more direct way to say the same
 * thing.
 */

const { getSql, assertOrgId } = require('./db');

const roundTo = (n, d = 1) => {
  const m = 10 ** d;
  return Math.round(Number(n) * m) / m;
};

// ---- inventory stats ---------------------------------------------------

/**
 * Has this organization ever uploaded a file carrying real stock or expiry
 * data?
 *
 * The stats below are derived from the product and sale tables, so they
 * compute happily for a pharmacy that only ever uploaded sales — turnover
 * from sales velocity, "dead stock" from products with no sales, near-expiry
 * from the discontinued flag. Those are movement proxies, not inventory, and
 * scoring them as Inventory Health penalises an owner for data they never
 * supplied.
 *
 * dataset_registry is the authoritative record of what each upload actually
 * contained — the same capability flags the dashboard uses to decide which
 * sections to show — so it is the honest source for "is there anything here
 * to assess".
 *
 * Restricted to uploads that actually FINISHED. A file's capabilities are
 * written the moment it is classified, which happens on the first screen of
 * the upload flow — before column mapping, and so before the owner has agreed
 * to ingest anything. Counting those rows meant abandoning a stock file at the
 * mapping step still switched the Inventory pillar on, and it then scored
 * against turnover and dead-stock figures derived from sales alone: a quarter
 * of the health score answering for data the pharmacy never committed. Only
 * 'processed' means the rows are really in the star schema.
 */
async function hasInventoryData(organizationId) {
  assertOrgId(organizationId);
  const db = getSql();
  const rows = await db`
    select capabilities from dataset_registry
    where organization_id = ${organizationId} and processing_status = 'processed'
  `;
  return rows.some((r) => {
    const c = r.capabilities || {};
    return c.inventory === true || c.expiry === true;
  });
}

async function computeInventoryStats(organizationId) {
  assertOrgId(organizationId);
  const db = getSql();

  const [activeRow] = await db`
    select count(distinct product_id) as cnt from sale where organization_id = ${organizationId}
  `;
  const activeProducts = activeRow ? Number(activeRow.cnt) : 0;

  const [totalProductsRow] = await db`
    select count(*) as cnt from product where organization_id = ${organizationId}
  `;
  const totalProducts = Number(totalProductsRow.cnt);

  const [monthRow] = await db`
    select count(distinct c.year || '-' || c.month) as cnt
    from calendar c
    where c.id in (select distinct calendar_id from sale where organization_id = ${organizationId})
  `;
  const totalMonths = monthRow ? Math.max(Number(monthRow.cnt), 1) : 1;

  const turnoverRows = await db`
    select p.id, p.name,
      coalesce(sum(s.quantity), 0) as "unitsSold",
      round((coalesce(sum(s.quantity), 0) / ${totalMonths})::numeric, 2) as "unitsPerMonth",
      coalesce(p.standard_cost, 0) as "standardCost"
    from product p
    left join sale s on s.product_id = p.id and s.organization_id = ${organizationId}
    where p.organization_id = ${organizationId}
    group by p.id, p.name, p.standard_cost
    order by "unitsSold" desc
  `;
  const parsed = turnoverRows.map((r) => ({
    id: r.id,
    name: r.name,
    unitsSold: Number(r.unitsSold),
    unitsPerMonth: Number(r.unitsPerMonth),
    standardCost: Number(r.standardCost),
  }));

  const velocities = parsed
    .filter((r) => r.unitsSold > 0)
    .map((r) => r.unitsPerMonth)
    .sort((a, b) => a - b);

  const medianTurnover = velocities.length > 0 ? velocities[Math.floor(velocities.length / 2)] : 0;

  const deadStockRows = parsed.filter((r) => !r.unitsSold || r.unitsSold === 0);
  const deadStockCount = deadStockRows.length;
  const deadStockPct = totalProducts > 0 ? (deadStockCount / totalProducts) * 100 : 0;

  const now = new Date();
  const ninetyDaysFromNow = new Date(now.getTime() + 90 * 86400000);
  const ninetyStr = ninetyDaysFromNow.toISOString().substring(0, 10);

  const expiryProducts = await db`
    select id, name, is_discontinued, discontinued_date
    from product
    where organization_id = ${organizationId}
      and (is_discontinued = 'Yes'
        or (discontinued_date is not null and discontinued_date <= ${ninetyStr}))
  `;
  const nearExpiryCount = expiryProducts.length;
  const nearExpiryPct = totalProducts > 0 ? (nearExpiryCount / totalProducts) * 100 : 0;

  const salesProducts = parsed.filter((r) => r.unitsSold > 0);
  const fastMoverThreshold = velocities.length > 0 ? velocities[Math.floor(velocities.length * 0.75)] : 0;
  const fastMovers = salesProducts.filter((r) => r.unitsPerMonth >= fastMoverThreshold);
  const lowStockCount = fastMovers.filter((r) => r.standardCost <= 0).length;

  const slowThreshold = velocities.length > 0 ? velocities[Math.floor(velocities.length * 0.25)] : 0;
  const slowMovers = salesProducts.filter((r) => r.unitsPerMonth <= slowThreshold && r.unitsPerMonth > 0);
  const overstockCount = slowMovers.length;
  const overstockPct = activeProducts > 0 ? (overstockCount / activeProducts) * 100 : 0;

  return {
    // Mirrors customerStats.hasCustomerData: the flag the scoring engine
    // checks before deciding whether this pillar can be assessed at all.
    hasInventoryData: await hasInventoryData(organizationId),
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

async function computeCustomerStats(organizationId) {
  assertOrgId(organizationId);
  const db = getSql();

  const [totalRow] = await db`
    select count(*) as cnt from customer where organization_id = ${organizationId}
  `;
  const totalCustomers = totalRow ? Number(totalRow.cnt) : 0;
  if (totalCustomers === 0) return null;

  // Rows existing in `customer` aren't enough on their own — a dataset can
  // have non-walk-in customer *labels* (e.g. channel types like "HMO" or
  // "Clinics" mis-imported as customers) with zero actual sales linked to
  // them. Require at least one real sale row tied to a named customer
  // before treating customer data as meaningful.
  const [activeRow] = await db`
    select count(distinct customer_id) as cnt
    from sale
    where organization_id = ${organizationId} and customer_id is not null
  `;
  const activeCustomers = activeRow ? Number(activeRow.cnt) : 0;
  const hasCustomerData = activeCustomers > 0;

  if (!hasCustomerData) {
    return { hasCustomerData: false };
  }

  const [returningRow] = await db`
    select count(*) as cnt from (
      select customer_id, count(*) as "txCount"
      from sale
      where organization_id = ${organizationId} and customer_id is not null
      group by customer_id
      having count(*) > 1
    ) t
  `;
  const returningCustomers = returningRow ? Number(returningRow.cnt) : 0;

  const repeatCustomerRate = activeCustomers > 0 ? (returningCustomers / activeCustomers) * 100 : 0;

  const monthlyCustomers = await db`
    select c.year || '-' || c.month as "yearMonth",
           count(distinct s.customer_id) as "customerCount"
    from sale s
    join calendar c on s.calendar_id = c.id
    where s.organization_id = ${organizationId} and s.customer_id is not null
    group by c.year, c.month
    order by c.year, c.month
  `;

  let customerGrowthRate = 0;
  if (monthlyCustomers.length >= 2) {
    const growthRates = [];
    for (let i = 1; i < monthlyCustomers.length; i++) {
      const prev = Number(monthlyCustomers[i - 1].customerCount);
      const curr = Number(monthlyCustomers[i].customerCount);
      if (prev > 0) growthRates.push(((curr - prev) / prev) * 100);
    }
    customerGrowthRate = growthRates.length > 0
      ? growthRates.reduce((s, g) => s + g, 0) / growthRates.length
      : 0;
  }

  const [spendRow] = await db`
    select avg("custTotal") as "avgSpend" from (
      select sum(unit_price * quantity) as "custTotal"
      from sale
      where organization_id = ${organizationId} and customer_id is not null
      group by customer_id
    ) t
  `;
  const avgCustomerSpend = spendRow && spendRow.avgSpend ? Math.round(Number(spendRow.avgSpend)) : 0;

  const [freqRow] = await db`
    select avg("txCount") as "avgFreq" from (
      select count(*) as "txCount"
      from sale
      where organization_id = ${organizationId} and customer_id is not null
      group by customer_id
    ) t
  `;
  const avgPurchaseFrequency = freqRow && freqRow.avgFreq ? Math.round(Number(freqRow.avgFreq) * 10) / 10 : 0;

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
async function computeHealthStats(organizationId) {
  const [inventoryStats, customerStats] = await Promise.all([
    computeInventoryStats(organizationId),
    computeCustomerStats(organizationId),
  ]);
  return { inventoryStats, customerStats };
}

module.exports = { computeInventoryStats, computeCustomerStats, computeHealthStats, hasInventoryData };
