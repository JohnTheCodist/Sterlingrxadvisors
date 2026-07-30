/**
 * Widget Registry — declarative catalog of every available widget.
 *
 * Each widget declares:
 *   id             — unique identifier
 *   title          — display name
 *   dashboard      — which dashboard this widget belongs to
 *   category       — grouping within the dashboard
 *   priority       — display order (lower = first)
 *   chartType      — how to render it (kpi-card, bar, line, table, pie)
 *   requiredFields — canonical field names that must exist in the data
 *   optionalFields — fields that improve the widget if present
 *   compute(records, fieldIndex) — returns the widget's data payload
 *                                  (or { error: "..." } if requirements unmet)
 *
 * compute() receives:
 *   records    — the full normalized record set
 *   fieldIndex — Map of canonical field → raw header (for future metadata use)
 *
 * ALL widgets delegate to existing analytics functions. No calculations are
 * duplicated.
 */

const analytics = require('./analytics');
const { classifyDrug, detectCategoryField } = require('./drugClassifier');

// ---- widget definitions ----------------------------------------------------

const WIDGETS = [

  // ===== SALES DASHBOARD ====================================================

  {
    id: 'revenue-kpi',
    title: 'Total Revenue',
    description: 'Total sales generated during the selected period before deducting expenses.',
    dashboard: 'sales',
    category: 'KPIs',
    priority: 1,
    chartType: 'kpi-card',
    requiredFields: ['selling_price', 'quantity'],
    optionalFields: [],
    format: 'currency',
    compute(records) {
      const m = analytics.calculateMetrics(records);
      if (m.totalRevenue === 0 && m.transactionCount === 0) {
        return { error: 'No revenue data available' };
      }
      return { value: m.totalRevenue, label: 'Total Revenue', sublabel: `${m.transactionCount} transactions` };
    },
  },

  {
    id: 'profit-kpi',
    title: 'Gross Profit',
    description: 'Revenue minus the cost of goods sold. Shows how much profit was earned before operating expenses.',
    dashboard: 'sales',
    category: 'KPIs',
    priority: 2,
    chartType: 'kpi-card',
    requiredFields: ['selling_price', 'quantity', 'cost_price'],
    optionalFields: [],
    format: 'currency',
    compute(records) {
      const m = analytics.calculateMetrics(records);
      if (m.grossProfit === null) {
        return { error: 'Cost data not available' };
      }
      return { value: m.grossProfit, label: 'Gross Profit', sublabel: m.grossMargin !== null ? `${m.grossMargin}% margin` : `${m.transactionCount} transactions` };
    },
  },

  {
    id: 'margin-kpi',
    title: 'Gross Margin',
    description: 'Gross profit expressed as a percentage of total revenue. Indicates pricing strategy effectiveness.',
    dashboard: 'sales',
    category: 'KPIs',
    priority: 3,
    chartType: 'kpi-card',
    requiredFields: ['selling_price', 'quantity', 'cost_price'],
    optionalFields: [],
    format: 'percentage',
    compute(records) {
      const m = analytics.calculateMetrics(records);
      if (m.grossMargin === null) {
        return { error: 'Cost data not available' };
      }
      return { value: m.grossMargin, label: 'Gross Margin', sublabel: m.totalRevenue > 0 ? `${m.transactionCount} transactions` : null };
    },
  },

  {
    id: 'transactions-kpi',
    title: 'Transaction Count',
    description: 'Total number of sales transactions recorded during the period.',
    dashboard: 'sales',
    category: 'KPIs',
    priority: 4,
    chartType: 'kpi-card',
    requiredFields: ['quantity'],
    optionalFields: ['selling_price'],
    format: 'number',
    compute(records) {
      const m = analytics.calculateMetrics(records);
      const avg = m.averageTransactionValue > 0 ? `Avg ₦${m.averageTransactionValue.toLocaleString()}` : null;
      return { value: m.transactionCount, label: 'Transactions', sublabel: avg };
    },
  },

  {
    id: 'products-sold-kpi',
    title: 'Products Sold',
    description: 'Total quantity of products sold across all transactions.',
    dashboard: 'sales',
    category: 'KPIs',
    priority: 5,
    chartType: 'kpi-card',
    requiredFields: ['quantity'],
    optionalFields: ['selling_price'],
    format: 'number',
    compute(records) {
      const m = analytics.calculateMetrics(records);
      if (m.totalQuantitySold === 0) return { error: 'No quantity data available' };
      const avg = m.averageSellingPrice > 0 ? `Avg ₦${m.averageSellingPrice.toLocaleString()}/unit` : null;
      return { value: m.totalQuantitySold, label: 'Products Sold', sublabel: avg };
    },
  },

  {
    id: 'distinct-products-kpi',
    title: 'Distinct Products',
    description: 'Number of unique products identified after product normalization.',
    dashboard: 'sales',
    category: 'KPIs',
    priority: 6,
    chartType: 'kpi-card',
    requiredFields: ['product_name'],
    optionalFields: [],
    format: 'number',
    compute(records) {
      const names = new Set();
      for (const rec of records) {
        const raw = (rec.product_name || rec.product || '').toString().trim();
        if (!raw) continue;
        const lower = raw.toLowerCase();
        // Exclude generic unknown markers and numeric-only placeholders
        // (e.g. "404", "999", "12345" — common data-corruption artifacts)
        if (lower === 'unknown' || lower === 'n/a' || /^\d+$/.test(lower)) continue;
        names.add(lower);
      }
      const distinct = names.size;
      return { value: distinct, label: 'Distinct Products', sublabel: distinct > 0 ? 'unique SKUs' : null };
    },
  },

  {
    id: 'avg-basket-value',
    title: 'Average Basket Value',
    description: 'How much does a customer spend per visit? Revenue divided by number of transactions.',
    dashboard: 'sales',
    category: 'KPIs',
    priority: 7,
    chartType: 'kpi-card',
    requiredFields: ['selling_price', 'quantity'],
    optionalFields: [],
    format: 'currency',
    compute(records) {
      const m = analytics.calculateMetrics(records);
      if (m.averageTransactionValue === 0 && m.transactionCount === 0) {
        return { error: 'No transaction data available' };
      }
      return {
        value: m.averageTransactionValue,
        label: 'Avg Basket',
        sublabel: `${m.transactionCount} transactions`,
      };
    },
  },

  {
    id: 'avg-items-per-basket',
    title: 'Average Items per Basket',
    description: 'How many items are purchased per visit? Quantity divided by number of transactions.',
    dashboard: 'sales',
    category: 'KPIs',
    priority: 8,
    chartType: 'kpi-card',
    requiredFields: ['quantity'],
    optionalFields: ['selling_price'],
    format: 'number',
    compute(records) {
      let totalQty = 0;
      let txns = 0;
      for (const rec of records) {
        const qty = Number(rec.quantity) || 0;
        if (qty <= 0 || qty > 10000) continue;
        totalQty += qty;
        if (rec.revenue != null && rec.revenue > 0) txns++;
      }
      if (txns === 0 && totalQty > 0) txns = records.length;
      if (txns === 0) {
        return { error: 'No transaction data available' };
      }
      const avg = Math.round((totalQty / txns) * 10) / 10;

      // Knaflic-style: big idea → supporting detail → call to action
      let sublabel;
      if (avg < 1.5) {
        sublabel = `Customers buy 1 item and leave. At ${avg} items/visit, you're missing add-on revenue — place impulse-buy products at checkout and train staff to suggest pairings.`;
      } else if (avg < 3) {
        sublabel = `Basket is growing but not yet compounding. At ${avg} items/visit — surface "frequently bought together" on receipts and test combo pricing to push past 3.`;
      } else {
        sublabel = `Customers are stocking up. At ${avg} items/visit, your basket is healthy — protect it with a loyalty program and shift focus to margin per item.`;
      }

      return {
        value: avg,
        label: 'Items/Basket',
        sublabel,
      };
    },
  },

  {
    id: 'monthly-revenue',
    title: 'Monthly Revenue',
    description: 'Monthly breakdown of total revenue. Useful for identifying seasonal patterns and growth trends.',
    dashboard: 'sales',
    category: 'Trends',
    priority: 7,
    chartType: 'line',
    requiredFields: ['transaction_date', 'selling_price', 'quantity'],
    optionalFields: ['day', 'week'],
    compute(records) {
      const granularity = analytics.detectTimeGranularity(records);
      if (!granularity.day) {
        return { error: 'No date information available' };
      }

      // Build drill levels — only include granularities valid for the data span
      const drillLevels = {};
      try {
        if (granularity.year) {
          const yearData = analytics.yearlyRevenue(records);
          if (yearData.length > 0) drillLevels.year = yearData.map((d) => ({ x: d.year, y: d.revenue }));
        }
        if (granularity.month) {
          const monthData = analytics.monthlyRevenue(records);
          if (monthData.length > 0) drillLevels.month = monthData.map((d) => ({ x: d.month, y: d.revenue }));
        }
        if (granularity.week) {
          const weekData = analytics.weeklyRevenue(records);
          if (weekData.length > 0) drillLevels.week = weekData.map((d) => ({ x: d.week, y: d.revenue }));
        }
        if (granularity.day) {
          const dayData = analytics.dailyRevenue(records);
          if (dayData.length > 0) drillLevels.day = dayData.map((d) => ({ x: d.day, y: d.revenue }));
        }
      } catch (_) { /* drill-down is best-effort */ }

      if (Object.keys(drillLevels).length === 0) {
        return { error: 'No revenue data available for charting' };
      }

      // Choose primary series: prefer finest resolution that's valid
      const levels = Object.keys(drillLevels);
      const primaryLevel = levels.includes('month') ? 'month' : (levels.includes('week') ? 'week' : levels[0]);
      const primaryData = drillLevels[primaryLevel];

      // Insight from primary data
      const peak = primaryData.reduce((best, d) => d.y > (best?.y || 0) ? d : best, null);
      const first = primaryData[0];
      const last = primaryData[primaryData.length - 1];
      let insight = { title: 'Revenue Timeline', subtitle: null };
      if (primaryData.length < 2) {
        insight = { title: 'Single Period', subtitle: `₦${(last?.y || 0).toLocaleString()} in revenue.` };
      } else if ((last?.y || 0) > (first?.y || 0) * 1.1) {
        insight = {
          title: 'Revenue Gaining Momentum',
          subtitle: `Up ~${Math.round(((last.y - first.y) / first.y) * 100)}% from ${first.x} to ${last.x}, with a peak of ₦${peak.y.toLocaleString()} in ${peak.x}.`,
        };
      } else if ((last?.y || 0) < (first?.y || 0) * 0.9) {
        insight = {
          title: 'Top-Line Softening',
          subtitle: `Revenue dipped ~${Math.round(((first.y - last.y) / first.y) * 100)}% from ${first.x}, strongest period was ${peak.x} at ₦${peak.y.toLocaleString()}.`,
        };
      } else {
        insight = {
          title: 'Revenue Holding Steady',
          subtitle: `${primaryLevel === 'month' ? 'Monthly' : 'Daily'} revenue has been consistent, peaking at ₦${peak.y.toLocaleString()} in ${peak.x}.`,
        };
      }

      return {
        series: [{ name: 'Revenue', data: primaryData }],
        drillLevels: levels.length > 1 ? drillLevels : null,
        availableGranularity: granularity,
        displayGranularity: primaryLevel,
        annotation: peak ? { x: peak.x, y: peak.y, label: `Peak: ₦${peak.y.toLocaleString()}` } : null,
        insight,
      };
    },
  },

  {
    id: 'monthly-profit',
    title: 'Monthly Profit',
    description: 'Comparison of revenue versus profit — monthly, weekly, or daily depending on how much date history is available.',
    dashboard: 'sales',
    category: 'Trends',
    priority: 8,
    chartType: 'line',
    requiredFields: ['transaction_date', 'selling_price', 'quantity', 'cost_price'],
    optionalFields: ['day', 'week'],
    compute(records) {
      const granularity = analytics.detectTimeGranularity(records);
      if (!granularity.day) {
        return { error: 'No date information available' };
      }

      const byLevel = {};
      try {
        if (granularity.month) byLevel.month = analytics.monthlyProfit(records);
        if (granularity.week) byLevel.week = analytics.weeklyProfit(records);
        if (granularity.day) byLevel.day = analytics.dailyProfit(records);
      } catch (_) { /* drill-down is best-effort */ }

      const levels = Object.keys(byLevel).filter((k) => byLevel[k].length > 0);
      if (levels.length === 0) {
        return { error: 'No date or cost information available' };
      }
      const hasProfitAnyLevel = levels.some((lvl) => byLevel[lvl].some((d) => d.profit !== null));
      if (!hasProfitAnyLevel) {
        return { error: 'Cost data not available for profit calculation' };
      }

      const primaryLevel = levels.includes('month') ? 'month' : (levels.includes('week') ? 'week' : levels[0]);
      const data = byLevel[primaryLevel];
      const periodKey = primaryLevel; // 'month' | 'week' | 'day' — matches the field name on each row

      const peak = data.reduce((best, d) => (d.profit || 0) > (best?.profit || 0) ? d : best, null);
      const first = data[0];
      const last = data[data.length - 1];
      let insight = { title: 'Revenue vs. Profit', subtitle: `How much we keep after costs — ${primaryLevel}ly trend.` };
      if (data.length >= 2 && (last?.profit || 0) > (first?.profit || 0) * 1.1) {
        insight = {
          title: 'Profit Margin Expanding',
          subtitle: `Profit grew ${Math.round(((last.profit - first.profit) / first.profit) * 100)}% from ${first[periodKey]} to ${last[periodKey]}, ending at ₦${last.profit.toLocaleString()}.`,
        };
      }

      const drillLevels = {};
      for (const lvl of levels) {
        drillLevels[lvl] = byLevel[lvl].map((d) => ({ x: d[lvl], y: d.revenue }));
      }

      return {
        series: [
          { name: 'Revenue', data: data.map((d) => ({ x: d[periodKey], y: d.revenue })) },
          { name: 'Profit', data: data.map((d) => ({ x: d[periodKey], y: d.profit || 0 })) },
        ],
        drillLevels: levels.length > 1 ? drillLevels : null,
        displayGranularity: primaryLevel,
        annotation: peak?.profit ? { x: peak[periodKey], y: peak.profit, label: `Peak profit: ₦${peak.profit.toLocaleString()}` } : null,
        insight,
      };
    },
  },

  {
    id: 'category-revenue-breakdown',
    title: 'Revenue by Category',
    description: 'Revenue distribution across product categories. Highlights which categories drive the most sales.',
    dashboard: 'sales',
    category: 'Breakdown',
    priority: 9,
    chartType: 'bar',
    requiredFields: ['category'],
    optionalFields: [],
    compute(records) {
      const data = analytics.revenueByCategory(records);
      if (data.length === 0) {
        return { error: 'No category data available' };
      }

      const total = data.reduce((s, d) => s + d.revenue, 0);
      if (total <= 0) {
        return { error: 'No revenue data available for categories' };
      }

      // Build share breakdown
      const shares = data
        .map((d) => ({ name: d.category, revenue: d.revenue, share: (d.revenue / total) * 100 }))
        .sort((a, b) => b.share - a.share);

      const top = shares[0];
      const second = shares[1];

      // ---- statistical pattern detection ----------------------------------
      let insight;
      if (shares.length === 1) {
        insight = `${top.name} is the sole revenue category, accounting for 100% of sales.`;
      } else if (top.share >= 60) {
        // Powerhouse: one category dominates
        insight = `${top.name} remains the largest revenue driver, contributing ${Math.round(top.share)}% of total sales — more than all other categories combined.`;
      } else if (shares.length >= 3 && top.share < 40 && second && Math.abs(top.share - second.share) < 12) {
        // Balanced mix: top categories are close
        const top3 = shares.slice(0, 3).map((s) => s.name).join(', ');
        const top3share = Math.round(shares.slice(0, 3).reduce((a, s) => a + s.share, 0));
        insight = `Revenue is distributed across categories — ${top3} together account for ${top3share}% of sales, reducing reliance on any single segment.`;
      } else {
        // Default: top category leads but isn't overwhelmingly dominant
        insight = `${top.name} leads with ${Math.round(top.share)}% of revenue`;
        if (second) {
          insight += `, followed by ${second.name} at ${Math.round(second.share)}%`;
        }
        insight += '.';
      }

      return {
        series: [{ name: 'Revenue', data: data.map((d) => ({ x: d.category, y: d.revenue })) }],
        insight,
      };
    },
  },

  {
    id: 'quantity-trend',
    title: 'Quantity Trend',
    description: 'Trend of units sold — monthly, weekly, or daily depending on how much date history is available.',
    dashboard: 'sales',
    category: 'Trends',
    priority: 10,
    chartType: 'line',
    requiredFields: ['transaction_date', 'quantity'],
    optionalFields: ['day', 'week'],
    compute(records) {
      const granularity = analytics.detectTimeGranularity(records);
      if (!granularity.day) {
        return { error: 'No date information available' };
      }

      const drillLevels = {};
      try {
        if (granularity.month) {
          const monthData = analytics.monthlyQuantity(records);
          if (monthData.length > 0) drillLevels.month = monthData.map((d) => ({ x: d.month, y: d.quantity }));
        }
        if (granularity.week) {
          const weekData = analytics.weeklyQuantity(records);
          if (weekData.length > 0) drillLevels.week = weekData.map((d) => ({ x: d.week, y: d.quantity }));
        }
        if (granularity.day) {
          const dayData = analytics.dailyQuantity(records);
          if (dayData.length > 0) drillLevels.day = dayData.map((d) => ({ x: d.day, y: d.quantity }));
        }
      } catch (_) { /* drill-down is best-effort */ }

      if (Object.keys(drillLevels).length === 0) {
        return { error: 'No date or quantity data available' };
      }

      const levels = Object.keys(drillLevels);
      const primaryLevel = levels.includes('month') ? 'month' : (levels.includes('week') ? 'week' : levels[0]);
      const data = drillLevels[primaryLevel];
      const periodLabel = primaryLevel === 'month' ? 'Monthly' : primaryLevel === 'week' ? 'Weekly' : 'Daily';

      const peak = data.reduce((best, d) => d.y > (best?.y || 0) ? d : best, null);
      const first = data[0];
      const last = data[data.length - 1];

      // Pattern detection for insight
      let insight = { title: 'Quantity Trend', subtitle: null };
      if (data.length < 2) {
        insight = { title: 'Single Period', subtitle: `${peak.y.toLocaleString()} units moved in ${peak.x}` };
      } else if (last.y > first.y * 1.15) {
        insight = {
          title: 'Volume on the Rise',
          subtitle: `Units shipped climbed ${Math.round(((last.y - first.y) / first.y) * 100)}% from ${first.x} to ${last.x}, ending at ${last.y.toLocaleString()} units.`,
        };
      } else if (last.y < first.y * 0.85) {
        insight = {
          title: 'Shipments Softening',
          subtitle: `${periodLabel} volume declined ${Math.round(((first.y - last.y) / first.y) * 100)}% from ${first.x}, with a peak of ${peak.y.toLocaleString()} units in ${peak.x}.`,
        };
      } else {
        insight = {
          title: 'Volume Holding Steady',
          subtitle: `${periodLabel} units have been consistent around ${Math.round(data.reduce((s, d) => s + d.y, 0) / data.length).toLocaleString()}, peaking at ${peak.y.toLocaleString()} in ${peak.x}.`,
        };
      }

      return {
        series: [{ name: 'Units', data }],
        drillLevels: levels.length > 1 ? drillLevels : null,
        displayGranularity: primaryLevel,
        annotation: peak ? { x: peak.x, y: peak.y, label: `Peak: ${peak.y.toLocaleString()} units` } : null,
        insight,
      };
    },
  },

  {
    id: 'profit-trend',
    title: 'Profit Trend',
    description: 'Profit trend showing how much was earned after costs — monthly, weekly, or daily depending on how much date history is available.',
    dashboard: 'sales',
    category: 'Trends',
    priority: 11,
    chartType: 'line',
    requiredFields: ['transaction_date', 'selling_price', 'quantity', 'cost_price'],
    optionalFields: ['day', 'week'],
    compute(records) {
      const granularity = analytics.detectTimeGranularity(records);
      if (!granularity.day) {
        return { error: 'No date information available' };
      }

      const byLevel = {};
      try {
        if (granularity.month) byLevel.month = analytics.monthlyProfit(records);
        if (granularity.week) byLevel.week = analytics.weeklyProfit(records);
        if (granularity.day) byLevel.day = analytics.dailyProfit(records);
      } catch (_) { /* drill-down is best-effort */ }

      const levels = Object.keys(byLevel).filter((k) => byLevel[k].length > 0);
      if (levels.length === 0) {
        return { error: 'No date or cost data available' };
      }
      const hasProfitAnyLevel = levels.some((lvl) => byLevel[lvl].some((d) => d.profit !== null));
      if (!hasProfitAnyLevel) {
        return { error: 'Cost data not available for profit trend' };
      }

      const primaryLevel = levels.includes('month') ? 'month' : (levels.includes('week') ? 'week' : levels[0]);
      const data = byLevel[primaryLevel];
      const periodKey = primaryLevel;
      const periodLabel = primaryLevel === 'month' ? 'Monthly' : primaryLevel === 'week' ? 'Weekly' : 'Daily';

      const first = data[0];
      const last = data[data.length - 1];
      let peak = data.reduce((best, d) => (d.profit || 0) > (best?.profit || 0) ? d : best, null);
      if (!peak || !peak.profit) {
        const bestRev = data.reduce((best, d) => d.revenue > (best?.revenue || 0) ? d : best, null);
        peak = bestRev;
      }

      let insight = { title: 'Profit Trend', subtitle: null };
      if (data.length < 2) {
        insight = {
          title: 'Single Period',
          subtitle: `Profit of ₦${(last.profit || 0).toLocaleString()} recorded in ${last[periodKey]}.`,
        };
      } else if ((last.profit || 0) > (first.profit || 0) * 1.15) {
        insight = {
          title: 'Profit on the Rise',
          subtitle: `Bottom-line growth of ${Math.round(((last.profit - first.profit) / first.profit) * 100)}% from ${first[periodKey]} to ${last[periodKey]}, reaching ₦${last.profit.toLocaleString()}.`,
        };
      } else if ((last.profit || 0) < (first.profit || 0) * 0.85) {
        insight = {
          title: 'Margin Under Pressure',
          subtitle: `Profit fell ${Math.round(((first.profit - last.profit) / first.profit) * 100)}% from ${first[periodKey]}, with the strongest period at ₦${(peak.profit || peak.revenue).toLocaleString()} in ${peak[periodKey]}.`,
        };
      } else {
        insight = {
          title: 'Profit Holding Steady',
          subtitle: `${periodLabel} profit has been stable around ₦${Math.round(data.reduce((s, d) => s + (d.profit || 0), 0) / data.length).toLocaleString()}, peaking at ₦${(peak.profit || peak.revenue).toLocaleString()} in ${peak[periodKey]}.`,
        };
      }

      const drillLevels = {};
      for (const lvl of levels) {
        drillLevels[lvl] = byLevel[lvl].map((d) => ({ x: d[lvl], y: d.profit || 0 }));
      }

      return {
        series: [{ name: 'Profit', data: data.map((d) => ({ x: d[periodKey], y: d.profit || 0 })) }],
        drillLevels: levels.length > 1 ? drillLevels : null,
        displayGranularity: primaryLevel,
        annotation: peak ? { x: peak[periodKey], y: peak.profit || peak.revenue, label: `Peak profit: ₦${(peak.profit || peak.revenue).toLocaleString()}` } : null,
        insight,
      };
    },
  },

  {
    id: 'daily-sales-performance',
    title: 'Daily Sales Performance',
    description: 'Which days generate the most revenue?',
    dashboard: 'sales',
    category: 'Trends',
    priority: 9,
    chartType: 'bar',
    requiredFields: ['transaction_date', 'selling_price', 'quantity'],
    optionalFields: ['day'],
    compute(records) {
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

      // Aggregate revenue by day-of-week (all Mondays summed, all Tuesdays summed, etc.)
      const dowMap = {};
      let totalRecords = 0;
      for (const rec of records) {
        const date = rec.transaction_date;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date).trim())) continue;
        const parts = String(date).trim().split('-').map(Number);
        if (parts.length !== 3) continue;
        const dt = new Date(parts[0], parts[1] - 1, parts[2]);
        if (isNaN(dt.getTime())) continue;
        const dow = dt.getDay(); // 0=Sunday, 6=Saturday
        const rev = rec.revenue != null ? rec.revenue : (rec.selling_price || 0) * (rec.quantity || 0);
        if (!dowMap[dow]) {
          dowMap[dow] = { revenue: 0, transactions: 0 };
        }
        dowMap[dow].revenue += rev;
        dowMap[dow].transactions++;
        totalRecords++;
      }

      if (totalRecords === 0) {
        return { error: 'Daily Sales Performance cannot be calculated because date or revenue information is unavailable.' };
      }

      // Build chart data ordered Sunday→Saturday
      const chartData = dayNames.map((name, i) => ({
        label: name,
        value: Math.round((dowMap[i]?.revenue || 0) * 100) / 100,
        transactions: dowMap[i]?.transactions || 0,
      }));

      // Find highest-revenue weekday
      let highestIdx = 0;
      for (let i = 1; i < 7; i++) {
        if (chartData[i].value > chartData[highestIdx].value) highestIdx = i;
      }
      const busiestDay = dayNames[highestIdx];
      const busiestRevenue = chartData[highestIdx].value;
      const totalRevenue = chartData.reduce((s, d) => s + d.value, 0);
      const busiestShare = totalRevenue > 0 ? Math.round((busiestRevenue / totalRevenue) * 100) : 0;

      const insight = {
        title: 'Allocate staff and promotions to busy days',
        subtitle: `Allocate more staff on ${busiestDay} — ₦${Math.round(busiestRevenue).toLocaleString()} (${busiestShare}%) of weekly revenue.`,
      };

      return {
        data: chartData,
        busiestDay,
        busiestRevenue,
        busiestShare,
        dowTotals: chartData,
        insight,
      };
    },
  },

  {
    id: 'monthly-sales-performance',
    title: 'Sales Performance',
    description: 'Comprehensive sales analysis — monthly, weekly, or daily depending on how much date history is available. Identifies strongest and weakest periods, seasonal patterns, and growth direction.',
    dashboard: 'sales',
    category: 'Trends',
    priority: 9,
    chartType: 'bar',
    requiredFields: ['transaction_date', 'selling_price', 'quantity'],
    optionalFields: ['day', 'week', 'cost_price'],
    compute(records) {
      const granularity = analytics.detectTimeGranularity(records);
      if (!granularity.day) {
        return { error: 'No date information available' };
      }

      // Build each available granularity with a display-friendly name
      const byLevel = {};
      if (granularity.month) {
        const monthData = analytics.monthlyRevenue(records);
        if (monthData.length > 0) byLevel.month = monthData.map((d) => ({
          period: d.month,
          revenue: d.revenue,
          name: `${d.month.split('-')[0]}/${d.month.split('-')[1].padStart(2, '0')}`,
        }));
      }
      if (granularity.week) {
        const weekData = analytics.weeklyRevenue(records);
        if (weekData.length > 0) byLevel.week = weekData.map((d) => ({ period: d.week, revenue: d.revenue, name: d.week }));
      }
      if (granularity.day) {
        const dayData = analytics.dailyRevenue(records);
        if (dayData.length > 0) byLevel.day = dayData.map((d) => ({
          period: d.day,
          revenue: d.revenue,
          name: `${d.day.split('-')[1]}/${d.day.split('-')[2]}`,
        }));
      }

      // Prefer the coarsest granularity with enough periods to be meaningful
      // (month → week → day), falling back to a finer level automatically
      // when the dataset's date span is too short for months.
      const order = ['month', 'week', 'day'];
      const primaryLevel = order.find((lvl) => byLevel[lvl] && byLevel[lvl].length >= 3);
      if (!primaryLevel) {
        return {
          error: 'At least three periods of sales history (month, week, or day) are required to analyse sales performance.',
        };
      }

      const sorted = [...byLevel[primaryLevel]].sort((a, b) => a.period.localeCompare(b.period));
      const periodLabel = primaryLevel === 'month' ? 'month' : primaryLevel === 'week' ? 'week' : 'day';
      const periodLabelCap = primaryLevel === 'month' ? 'Monthly' : primaryLevel === 'week' ? 'Weekly' : 'Daily';

      // Find highest, lowest, average
      const highest = sorted.reduce((best, d) => (d.revenue > (best ? best.revenue : 0) ? d : best), null);
      const lowest = sorted.reduce((worst, d) => (d.revenue < (worst ? worst.revenue : Number.MAX_VALUE) ? d : worst), null);
      const average = Math.round(sorted.reduce((a, d) => a + d.revenue, 0) / sorted.length);

      // Calculate current trend (last period vs first period)
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const growthPct = (last.revenue - first.revenue) / (first.revenue || 1) * 100;

      let trendText = 'Stable';
      let trendDirection = null;
      if (growthPct > 5) {
        trendText = 'Growing';
        trendDirection = 'up';
      } else if (growthPct < -5) {
        trendText = 'Declining';
        trendDirection = 'down';
      }

      // Pattern detection for dynamic title
      const last3 = sorted.slice(-3).map((d) => d.revenue);
      const isIncreasing = last3.every((v, i) => i === 0 || v >= last3[i - 1] * 0.9);

      let title;
      if (isIncreasing && growthPct > 0) {
        title = `Sales have steadily improved over the past ${sorted.length} ${periodLabel}s.`;
      } else if (!isIncreasing && growthPct < 0) {
        title = `${periodLabelCap} sales have weakened since ${first.name}.`;
      } else if (primaryLevel === 'month' && (highest.period.endsWith('-12') || highest.period.endsWith('-11'))) {
        title = 'Sales consistently peak towards the end of the year.';
      } else if (primaryLevel === 'month' && ['-06', '-07', '-08'].some((m) => highest.period.endsWith(m))) {
        title = `Sales consistently peak during the ${highest.name} period.`;
      } else if (Math.abs(growthPct) < 5) {
        title = `${periodLabelCap} sales remained relatively stable throughout the ${first.name} to ${last.name} period.`;
      } else {
        title = `${periodLabelCap} sales showed volatility from ${first.name} to ${last.name}.`;
      }

      const subtitle = 'Identify your strongest and weakest trading periods to improve inventory planning and cash-flow forecasting.';

      const businessInterpretation = `The ${highest.name} ${periodLabel} recorded the strongest performance at ₦${highest.revenue.toLocaleString()}, while ${lowest.name} was weakest at ₦${lowest.revenue.toLocaleString()}. ${
        trendText === 'Growing'
          ? 'Revenue has been trending upward — plan inventory to support continued demand.'
          : trendText === 'Declining'
            ? 'Revenue has been trending downward — investigate what changed around the weaker periods.'
            : 'Revenue has been broadly stable across the period, suggesting predictable demand.'
      }`;

      const decisionSupport = trendText === 'Growing'
        ? `Use strong ${periodLabel}s like ${highest.name} to build cash reserves and negotiate better supplier terms ahead of demand spikes.`
        : trendText === 'Declining'
          ? `Review promotional activity and stock availability around ${lowest.name} — consider a targeted campaign to rebuild volume.`
          : `Increase stock purchases ahead of historically strong periods like ${highest.name}, and review promotions during slower periods like ${lowest.name}.`;

      // Build drill levels from every granularity that qualified — the
      // toggle can switch even if a level has fewer than 3 points.
      const drillLevels = {};
      for (const lvl of Object.keys(byLevel)) {
        if (byLevel[lvl].length > 0) drillLevels[lvl] = byLevel[lvl];
      }

      return {
        highestMonth: { name: highest.name, revenue: highest.revenue },
        lowestMonth: { name: lowest.name, revenue: lowest.revenue },
        averageMonthlyRevenue: average,
        trend: trendText,
        direction: trendDirection,
        title,
        subtitle,
        businessInterpretation,
        decisionSupport,
        series: [{ name: 'Revenue', data: sorted }],
        data: sorted,
        drillLevels: Object.keys(drillLevels).length > 1 ? drillLevels : null,
        displayGranularity: primaryLevel,
      };
    },
  },

  {
    id: 'sales-growth-rate',
    title: 'Sales Growth Rate',
    description: 'Percentage change in revenue between periods — monthly, weekly, or daily depending on how much date history is available.',
    dashboard: 'sales',
    category: 'Trends',
    priority: 10,
    chartType: 'line',
    requiredFields: ['transaction_date', 'selling_price', 'quantity'],
    optionalFields: ['cost_price', 'day', 'week'],
    compute(records) {
      const granularity = analytics.detectTimeGranularity(records);
      if (!granularity.day) {
        return { error: 'No date information available' };
      }

      const byLevel = {};
      if (granularity.month) byLevel.month = analytics.monthlyRevenue(records);
      if (granularity.week) byLevel.week = analytics.weeklyRevenue(records);
      if (granularity.day) byLevel.day = analytics.dailyRevenue(records);

      const order = ['month', 'week', 'day'];
      const primaryLevel = order.find((lvl) => byLevel[lvl] && byLevel[lvl].length >= 2);
      if (!primaryLevel) {
        return {
          error: 'At least two periods of sales history (month, week, or day) are required to calculate the Sales Growth Rate.',
        };
      }

      // Compute a full growth-rate summary for one granularity level.
      function summarize(levelData, lvl) {
        const periodLabel = lvl === 'month' ? 'month' : lvl === 'week' ? 'week' : 'day';
        const growthSeries = [];
        for (let i = 1; i < levelData.length; i++) {
          const curr = levelData[i].revenue || 0;
          const prev = levelData[i - 1].revenue || 0;
          if (prev > 0) {
            growthSeries.push({ x: levelData[i][lvl], y: Math.round(((curr - prev) / prev) * 100 * 10) / 10 });
          }
        }
        if (growthSeries.length === 0) return null;

        const latest = growthSeries[growthSeries.length - 1];
        const classification = latest.y > 10 ? 'Growing' : (latest.y >= -5 && latest.y <= 10 ? 'Stable' : 'Declining');
        const supportingInsight = latest.y > 10
          ? `Revenue increased by ${latest.y}% compared with the previous ${periodLabel}.`
          : latest.y < -5
            ? `Revenue declined by ${latest.y}% compared with the previous ${periodLabel}.`
            : `Revenue remained relatively stable ${periodLabel}-over-${periodLabel}.`;
        const decisionSupport = classification === 'Growing'
          ? 'Sales are growing at a healthy pace. Ensure inventory levels can support increasing demand.'
          : classification === 'Stable'
            ? 'Sales are relatively stable. Focus on improving profitability and customer retention rather than pursuing aggressive growth.'
            : 'Sales are declining. Investigate whether fewer customer transactions, lower basket values, or reduced product availability are contributing to the slowdown.';

        return {
          growth: latest.y,
          growthClassification: classification,
          supportingInsight,
          decisionSupport,
          sublabel: `vs Previous ${periodLabel.charAt(0).toUpperCase() + periodLabel.slice(1)}`,
          series: growthSeries,
        };
      }

      const levelSummaries = {};
      for (const lvl of order) {
        if (!byLevel[lvl] || byLevel[lvl].length < 2) continue;
        const s = summarize(byLevel[lvl], lvl);
        if (s) levelSummaries[lvl] = s;
      }

      const primary = levelSummaries[primaryLevel];
      if (!primary) {
        return { error: 'Sales Growth Rate cannot be calculated because revenue information is unavailable.' };
      }

      return {
        ...primary,
        trend: primary.growthClassification,
        currentGrowthRate: primary.growth,
        displayGranularity: primaryLevel,
        // Per-level summaries (growth/classification/insight/decisionSupport/series each)
        // — GrowthRateWidget.jsx's toggle swaps between these directly.
        drillLevels: Object.keys(levelSummaries).length > 1 ? levelSummaries : null,
      };
    },
  },

  {
    id: 'transaction-trend',
    title: 'Transaction Trend',
    description: 'Are customer visits increasing or decreasing? Transaction count over time — monthly, weekly, or daily depending on how much date history is available.',
    dashboard: 'sales',
    category: 'Trends',
    priority: 11,
    chartType: 'line',
    requiredFields: ['transaction_date'],
    optionalFields: ['day', 'week'],
    compute(records) {
      const granularity = analytics.detectTimeGranularity(records);
      if (!granularity.day) {
        return { error: 'No date information available' };
      }

      const byLevel = {};
      if (granularity.month) byLevel.month = analytics.monthlyTransactionCount(records);
      if (granularity.week) byLevel.week = analytics.weeklyTransactionCount(records);
      if (granularity.day) byLevel.day = analytics.dailyTransactionCount(records);

      const order = ['month', 'week', 'day'];
      const primaryLevel = order.find((lvl) => byLevel[lvl] && byLevel[lvl].length >= 2);
      if (!primaryLevel) {
        return {
          error: 'At least two periods of transaction history (month, week, or day) are required to show a trend.',
        };
      }

      const data = byLevel[primaryLevel].map((d) => ({ period: d[primaryLevel], transactions: d.count }));
      const periodLabel = primaryLevel === 'month' ? 'months' : primaryLevel === 'week' ? 'weeks' : 'days';

      // Trend analysis — Knaflic: big idea → data → call to action
      const first = data[0];
      const last = data[data.length - 1];
      const changePct = first.transactions > 0
        ? Math.round(((last.transactions - first.transactions) / first.transactions) * 100)
        : 0;

      let trendDirection, insight, callToAction;
      if (changePct > 10) {
        trendDirection = 'Growing';
        insight = `Customer visits are up ${changePct}% — demand is accelerating across ${data.length} ${periodLabel}.`;
        callToAction = 'Ensure staffing and inventory scale with rising demand. Use this data to negotiate better supplier terms before peak seasons hit.';
      } else if (changePct > 0) {
        trendDirection = 'Stable to Growing';
        insight = `Customer visits are trending up slightly (+${changePct}%) — demand is steady with room to accelerate.`;
        callToAction = 'Run targeted promotions during slower periods to smooth the demand curve and build visit frequency.';
      } else if (changePct > -10) {
        trendDirection = 'Stable';
        insight = `Customer visits are stable (${changePct}% change) — demand is predictable across ${data.length} ${periodLabel}.`;
        callToAction = 'Shift focus from acquisition to retention. Introduce a loyalty card or subscription to deepen existing customer relationships.';
      } else {
        trendDirection = 'Declining';
        insight = `Customer visits are down ${Math.abs(changePct)}% — fewer people are walking through the door.`;
        callToAction = 'Investigate root causes: are competitors undercutting prices? Is foot traffic declining? Consider community outreach or free health checks to rebuild traffic.';
      }

      // Find peak and trough periods for context
      let peak = data[0];
      let trough = data[0];
      for (const d of data) {
        if (d.transactions > peak.transactions) peak = d;
        if (d.transactions < trough.transactions) trough = d;
      }

      const drillLevels = {};
      for (const lvl of order) {
        if (!byLevel[lvl] || byLevel[lvl].length === 0) continue;
        drillLevels[lvl] = byLevel[lvl].map((d) => ({ x: d[lvl], y: d.count }));
      }

      return {
        insight: {
          title: `Visit Trend: ${trendDirection}`,
          subtitle: `${insight} ${callToAction}`,
        },
        series: [{ name: 'Transactions', data: data.map((d) => ({ x: d.period, y: d.transactions })) }],
        drillLevels: Object.keys(drillLevels).length > 1 ? drillLevels : null,
        displayGranularity: primaryLevel,
        trend: trendDirection,
        changePct,
        peak: { month: peak.period, transactions: peak.transactions },
        trough: { month: trough.period, transactions: trough.transactions },
      };
    },
  },

  {
    id: 'top-products',
    title: 'Top Products',
    description: 'Highest-revenue products ranked by total sales. Identifies your best-performing products.',
    dashboard: 'sales',
    category: 'Products',
    priority: 12,
    chartType: 'table',
    requiredFields: ['product_name', 'selling_price', 'quantity'],
    optionalFields: ['cost_price'],
    compute(records) {
      const products = analytics.topProducts(records, 10);
      if (products.length === 0) {
        return { error: 'No product data available' };
      }
      const hasCost = products.some((p) => p.margin !== null);

      // ---- pattern detection for insight ------------------------------
      const totalRevenue = products.reduce((s, p) => s + (p.revenue || 0), 0);
      const top = products[0];
      const topShare = totalRevenue > 0 ? (top.revenue / totalRevenue) * 100 : 0;

      // Find volume leader (may differ from revenue leader)
      let volumeLeader = products[0];
      for (const p of products) {
        if ((p.quantity || 0) > (volumeLeader.quantity || 0)) volumeLeader = p;
      }

      let insightTitle = 'Top Products';
      let insightSub;

      if (products.length === 1) {
        insightTitle = 'Sole Product';
        insightSub = `${top.name} is the only product in this dataset — all revenue comes from a single SKU.`;
      } else if (topShare >= 65) {
        insightTitle = `${top.name} Dominates Revenue`;
        insightSub = `The #1 product alone accounts for ${Math.round(topShare)}% of total sales, outperforming all other products combined.`;
      } else if (products.length >= 2) {
        const top3share = Math.round(products.slice(0, 3).reduce((a, p) => a + (p.revenue / totalRevenue) * 100, 0));
        if (volumeLeader.name !== top.name) {
          insightTitle = 'Volume vs. Value Split';
          insightSub = `${volumeLeader.name} leads in units sold, but ${top.name} generates the most revenue — a higher-value mix.`;
        } else if (top3share >= 70 && products.length >= 4) {
          insightTitle = 'Pareto Concentration';
          insightSub = `The top 3 products drive ${top3share}% of revenue — success is concentrated in a few key SKUs.`;
        } else {
          insightTitle = `${top.name} Leads the Pack`;
          insightSub = `The top product holds ${Math.round(topShare)}% of revenue across ${products.length} SKUs.`;
        }
      } else {
        insightTitle = `${top.name} on Top`;
        insightSub = `Leading with ${Math.round(topShare)}% of revenue among ${products.length} products.`;
      }

      return {
        columns: hasCost
          ? ['Product', 'Revenue', 'Quantity', 'Profit', 'Margin']
          : ['Product', 'Revenue', 'Quantity'],
        rows: products.map((p) =>
          hasCost
            ? [p.name, p.revenue, p.quantity, p.profit, `${p.margin}%`]
            : [p.name, p.revenue, p.quantity]
        ),
        insight: { title: insightTitle, subtitle: insightSub },
      };
    },
  },

  {
    id: 'top-revenue-products',
    title: 'Top Revenue Products',
    description: 'Which products generate the most revenue?',
    dashboard: 'sales',
    category: 'Products',
    priority: 13,
    chartType: 'hbar',
    format: 'currency',
    requiredFields: ['product_name', 'selling_price', 'quantity'],
    optionalFields: ['cost_price'],
    compute(records) {
      const products = analytics.topProducts(records, 20);
      if (products.length === 0) {
        return { error: 'No product data available' };
      }

      const totalRevenue = products.reduce((s, p) => s + (p.revenue || 0), 0);
      const topN = Math.min(7, products.length);
      const top = products[0];
      const topShare = totalRevenue > 0 ? Math.round((top.revenue / totalRevenue) * 100) : 0;

      // How many products to highlight (matching insight reference)
      let highlightCount = 1; // at least the top product
      if (topShare < 15) highlightCount = 3; // mention top 3 when no single leader

      let insight = {
        title: 'Prioritize shelf space and purchasing',
        subtitle: `${top.name} leads revenue at ₦${Math.round(top.revenue).toLocaleString()} (${topShare}% of total). Stock these top performers prominently.`,
      };

      return {
        data: products.slice(0, topN).map((p) => ({
          label: p.name,
          value: Math.round(p.revenue),
        })),
        highlightCount,
        totalProducts: products.length,
        topProduct: { name: top.name, revenue: top.revenue, share: topShare },
        insight,
      };
    },
  },

  {
    id: 'top-volume-products',
    title: 'Top Volume Products',
    description: 'Which products sell the highest quantity?',
    dashboard: 'sales',
    category: 'Products',
    priority: 14,
    chartType: 'hbar',
    format: 'number',
    requiredFields: ['product_name', 'quantity'],
    optionalFields: ['selling_price'],
    compute(records) {
      const products = analytics.topProducts(records, 50); // fetch enough to re-rank by qty
      if (products.length === 0) {
        return { error: 'No product data available' };
      }

      // Re-rank by quantity instead of revenue
      const topN = Math.min(7, products.length);
      const byQty = [...products].sort((a, b) => b.quantity - a.quantity).slice(0, topN);
      const totalQty = byQty.reduce((s, p) => s + p.quantity, 0);
      const top = byQty[0];
      const topShare = totalQty > 0 ? Math.round((top.quantity / totalQty) * 100) : 0;

      let highlightCount = 1;
      if (topShare < 15) highlightCount = 3;

      const insight = {
        title: 'Identify fast-moving products',
        subtitle: `${top.name} moves the most units at ${top.quantity.toLocaleString()} sold (${topShare}% of top ${topN} volume). Prioritize restocking these items.`,
      };

      return {
        data: byQty.map((p) => ({
          label: p.name,
          value: Math.round(p.quantity),
        })),
        highlightCount,
        topProduct: { name: top.name, quantity: top.quantity, share: topShare },
        insight,
      };
    },
  },

  {
    id: 'product-revenue-concentration',
    title: 'Product Revenue Contribution',
    description: 'Is revenue concentrated in a few products?',
    dashboard: 'sales',
    category: 'Products',
    priority: 15,
    chartType: 'pareto',
    requiredFields: ['product_name', 'selling_price', 'quantity'],
    optionalFields: ['cost_price'],
    compute(records) {
      const products = analytics.topProducts(records, 20);
      if (products.length === 0) {
        return { error: 'No product data available' };
      }

      const totalRevenue = products.reduce((s, p) => s + (p.revenue || 0), 0);
      if (totalRevenue <= 0) {
        return { error: 'No revenue data available' };
      }

      // Compute cumulative share for Pareto
      let cumulative = 0;
      const data = products.map((p) => {
        const share = (p.revenue / totalRevenue) * 100;
        cumulative += share;
        return {
          label: p.name.length > 18 ? p.name.substring(0, 17) + '...' : p.name,
          value: Math.round(p.revenue),
          share: Math.round(share * 10) / 10,
          cumulative: Math.round(cumulative * 10) / 10,
        };
      });

      // How many products account for 80% of revenue?
      let productsFor80 = 0;
      for (const d of data) {
        productsFor80++;
        if (d.cumulative >= 80) break;
      }

      const concentrationPct = Math.round((productsFor80 / data.length) * 100);
      const insight = {
        title: 'Reduce dependence on a small number of products',
        subtitle: `${productsFor80} of ${data.length} products (${concentrationPct}%) drive 80% of revenue. Diversify your product mix to reduce risk.`,
      };

      return {
        data,
        totalRevenue,
        productsFor80,
        totalProducts: data.length,
        concentrationPct,
        insight,
      };
    },
  },

  {
    id: 'product-mix-analysis',
    title: 'Product Mix Analysis',
    description: 'What percentage of revenue comes from each product?',
    dashboard: 'sales',
    category: 'Products',
    priority: 16,
    chartType: 'treemap',
    requiredFields: ['product_name', 'selling_price', 'quantity'],
    optionalFields: ['cost_price'],
    compute(records) {
      const products = analytics.topProducts(records, 30);
      if (products.length === 0) {
        return { error: 'No product data available' };
      }

      const totalRevenue = products.reduce((s, p) => s + (p.revenue || 0), 0);
      if (totalRevenue <= 0) {
        return { error: 'No revenue data available' };
      }

      // Treemap data: { name, size } per product
      const data = products.map((p) => {
        const share = (p.revenue / totalRevenue) * 100;
        return {
          name: p.name,
          size: Math.round(p.revenue),
          share: Math.round(share * 10) / 10,
        };
      });

      // Knaflic-principled insight: big idea → supporting detail → call to action
      const top3Share = data.slice(0, 3).reduce((s, p) => s + p.share, 0);
      const top1 = data[0];
      const insight = {
        title: `${Math.round(top3Share)}% of your revenue comes from just 3 products`,
        subtitle: `${top1.name} alone drives ${top1.share}% of total revenue (₦${Math.round(top1.size).toLocaleString()}). Understanding your product mix helps you make strategic decisions about pricing, promotion, and inventory investment.`,
      };

      return {
        data,
        totalRevenue: Math.round(totalRevenue),
        topProduct: { name: top1.name, share: top1.share, revenue: top1.size },
        top3Share: Math.round(top3Share),
        insight,
      };
    },
  },

  {
    id: 'gross-profit-by-product',
    title: 'Gross Profit by Product',
    description: 'Which products generate the highest profit?',
    dashboard: 'sales',
    category: 'Products',
    priority: 17,
    chartType: 'hbar',
    format: 'currency',
    requiredFields: ['product_name', 'selling_price', 'quantity', 'cost_price'],
    compute(records) {
      const products = analytics.topProducts(records, 50);
      const withProfitAll = products.filter((p) => p.profit != null);

      if (withProfitAll.length === 0) {
        return { error: 'Profit data unavailable. Upload a file with cost price information.' };
      }

      // A handful of products carrying cost data can't rank "highest profit"
      // across the catalog — below this floor the ranking would reflect
      // which few products happened to have cost entered, not which
      // products actually make the most.
      const totalRevenueAll = products.reduce((s, p) => s + (p.revenue || 0), 0);
      const revenueWithCost = withProfitAll.reduce((s, p) => s + (p.revenue || 0), 0);
      const coverageProductsPct = Math.round((withProfitAll.length / products.length) * 1000) / 10;
      const coverageRevenuePct = totalRevenueAll > 0 ? Math.round((revenueWithCost / totalRevenueAll) * 1000) / 10 : 0;

      if (coverageProductsPct < 20 || coverageRevenuePct < 20) {
        return {
          error: `Cost price is only available for ${withProfitAll.length} of ${products.length} products (${coverageRevenuePct}% of revenue) — not enough to reliably rank profit by product. Upload cost prices for more products.`,
          partialCostData: true,
          productsWithCost: withProfitAll.length,
          totalProducts: products.length,
          costCoveragePct: coverageRevenuePct,
        };
      }

      const topN = Math.min(7, withProfitAll.length);
      const withProfit = [...withProfitAll].sort((a, b) => b.profit - a.profit).slice(0, topN);

      const totalProfit = withProfit.reduce((s, p) => s + p.profit, 0);
      const top = withProfit[0];
      const topShare = totalProfit > 0 ? Math.round((top.profit / totalProfit) * 100) : 0;

      // Flag products with negative profit (subsidizing losers)
      const losers = withProfit.filter((p) => p.profit < 0);
      const loserNote = losers.length > 0
        ? ` ${losers.length} product${losers.length > 1 ? 's are' : ' is'} losing money — review pricing or discontinue.`
        : '';

      const coverageNote = coverageProductsPct < 100
        ? ` (Cost data covers ${withProfitAll.length} of ${products.length} products, ${coverageRevenuePct}% of revenue.)`
        : '';

      let highlightCount = 1;
      if (topShare < 20) highlightCount = 3;

      const insight = {
        title: 'Focus on profitable products',
        subtitle: `${top.name} generates ₦${Math.round(top.profit).toLocaleString()} in profit (${topShare}% of total).${loserNote}${coverageNote}`,
      };

      return {
        data: withProfit.map((p) => ({
          label: p.name,
          value: Math.round(p.profit),
          margin: p.margin,
        })),
        highlightCount,
        topProduct: { name: top.name, profit: top.profit, share: topShare, margin: top.margin },
        losers: losers.map((p) => ({ name: p.name, profit: Math.round(p.profit) })),
        insight,
      };
    },
  },

  {
    id: 'gross-margin-analysis',
    title: 'Gross Margin Analysis',
    description: 'Which products have poor margins?',
    dashboard: 'sales',
    category: 'Products',
    priority: 18,
    chartType: 'scatter',
    requiredFields: ['product_name', 'selling_price', 'cost_price'],
    compute(records) {
      const products = analytics.topProducts(records, 50);
      const withMargin = products.filter((p) => p.margin != null && p.revenue > 0);

      if (withMargin.length === 0) {
        return { error: 'Margin data unavailable. Upload a file with cost price information.' };
      }

      // A handful of products carrying cost data can't characterize "which
      // products have poor margins" across the catalog — below this floor
      // the scatter would only ever show the few products that happened to
      // have cost entered, not the business's actual margin picture.
      const productsWithRevenue = products.filter((p) => p.revenue > 0);
      const totalRevenueAll = productsWithRevenue.reduce((s, p) => s + (p.revenue || 0), 0);
      const revenueWithMargin = withMargin.reduce((s, p) => s + (p.revenue || 0), 0);
      const coverageProductsPct = productsWithRevenue.length > 0
        ? Math.round((withMargin.length / productsWithRevenue.length) * 1000) / 10
        : 0;
      const coverageRevenuePct = totalRevenueAll > 0 ? Math.round((revenueWithMargin / totalRevenueAll) * 1000) / 10 : 0;

      if (coverageProductsPct < 20 || coverageRevenuePct < 20) {
        return {
          error: `Cost price is only available for ${withMargin.length} of ${productsWithRevenue.length} products (${coverageRevenuePct}% of revenue) — not enough to reliably analyse margins. Upload cost prices for more products.`,
          partialCostData: true,
          productsWithCost: withMargin.length,
          totalProducts: productsWithRevenue.length,
          costCoveragePct: coverageRevenuePct,
        };
      }

      // Scatter plot: each product = one bubble, sized by revenue
      const data = withMargin.map((p, i) => ({
        name: p.name,
        index: i + 1,
        margin: Math.round(p.margin * 10) / 10,
        revenue: Math.round(p.revenue),
        profit: p.profit != null ? Math.round(p.profit) : null,
      }));

      // Insight: highlight poor-performers
      const poor = data.filter((d) => d.margin < 20);
      const poorCount = poor.length;
      const poorPct = Math.round((poorCount / data.length) * 100);
      const poorTotalRevenue = poor.reduce((s, d) => s + d.revenue, 0);
      const totalRevenue = data.reduce((s, d) => s + d.revenue, 0);
      const poorRevenueShare = totalRevenue > 0 ? Math.round((poorTotalRevenue / totalRevenue) * 100) : 0;

      const coverageNote = coverageProductsPct < 100
        ? ` (Cost data covers ${withMargin.length} of ${productsWithRevenue.length} products, ${coverageRevenuePct}% of revenue.)`
        : '';

      let insight;
      if (poorCount === 0) {
        insight = {
          title: 'All products have healthy margins',
          subtitle: `Every product with cost data has a margin above 20%. Your pricing is on solid ground — keep monitoring as costs change.${coverageNote}`,
        };
      } else {
        insight = {
          title: 'Review pricing or supplier costs',
          subtitle: `${poorCount} products (${poorPct}%) have margins below 20%, representing ₦${poorTotalRevenue.toLocaleString()} (${poorRevenueShare}%) of revenue.${coverageNote} Renegotiate supplier pricing or raise retail prices where the market allows.`,
        };
      }

      return {
        data,
        poorCount,
        poorPct,
        poorRevenueShare,
        totalProducts: data.length,
        insight,
      };
    },
  },

  {
    id: 'best-worst-products',
    title: 'Best & Worst Performing Products',
    description: 'Which products deserve more or less attention? Products ranked by revenue to decide what to promote and what to review.',
    dashboard: 'sales',
    category: 'Products',
    priority: 19,
    chartType: 'hbar',
    format: 'currency',
    requiredFields: ['product_name', 'selling_price', 'quantity'],
    optionalFields: ['cost_price'],
    compute(records) {
      const products = analytics.topProducts(records, 50);
      if (products.length < 3) {
        return { error: 'At least 3 products are needed to rank performance.' };
      }

      // Sort by revenue descending — best at top
      const ranked = [...products].sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
      const totalRevenue = ranked.reduce((s, p) => s + (p.revenue || 0), 0);

      // Show top 4 + bottom 3 = 7 bars max
      const topN = Math.min(4, Math.ceil(ranked.length / 2));
      const bottomN = Math.min(3, ranked.length - topN);
      const best = ranked.slice(0, 3);
      const worst = ranked.slice(-bottomN).reverse();
      const displayProducts = [...ranked.slice(0, topN), ...ranked.slice(-bottomN)];

      const bestRevenue = best.reduce((s, p) => s + (p.revenue || 0), 0);
      const bestShare = totalRevenue > 0 ? Math.round((bestRevenue / totalRevenue) * 100) : 0;
      const worstRevenue = worst.reduce((s, p) => s + (p.revenue || 0), 0);
      const worstShare = totalRevenue > 0 ? Math.round((worstRevenue / totalRevenue) * 100) : 0;

      // Knaflic insight: big idea → data → decision
      let insight;
      if (bestShare > 70) {
        insight = {
          title: `${best.map(p => p.name).join(', ')} carry the business`,
          subtitle: `These 3 products drive ${bestShare}% of revenue. Protect their shelf placement, never stock out, and negotiate bulk discounts. The bottom 3 (${worst.map(p => p.name).join(', ')}) contribute just ${worstShare}% — replace or delist if margins don't justify the shelf space.`,
        };
      } else if (bestShare > 50) {
        insight = {
          title: `Top 3 products deliver ${bestShare}% of revenue`,
          subtitle: `${best[0].name} leads at ₦${best[0].revenue.toLocaleString()}. Promote these in your window display and train staff to recommend them. The bottom 3 generate only ${worstShare}% — test a price cut or bundle before cutting them entirely.`,
        };
      } else {
        insight = {
          title: `${ranked.length} products, well-distributed revenue`,
          subtitle: `No single product dominates — your revenue is diversified. ${best[0].name} is the top earner at ₦${best[0].revenue.toLocaleString()}. The bottom products still contribute ${worstShare}% collectively, so focus on growing the middle tier rather than cutting the tail.`,
        };
      }

      const chartData = displayProducts.map(p => ({
        x: p.revenue || 0,
        y: p.name,
        label: p.name,
        value: p.revenue || 0,
      }));

      return {
        insight,
        data: chartData,
        highlightCount: Math.min(3, best.length), // top 3 highlighted
        bestProducts: best.map(p => ({ name: p.name, revenue: p.revenue, share: totalRevenue > 0 ? Math.round((p.revenue / totalRevenue) * 100) : 0 })),
        worstProducts: worst.map(p => ({ name: p.name, revenue: p.revenue, share: totalRevenue > 0 ? Math.round((p.revenue / totalRevenue) * 100) : 0 })),
        bestShare,
        worstShare,
        totalProducts: ranked.length,
      };
    },
  },

  {
    id: 'revenue-by-category',
    title: 'Revenue by Category',
    description: 'Which therapeutic categories drive sales? Products are auto-classified by drug type when no category column exists.',
    dashboard: 'sales',
    category: 'Products',
    priority: 20,
    chartType: 'hbar',
    format: 'currency',
    requiredFields: ['product_name', 'selling_price'],
    compute(records) {
      // Therapeutic classification — uses shared drugClassifier module
      const catKey = detectCategoryField(records);

      // Group revenue by category
      const catMap = {};
      for (const rec of records) {
        let cat;
        if (catKey) {
          cat = rec[catKey] ? String(rec[catKey]).trim() : null;
        } else {
          cat = classifyDrug(rec.product_name || rec.product);
        }
        if (!cat || cat === 'Unknown' || cat === 'Unclassified') cat = null;
        const key = cat || 'Other';
        catMap[key] = (catMap[key] || 0) + (Number(rec.revenue || rec.selling_price || 0));
      }

      const entries = Object.entries(catMap)
        .map(([name, revenue]) => ({ name, revenue: Math.round(revenue) }))
        .sort((a, b) => b.revenue - a.revenue);

      if (entries.length === 0) {
        return { error: 'No category or product data available for classification.' };
      }

      // Show top 5 categories, group rest into "Other"
      const topN = 5;
      const topEntries = entries.filter(e => e.name !== 'Other').slice(0, topN);
      const restEntries = entries.filter(e => e.name !== 'Other').slice(topN);
      const otherEntry = entries.find(e => e.name === 'Other');
      let otherRevenue = (otherEntry ? otherEntry.revenue : 0) +
        restEntries.reduce((s, e) => s + e.revenue, 0);
      const displayEntries = [...topEntries];
      if (otherRevenue > 0) {
        displayEntries.push({ name: 'Other', revenue: Math.round(otherRevenue) });
      }

      const totalRevenue = displayEntries.reduce((s, e) => s + e.revenue, 0);
      const top = displayEntries[0];
      const topShare = totalRevenue > 0 ? Math.round((top.revenue / totalRevenue) * 100) : 0;

      // Knaflic insight
      let insight;
      if (topShare > 50) {
        insight = {
          title: `${top.name} dominates at ${topShare}% of revenue`,
          subtitle: `This single category drives over half your sales. Ensure you're not overdependent — diversify into complementary categories to protect against supply shocks or price changes.`,
        };
      } else if (topShare > 30) {
        insight = {
          title: `${top.name} leads at ${topShare}% across ${displayEntries.length} categories`,
          subtitle: `Revenue is concentrated but healthy. Allocate inventory budget proportionally — put your capital where the demand is.`,
        };
      } else {
        insight = {
          title: `${displayEntries.length} categories with ${top.name} leading at ${topShare}%`,
          subtitle: `Revenue is well-distributed across categories. Use this breakdown to set baseline inventory levels — no single category dominates your risk.`,
        };
      }

      const chartData = displayEntries.map(e => ({
        label: e.name,
        value: e.revenue,
      }));

      // Highlight top categories mentioned in insight
      let highlightCount = 1;
      if (topShare < 30) highlightCount = Math.min(3, displayEntries.length);

      return {
        insight,
        data: chartData,
        highlightCount,
        categories: displayEntries.map(e => ({
          name: e.name,
          revenue: e.revenue,
          share: totalRevenue > 0 ? Math.round((e.revenue / totalRevenue) * 100) : 0,
        })),
        totalCategories: entries.length,
        classifiedBy: catKey ? 'category column' : 'drug name auto-classification',
      };
    },
  },

  {
    id: 'category-growth',
    title: 'Category Growth',
    description: 'Which therapeutic categories are growing or declining? Monthly revenue per category to decide future investment priorities.',
    dashboard: 'sales',
    category: 'Products',
    priority: 21,
    chartType: 'stacked-area',
    format: 'currency',
    requiredFields: ['product_name', 'selling_price', 'transaction_date'],
    compute(records) {
      const catKey = detectCategoryField(records);
      const monthMap = {}; // { month: { category: revenue } }

      for (const rec of records) {
        const date = rec.transaction_date;
        if (date == null || date === '') continue;
        const s = String(date).trim();
        if (!/^\d{4}-\d{2}/.test(s)) continue;
        const month = s.substring(0, 7);

        let cat;
        if (catKey) {
          cat = rec[catKey] ? String(rec[catKey]).trim() : 'Unknown';
        } else {
          cat = classifyDrug(rec.product_name || rec.product);
        }
        if (!cat || cat === 'Unknown') cat = 'Unclassified';

        const revenue = Number(rec.revenue || rec.selling_price || 0);
        if (!monthMap[month]) monthMap[month] = {};
        monthMap[month][cat] = (monthMap[month][cat] || 0) + revenue;
      }

      const months = Object.keys(monthMap).sort();
      if (months.length < 3) {
        return { error: 'At least 3 months of data are needed to show category growth trends.' };
      }

      // Collect all categories and sort by total revenue
      const catTotals = {};
      for (const m of months) {
        for (const [cat, rev] of Object.entries(monthMap[m])) {
          catTotals[cat] = (catTotals[cat] || 0) + rev;
        }
      }
      const topCats = Object.entries(catTotals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([name]) => name);

      // Group remaining into "Other"
      const otherCats = Object.keys(catTotals).filter(c => !topCats.includes(c) && c !== 'Unclassified');

      // Build pivot data
      const data = months.map(m => {
        const point = { month: m };
        for (const cat of topCats) {
          point[cat] = Math.round((monthMap[m][cat] || 0));
        }
        let otherSum = 0;
        for (const oc of otherCats) {
          otherSum += monthMap[m][oc] || 0;
        }
        if (otherSum > 0) point['Other'] = Math.round(otherSum);
        return point;
      });

      // Growth rates: first month vs last month per category
      const firstMonth = monthMap[months[0]] || {};
      const lastMonth = monthMap[months[months.length - 1]] || {};
      const growthRates = {};
      for (const cat of topCats) {
        const first = firstMonth[cat] || 0;
        const last = lastMonth[cat] || 0;
        growthRates[cat] = first > 0 ? Math.round(((last - first) / first) * 100) : (last > 0 ? 100 : 0);
      }

      // Identify top grower and biggest decliner
      let topGrower = { name: '', growth: -Infinity };
      let topDecliner = { name: '', growth: Infinity };
      for (const [cat, growth] of Object.entries(growthRates)) {
        if (growth > topGrower.growth) topGrower = { name: cat, growth };
        if (growth < topDecliner.growth) topDecliner = { name: cat, growth };
      }

      // Knaflic insight
      let insight;
      if (topGrower.growth > 20) {
        insight = {
          title: `${topGrower.name} is surging (+${topGrower.growth}%) — invest here`,
          subtitle: topDecliner.growth < -10
            ? `${topGrower.name} grew ${topGrower.growth}% over ${months.length} months while ${topDecliner.name} dropped ${Math.abs(topDecliner.growth)}%. Shift inventory budget from declining categories into growth leaders — the trend is clear across ${months.length} months.`
            : `${topGrower.name} grew ${topGrower.growth}% over ${months.length} months. Allocate more shelf space and supplier budget to this category — it's your clear growth engine.`,
        };
      } else if (topDecliner.growth < -20) {
        insight = {
          title: `${topDecliner.name} is declining (${topDecliner.growth}%) — investigate why`,
          subtitle: `While ${topGrower.name} shows modest growth (${topGrower.growth}%), ${topDecliner.name} fell ${Math.abs(topDecliner.growth)}% across ${months.length} months. Check for stockouts, competitor pricing, or changing patient needs before cutting entirely.`,
        };
      } else {
        insight = {
          title: `${topCats.length} categories tracked over ${months.length} months`,
          subtitle: `Category revenues are relatively stable. ${topGrower.name} leads growth at ${topGrower.growth}%. Use this trend data to set baseline inventory levels and negotiate better terms with suppliers of consistent performers.`,
        };
      }

      return {
        insight,
        data,
        categories: [...topCats, ...(otherCats.length > 0 ? ['Other'] : [])],
        growthRates,
        topGrower,
        topDecliner,
        months: data.length,
        classifiedBy: catKey ? 'category column' : 'drug name auto-classification',
      };
    },
  },

  {
    id: 'sales-seasonality',
    title: 'Sales Seasonality',
    description: 'Does demand follow seasonal patterns? Multi-year overlay revealing which months consistently outperform or underperform, so you can prepare for predictable demand changes.',
    dashboard: 'sales',
    category: 'Trends',
    priority: 12,
    chartType: 'line',
    requiredFields: ['transaction_date', 'selling_price', 'quantity'],
    optionalFields: ['cost_price'],
    compute(records) {
      const result = analytics.salesSeasonality(records);
      if (!result) {
        return { error: 'At least several months of sales history spanning different calendar months are required to analyse seasonality.' };
      }
      if (result.years.length < 1 || result.monthsOfData < 2) {
        return { error: 'Insufficient date range for seasonality analysis. Data must span multiple calendar months with valid date and revenue information.' };
      }

      // Build insight object for display
      let title;
      if (result.patternType === 'Highly Seasonal') {
        title = `${result.peakMonth.month} is consistently the strongest month`;
      } else if (result.patternType === 'Moderately Seasonal') {
        title = `${result.peakMonth.month} tends to outperform — moderate seasonality detected`;
      } else if (result.patternType === 'Insufficient History') {
        title = 'Seasonality needs more history';
      } else {
        title = 'Monthly demand is relatively stable across the year';
      }

      return {
        ...result,
        insight: {
          title,
          subtitle: result.patternSubtitle,
        },
      };
    },
  },

  {
    id: 'product-performance-over-time',
    title: 'Product Performance Over Time',
    description: 'Are key products improving or declining? Monthly revenue heatmap reveals which products are gaining versus losing momentum, so you can act before dead stock piles up.',
    dashboard: 'sales',
    category: 'Products',
    priority: 15,
    chartType: 'table',
    requiredFields: ['product_name', 'transaction_date', 'selling_price', 'quantity'],
    optionalFields: ['cost_price'],
    compute(records) {
      const result = analytics.productPerformanceOverTime(records, 12);
      if (!result) {
        return { error: 'Need at least 2 months of data with product names and revenue to track performance over time.' };
      }
      if (result.products.length === 0) {
        return { error: 'No products with sufficient data found. Ensure product names and date/revenue data are present.' };
      }
      return result;
    },
  },

  {
    id: 'revenue-forecast',
    title: 'Revenue Forecast',
    description: 'What is the expected sales next month? Time-series forecast with confidence bands to help you plan purchasing, staffing, and cash flow with data — not guesswork.',
    dashboard: 'sales',
    category: 'Trends',
    priority: 11,
    chartType: 'line',
    requiredFields: ['transaction_date', 'selling_price', 'quantity'],
    optionalFields: ['cost_price'],
    compute(records) {
      const result = analytics.revenueForecast(records, 3);
      if (!result) {
        return { error: 'At least 3 months of revenue data with valid dates are needed to produce a forecast.' };
      }
      return result;
    },
  },

  {
    id: 'sales-concentration-risk',
    title: 'Sales Concentration Risk',
    description: 'Is the business overly dependent on a few products? Pareto analysis + HHI index reveals revenue concentration so you can diversify before a single product loss threatens the business.',
    dashboard: 'sales',
    category: 'Products',
    priority: 16,
    chartType: 'pie',
    requiredFields: ['product_name', 'selling_price', 'quantity'],
    optionalFields: ['cost_price'],
    compute(records) {
      const result = analytics.salesConcentrationRisk(records);
      if (!result) {
        return { error: 'Need at least 2 distinct products with revenue data to measure concentration.' };
      }
      return result;
    },
  },

  {
    id: 'profit-leakage',
    title: 'Where Is Profit Leaking?',
    description: 'Identify exactly which products are eroding gross profit using four evidence-based rules: high revenue/low margin, sold below cost, low profit contribution, and margin below target. Every insight is traceable to the data — no AI guesses.',
    dashboard: 'inventory',
    category: 'Products',
    priority: 17,
    chartType: 'scatter',
    requiredFields: ['product_name', 'selling_price', 'quantity', 'cost_price'],
    compute(records, options = {}) {
      const targetMargin = options.targetMargin || 25;
      const result = analytics.profitLeakage(records, targetMargin);
      if (!result) {
        return { error: 'Insufficient data for profit leakage analysis.' };
      }
      if (result.error && result.costUnavailable) {
        return {
          error: result.error,
          costUnavailable: true,
          ...(result.partialCostData ? {
            partialCostData: true,
            productsWithCost: result.productsWithCost,
            totalProducts: result.totalProducts,
            costCoveragePct: result.costCoveragePct,
          } : {}),
        };
      }
      return result;
    },
  },

  {
    id: 'payment-mix',
    title: 'Payment Mix',
    description: 'Breakdown of payment methods used by customers such as cash, transfer, and POS.',
    dashboard: 'sales',
    category: 'Breakdown',
    priority: 13,
    chartType: 'pie',
    requiredFields: ['payment_method'],
    optionalFields: ['revenue'],
    compute(records) {
      const map = {};
      for (const rec of records) {
        const method = rec.payment_method ? String(rec.payment_method).trim() : 'Unknown';
        if (!method) continue;
        if (!map[method]) map[method] = { count: 0, revenue: 0 };
        map[method].count++;
        map[method].revenue += Number(rec.revenue || 0);
      }
      const entries = Object.entries(map);
      if (entries.length === 0) {
        return { error: 'No payment method data available' };
      }
      return {
        series: entries.map(([name, d]) => ({ name, value: d.count, revenue: Math.round(d.revenue * 100) / 100 })),
      };
    },
  },

  // ===== INVENTORY DASHBOARD ===============================================

  {
    id: 'stock-value',
    title: 'Stock Value',
    description: 'Total value of current inventory calculated as stock quantity multiplied by cost price.',
    dashboard: 'inventory',
    category: 'KPIs',
    priority: 1,
    chartType: 'kpi-card',
    requiredFields: ['current_stock', 'cost_price'],
    optionalFields: [],
    format: 'currency',
    compute(records) {
      // `Number(rec.cost_price) || 0` used to treat a MISSING cost price as
      // free stock: those products added ₦0 to the total while still being
      // counted in the "N products" label, so the headline understated the
      // real inventory value with no disclosure. Count only products that
      // actually have a cost price, and say how many were left out.
      let total = 0;
      let withCost = 0;
      let withoutCost = 0;
      for (const rec of records) {
        const stock = Number(rec.current_stock);
        if (!Number.isFinite(stock) || stock <= 0) continue;
        const rawCost = rec.cost_price != null && rec.cost_price !== '' ? rec.cost_price : rec.cost;
        const cost = rawCost != null && rawCost !== '' ? Number(rawCost) : null;
        if (cost == null || !Number.isFinite(cost)) {
          withoutCost++;
          continue;
        }
        total += stock * cost;
        withCost++;
      }
      if (withCost === 0) return { error: 'No stock data with cost available' };

      const totalProducts = withCost + withoutCost;
      const coveragePct = Math.round((withCost / totalProducts) * 1000) / 10;
      return {
        value: Math.round(total * 100) / 100,
        label: 'Stock Value',
        sublabel: withoutCost > 0
          ? `${withCost} of ${totalProducts} products (${coveragePct}% have cost price)`
          : `${withCost} products`,
        ...(withoutCost > 0 ? { partialCostData: true, productsWithCost: withCost, totalProducts, costCoveragePct: coveragePct } : {}),
      };
    },
  },

  {
    id: 'current-stock',
    title: 'Current Stock Levels',
    description: 'Current stock quantities per product with optional reorder level indicators.',
    dashboard: 'inventory',
    category: 'KPIs',
    priority: 2,
    chartType: 'table',
    requiredFields: ['product_name', 'current_stock'],
    optionalFields: ['reorder_level'],
    compute(records) {
      const products = [];
      for (const rec of records) {
        if (rec.current_stock == null) continue;
        const name = rec.product_name ? String(rec.product_name).trim() : 'Unknown';
        const stock = Number(rec.current_stock);
        const reorder = rec.reorder_level != null ? Number(rec.reorder_level) : null;
        if (!Number.isFinite(stock) || stock < 0) continue;
        products.push({ name, stock, reorder, low: reorder !== null && stock <= reorder });
      }
      if (products.length === 0) return { error: 'No stock data available' };
      const hasReorder = products.some((p) => p.reorder !== null);
      return {
        columns: hasReorder ? ['Product', 'Stock', 'Reorder', 'Status'] : ['Product', 'Stock'],
        rows: products
          .sort((a, b) => (a.low ? -1 : 1) - (b.low ? -1 : 1) || a.name.localeCompare(b.name))
          .slice(0, 20)
          .map((p) =>
            hasReorder
              ? [p.name, p.stock, p.reorder || '—', p.low ? 'LOW' : 'OK']
              : [p.name, p.stock]
          ),
        lowStockCount: products.filter((p) => p.low).length,
      };
    },
  },

  {
    id: 'low-stock-alert',
    title: 'Low Stock Alert',
    description: 'Number of products currently below the configured stock threshold.',
    dashboard: 'inventory',
    category: 'KPIs',
    priority: 3,
    chartType: 'kpi-card',
    requiredFields: ['current_stock', 'reorder_level'],
    optionalFields: [],
    format: 'number',
    compute(records) {
      let low = 0;
      let total = 0;
      for (const rec of records) {
        if (rec.current_stock == null) continue;
        const stock = Number(rec.current_stock);
        const reorder = Number(rec.reorder_level);
        if (Number.isFinite(stock) && stock >= 0) {
          total++;
          if (Number.isFinite(reorder) && reorder >= 0 && stock <= reorder) low++;
        }
      }
      if (total === 0) return { error: 'No stock data available' };
      return {
        value: low,
        label: 'Low Stock Items',
        sublabel: `${low} of ${total} products below reorder point`,
        alert: low > 0,
      };
    },
  },

  {
    id: 'inventory-turnover',
    title: 'Inventory Turnover',
    description: 'Measures how quickly inventory is sold and replaced. Higher values indicate faster stock movement.',
    dashboard: 'inventory',
    category: 'Analysis',
    priority: 4,
    chartType: 'kpi-card',
    requiredFields: ['product_name', 'quantity', 'transaction_date'],
    optionalFields: ['current_stock'],
    compute(records) {
      // Aggregate quantity sold per product over the period
      const soldMap = {};
      for (const rec of records) {
        const name = rec.product_name ? String(rec.product_name).trim() : 'Unknown';
        if (!name || name === 'Unknown') continue;
        const qty = Number(rec.quantity) || 0;
        soldMap[name] = (soldMap[name] || 0) + qty;
      }
      const productCount = Object.keys(soldMap).length;
      const totalSold = Object.values(soldMap).reduce((a, b) => a + b, 0);
      if (productCount === 0) return { error: 'No sales quantity data available' };
      const avgSoldPerProduct = Math.round((totalSold / productCount) * 100) / 100;
      return {
        value: avgSoldPerProduct,
        label: 'Avg Units Sold/Product',
        sublabel: `${totalSold} total units across ${productCount} products`,
      };
    },
  },

  // ===== EXPIRY DASHBOARD ==================================================

  {
    id: 'expiry-risk',
    title: 'Expiry Risk',
    description: 'Products approaching or past their expiration date within 90 and 180 days.',
    dashboard: 'expiry',
    category: 'KPIs',
    priority: 1,
    chartType: 'kpi-card',
    requiredFields: ['expiry_date'],
    optionalFields: ['current_stock'],
    format: 'number',
    compute(records) {
      const now = new Date();
      const ninetyDays = 90 * 24 * 60 * 60 * 1000;
      let expired = 0;
      let within90 = 0;
      let within180 = 0;
      let total = 0;

      for (const rec of records) {
        const expiryRaw = rec.expiry_date;
        if (!expiryRaw) continue;
        try {
          const d = new Date(expiryRaw);
          if (isNaN(d.getTime())) continue;
          total++;
          const diff = d.getTime() - now.getTime();
          if (diff < 0) expired++;
          else if (diff < ninetyDays) within90++;
          else if (diff < ninetyDays * 2) within180++;
        } catch (_) {}
      }

      if (total === 0) return { error: 'No expiry date data available' };
      return {
        value: expired + within90,
        label: 'At-Risk Products',
        sublabel: `${expired} expired, ${within90} within 90 days, ${within180} within 180 days`,
        alert: (expired + within90) > 0,
        detail: { expired, within90, within180, total },
      };
    },
  },

  {
    id: 'expiry-timeline',
    title: 'Expiry Timeline',
    description: 'Detailed expiry schedule showing days remaining and stock status for each product.',
    dashboard: 'expiry',
    category: 'Analysis',
    priority: 2,
    chartType: 'table',
    requiredFields: ['product_name', 'expiry_date'],
    optionalFields: ['current_stock'],
    compute(records) {
      const now = new Date();
      const items = [];
      for (const rec of records) {
        const name = rec.product_name ? String(rec.product_name).trim() : 'Unknown';
        const expiryRaw = rec.expiry_date;
        const stock = rec.current_stock != null ? Number(rec.current_stock) : null;
        if (!expiryRaw) continue;
        try {
          const d = new Date(expiryRaw);
          if (isNaN(d.getTime())) continue;
          const daysLeft = Math.ceil((d.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
          items.push({ name, expiryDate: expiryRaw, daysLeft, stock, urgent: daysLeft <= 90 });
        } catch (_) {}
      }
      if (items.length === 0) return { error: 'No expiry date data available' };
      return {
        columns: ['Product', 'Expiry Date', 'Days Left', 'Stock'],
        rows: items
          .sort((a, b) => a.daysLeft - b.daysLeft)
          .slice(0, 20)
          .map((p) => [p.name, p.expiryDate, p.daysLeft, p.stock || '—']),
        urgentCount: items.filter((p) => p.urgent).length,
      };
    },
  },

  // ===== SUPPLIER DASHBOARD ================================================

  {
    id: 'supplier-breakdown',
    title: 'Supplier Breakdown',
    description: 'Product distribution across suppliers. Shows which suppliers supply the most products.',
    dashboard: 'supplier',
    category: 'Analysis',
    priority: 1,
    chartType: 'table',
    requiredFields: ['supplier'],
    optionalFields: ['current_stock', 'product_name'],
    compute(records) {
      const map = {};
      for (const rec of records) {
        const supplier = rec.supplier ? String(rec.supplier).trim() : 'Unknown';
        if (!supplier) continue;
        if (!map[supplier]) map[supplier] = { products: new Set(), stockTotal: 0 };
        const name = rec.product_name ? String(rec.product_name).trim() : null;
        if (name) map[supplier].products.add(name);
        map[supplier].stockTotal += (rec.current_stock != null ? Number(rec.current_stock) : 0);
      }
      const entries = Object.entries(map);
      if (entries.length === 0) return { error: 'No supplier data available' };
      return {
        columns: ['Supplier', 'Products', 'Total Stock'],
        rows: entries
          .sort((a, b) => b[1].products.size - a[1].products.size)
          .map(([name, d]) => [name, d.products.size, d.stockTotal || '—']),
      };
    },
  },

  // ===== CUSTOMER DASHBOARD ================================================

  {
    id: 'customer-count',
    title: 'Customer Count',
    description: 'Number of unique customers served during the period.',
    dashboard: 'customer',
    category: 'KPIs',
    priority: 1,
    chartType: 'kpi-card',
    requiredFields: ['customer'],
    optionalFields: [],
    format: 'number',
    compute(records) {
      const unique = new Set();
      for (const rec of records) {
        const cust = rec.customer ? String(rec.customer).trim() : null;
        if (cust) unique.add(cust);
      }
      if (unique.size === 0) return { error: 'No customer data available' };
      return { value: unique.size, label: 'Unique Customers', sublabel: `${records.length} total records` };
    },
  },
];

// ---- exported API ----------------------------------------------------------

/**
 * Generate business interpretation based on pattern analysis.
 */
/**
 * Return every registered widget definition.
 */
function getAll() {
  return WIDGETS;
}

/**
 * Return widgets filtered by dashboard.
 */
function getByDashboard(dashboard) {
  return WIDGETS.filter((w) => w.dashboard === dashboard);
}

/**
 * Return a single widget by ID.
 */
function get(id) {
  return WIDGETS.find((w) => w.id === id);
}

/**
 * Return all unique dashboard names.
 */
function getDashboards() {
  return [...new Set(WIDGETS.map((w) => w.dashboard))];
}

module.exports = { getAll, getByDashboard, get, getDashboards };
