/**
 * AI Advisor — tool schemas (OpenAI-style function calling) + dispatch.
 *
 * Each tool is a thin, named wrapper around a advisorQueries.js function.
 * The LLM never sees raw SQL or gets free-form data access — it can only
 * call one of these named, typed functions, and every result it can talk
 * about comes back through here.
 */

const queries = require('./advisorQueries');
const modeling = require('./advisor/businessModelingEngine');

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'getRevenueProfitSummary',
      description: 'Total revenue, gross profit, gross margin, quantity sold, transaction count. grossProfit/grossMargin/totalCost are null when cost-price data is missing OR too thin to trust (costCoverage states which, and the exact row/revenue coverage). Defaults to the current upload only — if it has no sales rows at all, returns availableInCurrentUpload:false/availableHistorically:true rather than silently answering from an older upload. Use for "how much did I sell/make" style questions.',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['current', 'all'], description: "'current' (default) reads only the most recent upload. Only pass 'all' after the user has explicitly agreed to include historical/other uploads." },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getWeeklyRevenue',
      description: 'Revenue, profit, and transaction count broken down by week. A week\'s profit is null when cost-price coverage for that specific week is missing or too thin to trust (costCoverage states the exact row/revenue coverage) — revenue and transaction count are unaffected either way. Use for "this week" / "last week" style questions.',
      parameters: {
        type: 'object',
        properties: { weeks: { type: 'integer', description: 'How many recent weeks to return, default 8' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getGrowthTrend',
      description: 'Month-over-month revenue growth trend and whether the business is Growing, Declining, or Stable. Use for "is the business growing" questions.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getTopProducts',
      description: 'Ranked list of products by revenue or profit. Use for "which products make the most money/profit", "what should I promote".',
      parameters: {
        type: 'object',
        properties: {
          sortBy: { type: 'string', enum: ['revenue', 'profit'], description: 'Rank by revenue or profit, default revenue' },
          n: { type: 'integer', description: 'How many products to return, default 10' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getCategoryPerformance',
      description: 'Revenue, profit, and margin by product category, under `categories`. `hasCostData` is false when no cost prices were uploaded at ALL. Even when true, an individual category\'s own cost/profit/marginPct can still be null if that specific category\'s cost-price coverage is too thin to trust — check that category\'s own `costCoverage` for the exact reason (revenue and unitsSold are always reliable regardless). Defaults to the current upload only — if it has no sales rows at all, returns availableInCurrentUpload:false/availableHistorically:true rather than silently answering from an older upload. Use for "which category performs best".',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['current', 'all'], description: "'current' (default) reads only the most recent upload. Only pass 'all' after the user has explicitly agreed to include historical/other uploads." },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getSlowMovers',
      description: 'Products classified as slow-selling by sales velocity. Use for "which products aren\'t selling", "what should I stop buying".',
      parameters: { type: 'object', properties: { n: { type: 'integer', description: 'Max products to return, default 15' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getProfitLeakage',
      description: 'Products with margin below a threshold, under `products`, ordered by revenue (biggest naira impact first). Returns `available: false` if no cost-price data was uploaded at all — that means profit leakage cannot be determined, not that there is none. Defaults to the current upload only — if it has no sales rows at all, returns availableInCurrentUpload:false/availableHistorically:true rather than silently answering from an older upload. Use for "where am I losing profit".',
      parameters: {
        type: 'object',
        properties: {
          marginThreshold: { type: 'number', description: 'Margin percent below which a product counts as leaking profit, default 15' },
          n: { type: 'integer', description: 'Max products to return, default 10' },
          scope: { type: 'string', enum: ['current', 'all'], description: "'current' (default) reads only the most recent upload. Only pass 'all' after the user has explicitly agreed to include historical/other uploads." },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getProductProfile',
      description: 'Look up one product by name (typo-tolerant, matches brand or generic name too): revenue, quantity, margin, price, rank, monthly trend. Use for "tell me about <drug>" questions. If the result has ambiguous:true, ask the user which product they meant instead of guessing.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The product name as the user typed it' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'simulatePriceChange',
      description: 'Projects the revenue impact of changing one product\'s price, holding quantity sold constant (states this assumption), and reports any real historical price/quantity variation for that product. Use for "if I raise/lower the price of X by Y%" questions.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The product name' },
          priceChangePct: { type: 'number', description: 'Percent change, positive for increase, negative for decrease' },
        },
        required: ['query', 'priceChangePct'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getTopCustomers',
      description: 'Ranked list of named customers by total spend. Use for "which customers spend the most". Returns available:false if the dataset has no named-customer data.',
      parameters: { type: 'object', properties: { n: { type: 'integer', description: 'Max customers to return, default 10' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getFrequentlyBoughtTogether',
      description: 'Product pairs that appear together on the same invoice most often. Use for "what products are usually bought together". Optionally scope to one product. Returns available:false if the dataset lacks multi-item invoices.',
      parameters: {
        type: 'object',
        properties: {
          product: { type: 'string', description: 'Optional — scope results to pairs involving this product' },
          n: { type: 'integer', description: 'Max pairs to return, default 10' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getDataFields',
      description: 'Every real field detected in the data, under `fields` — each with a label, how many records have it, and real sample values. This is the SOURCE OF TRUTH for "what data can you see / what columns do you have" style questions — it reports every recognized field with actual data, not just whatever a narrower tool like getLowStock or getSupplierBreakdown happens to expose (a dataset can have Category, Batch Number, or Branch correctly stored with no other tool ever mentioning it). Call this first whenever asked what data is available, rather than answering from memory of which other tools exist. Defaults to the current upload only.',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['current', 'all'], description: "'current' (default) reads only the most recent upload. Only pass 'all' after the user has explicitly agreed to include historical/other uploads." },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getUploadHistory',
      description: 'Every file this organization has EVER uploaded — filename, when, row count, processing status, and capabilities (sales/inventory/expiry/supplier/customer) — regardless of what each file contains. This is the ONLY correct source for "how many files/uploads do I have", "what have I uploaded", or "list my files". Do not answer this from getDataFields, getDataScope, or the current-upload context in this prompt — those only ever cover files that produced sales transaction rows, so a stock, expiry or supplier-only upload is invisible to them even though it is a real file. Call this tool whenever the question is about the organization\'s upload history itself, not about what one of those files contains.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getDatasetMetric',
      description: 'Computes STOCK-shaped metrics from the current upload\'s own records — the only tool that can read an inventory/stock file, because inventory rows have no transaction date and therefore never reach the sales tables that every other metric tool queries. Use it for: potential revenue/cost/gross profit/margin on stock currently held, inventory value at cost or at retail, per-unit margins, highest/lowest margin product, and any ranking of those (top N, a position range via `offset`, or "everything below X%" via maxValue). Also use it when a question about the current upload comes back with no sales rows — an inventory file legitimately has none. DIVISION OF LABOUR: sales-transaction measures (revenue/quantity/profit over time, by payment method, by customer type) belong to getBusinessMetric and are deliberately NOT offered here — the two engines read different row sets, so asking each for the same named number could yield two different answers. Every figure is exact arithmetic over real records. Returns available:false naming the exact missing columns when a measure\'s inputs aren\'t present, and gates cost-derived measures when cost-price coverage is too thin to be reliable (stating the exact coverage). Grouped results report totalMatching — if it exceeds the rows returned, say the list is partial.',
      parameters: {
        type: 'object',
        properties: {
          measure: {
            type: 'string',
            enum: ['stock_units', 'product_count', 'inventory_value_at_cost', 'inventory_value_at_retail', 'potential_revenue', 'potential_cost', 'potential_gross_profit', 'potential_margin_pct', 'unit_margin', 'unit_margin_pct'],
            description: 'potential_revenue = selling price x current stock. potential_cost = cost price x current stock. potential_gross_profit = (selling - cost) x current stock. potential_margin_pct = that profit over that revenue. inventory_value_at_cost/at_retail are the same holdings valued at cost or at retail. unit_margin/unit_margin_pct are per-unit price spreads — pair with groupBy:"product" for best/worst margin products. Any potential_*/inventory_value_* call also returns relatedFigures with revenue, cost, profit and margin together, so one call usually answers a "potential profit" question fully.',
          },
          groupBy: {
            type: 'string',
            enum: ['product', 'category', 'supplier', 'branch', 'batch_number'],
            description: 'Optional — omit for a single overall total. Breaks the measure down by this dimension.',
          },
          filters: {
            type: 'object',
            description: 'Optional. Omit any key not needed. All partial, case-insensitive matches.',
            properties: {
              product: { type: 'string', description: 'Product name, partial match' },
              category: { type: 'string', description: 'Category, partial match' },
              supplier: { type: 'string', description: 'Supplier, partial match' },
              branch: { type: 'string', description: 'Branch, partial match' },
            },
          },
          sortDir: { type: 'string', enum: ['desc', 'asc'], description: "Ranking direction when groupBy is set, default 'desc' (highest first). Use 'asc' for lowest/worst." },
          n: { type: 'integer', description: 'Max groups to return, default 20, max 200. Not a data limit — totalMatching always reports the true count.' },
          offset: { type: 'integer', description: 'Skip this many groups before returning — use for "ranked 21 to 50" style asks (offset:20 with n:30).' },
          minValue: { type: 'number', description: 'Only include groups whose value is at least this. Applies to groups; defaults groupBy to product if omitted.' },
          maxValue: { type: 'number', description: 'Only include groups whose value is at most this — e.g. maxValue:15 with measure unit_margin_pct for "products below 15% margin".' },
          scope: { type: 'string', enum: ['current', 'all'], description: "'current' (default) reads only the most recent upload. Only pass 'all' after the user has explicitly agreed to include historical/other uploads." },
        },
        required: ['measure'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getLowStock',
      description: 'Products at or below their reorder level, returned as a full `products` list (name, stock, reorderLevel) with `lowStockCount` matching that list exactly — use the list to answer "which ones". Defaults to the current upload only. Use for "which products are running low", "what should I reorder today".',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['current', 'all'], description: "'current' (default) reads only the most recent upload. Only pass 'all' after the user has explicitly agreed to include historical/other uploads." },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getOverstock',
      description: 'Products holding far more stock than they sell, as a full `products` list with `overstockCount` matching it. estimated:true means the upload had stock levels but no quantity-sold data, so these are largest holdings rather than confirmed overstock — say so. Defaults to the current upload only.',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['current', 'all'], description: "'current' (default) reads only the most recent upload. Only pass 'all' after the user has explicitly agreed to include historical/other uploads." },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getExpirySummary',
      description: 'Products approaching or past expiry, as a full `items` list sorted soonest-first with daysRemaining (negative = already expired). Defaults to the current upload only. Use for "which products are expiring soon".',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['current', 'all'], description: "'current' (default) reads only the most recent upload. Only pass 'all' after the user has explicitly agreed to include historical/other uploads." },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getSupplierBreakdown',
      description: 'Suppliers in the data, with how many distinct products, total stock, and units sold each accounts for. Defaults to the current upload only. Use for "who are my suppliers", "which supplier do I depend on most".',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['current', 'all'], description: "'current' (default) reads only the most recent upload. Only pass 'all' after the user has explicitly agreed to include historical/other uploads." },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getBusinessHealth',
      description: 'Overall business health score (0-100), rating, and pillar breakdown (sales, profit, inventory, customer, operations). Use for broad "how is my business doing" questions.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getTopPriorities',
      description: 'The current top flagged issues and opportunities, each with an observation, business impact (with naira figures where applicable), and a recommended action. Use for "biggest risk", "biggest opportunity", "what should I do next", and as the fallback when a question is outside what any other tool can answer — check here for something genuinely related before saying you can\'t help.',
      parameters: { type: 'object', properties: { n: { type: 'integer', description: 'Max priorities to return, default 5' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getRevenueTrendDrivers',
      description: 'Explains recent revenue swings with the specific products/months that drove them. Use for "why did sales change" questions.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getWeatherOutlook',
      description: 'Current weather risk signals (rainfall, humidity, heatwave, harmattan/dust, cold) for the pharmacy\'s set location, and which seasonal-demand rules currently qualify — each labelled with whether this pharmacy\'s own sales history confirms it. Use for weather/seasonal questions ("is it going to rain", "should I stock up for harmattan", "why did you recommend more antihistamines"). Returns available:false if no state is set (direct the user to Settings) or the weather provider isn\'t configured.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getDecisionOpportunities',
      description: 'Ranked business opportunities and risks (Sales, Inventory, Profitability, Customer, Operations pillars), each with a priority (Critical/High/Medium/Low), a finding, supporting evidence, confidence, and financial impact where estimable. Combines internal analytics with external weather/calendar/disease intelligence. Findings only — no recommended actions attached (use getRecommendations for those). Use for "what are my biggest opportunities/risks" questions.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getRecommendations',
      description: 'Concrete recommended actions under `recommendations`, each with its reasoning (traceable to a specific decision opportunity), estimated stockout risk where computable, and confidence. Every number here is derived from real evidence, never invented. Findings too weak to act on are already excluded — if `filteredCount` is present, that many existed but fell below the confidence bar to recommend as an action; mention this only if asked why so few recommendations appeared. Use for "what should I do" / "what should I do next" questions.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getBusinessMetric',
      description: 'Computes a metric directly from sales data for a question none of the other tools above answer — e.g. "revenue by payment method", "average transaction value on weekends vs weekdays", "how many distinct customers bought in March", "items per transaction by branch". CHECK THE REST OF THIS CATALOG FIRST: if a named tool already covers the question (revenue/profit summaries, category performance, top products, low stock, etc.), call that instead — never use this to recompute something a dedicated tool already provides. Every number here is an exact SQL aggregate over real sale records, not an estimate. profit/margin_pct return available:false when cost-price coverage is too thin to be reliable (states exact coverage). Grouped results include totalGroups alongside the (possibly capped) rows — if totalGroups > rows.length, say so; never imply the list is complete when it is not. A text filter that matches no or very few rows returns availableValues with the real values on record — retry with a corrected value instead of concluding the data doesn\'t exist. Defaults to the current upload only — if it has no sales rows matching the question at all, returns availableInCurrentUpload:false/availableHistorically:true rather than silently answering from an older upload.',
      parameters: {
        type: 'object',
        properties: {
          measure: {
            type: 'string',
            enum: ['revenue', 'quantity', 'transaction_count', 'average_transaction_value', 'distinct_product_count', 'distinct_customer_count', 'profit', 'margin_pct', 'items_per_transaction'],
            description: 'What to compute. profit/margin_pct require adequate cost-price coverage in the matched rows.',
          },
          groupBy: {
            type: 'string',
            enum: ['category', 'product', 'branch', 'customer_type', 'payment_method', 'day', 'week', 'month', 'quarter', 'day_of_week', 'is_weekend'],
            description: 'Optional — omit for a single overall total. Breaks the measure down by this dimension.',
          },
          filters: {
            type: 'object',
            description: 'Optional. Omit any key not needed.',
            properties: {
              dateFrom: { type: 'string', description: 'ISO date, inclusive' },
              dateTo: { type: 'string', description: 'ISO date, inclusive' },
              category: { type: 'string', description: 'Product category, partial match' },
              product: { type: 'string', description: 'Product name, partial match' },
              branch: { type: 'string', description: 'Branch name, partial match' },
              paymentMethod: { type: 'string', description: 'Cash, Transfer, POS, Insurance, or Credit' },
              customerType: { type: 'string', description: 'walk-in, hmo, corporate, nhis, or family' },
            },
          },
          n: { type: 'integer', description: 'Max groups to return when groupBy is set, default 20, max 100. Not a data limit — totalGroups always reports the true count.' },
          offset: { type: 'integer', description: 'Skip this many groups before returning — use for "ranked 21 to 50" style asks (offset:20 with n:30).' },
          sortDir: { type: 'string', enum: ['desc', 'asc'], description: "Ranking direction, default 'desc' (highest first). Use 'asc' for lowest/worst/bottom-N." },
          minValue: { type: 'number', description: 'Only include groups whose value is at least this.' },
          maxValue: { type: 'number', description: 'Only include groups whose value is at most this — e.g. maxValue:15 with measure margin_pct groupBy product for "products below 15% margin".' },
          scope: { type: 'string', enum: ['current', 'all'], description: "'current' (default) reads only the most recent upload. Only pass 'all' after the user has explicitly agreed to include historical/other uploads." },
        },
        required: ['measure'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getExecutiveBrief',
      description: 'The single consolidated executive summary: business health score/rating, an overall assessment, key supporting evidence, total estimated financial opportunity, the single highest-priority action, and confidence. Use for broad "how is my business doing" / "give me a summary" / "give me an overview" questions — prefer this over manually combining several other tools when the user wants a general summary.',
      parameters: { type: 'object', properties: {} },
    },
  },
  // ---- Business modeling layer -------------------------------------------
  // Planning and simulation, as opposed to the measurement every tool above
  // performs. These build ONLY on figures the validated tools already
  // returned; they compute no metric of their own.
  {
    type: 'function',
    function: {
      name: 'modelGoal',
      description: 'GOAL PLANNING — answers "how do I reach X?" / "how do I get revenue to ₦2M?" / "what would it take to double profit?". Takes a target figure and works backwards: reports the current state (from validated analytics), the gap, and the alternative levers that could close it, each sized independently — for revenue: transaction volume vs. average basket vs. both together; for profit: revenue growth vs. margin improvement vs. both. Every option carries its own explicit `assumptions` array which you MUST surface in your answer. Returns available:false naming exactly what is missing when the goal cannot be modelled (e.g. a profit goal with no trustworthy cost data). Works on inventory-only uploads too, modelling against potential revenue/profit from stock on hand. Defaults to the current upload. Do NOT use for "what is my revenue" — that is getRevenueProfitSummary.',
      parameters: {
        type: 'object',
        properties: {
          metric: { type: 'string', enum: ['revenue', 'profit'], description: 'Which figure the owner wants to move.' },
          target: { type: 'number', description: 'The figure they want to reach, in naira.' },
          scope: { type: 'string', enum: ['current', 'all'], description: "'current' (default) reads only the most recent upload. Only pass 'all' after the user has explicitly agreed to include historical/other uploads." },
        },
        required: ['metric', 'target'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'modelScenario',
      description: 'WHAT-IF SIMULATION — answers "what if I raise prices 10%?" / "what happens if sales grow 20%?" / "what if supplier costs go up 15%?". Applies ONE lever to the validated current state and returns projected revenue, gross profit and margin with deltas. Levers: price (volume held), volume, transactions, basket, cost (prices held). Every result carries an explicit `assumptions` array you MUST surface — particularly for `price`, which assumes zero customer response because this platform holds no elasticity data. When cost prices are missing or too thin, returns the revenue effect only with profitEffectAvailable:false rather than treating unknown cost as zero. Defaults to the current upload. For a per-product price change use simulatePriceChange instead; this models the whole business.',
      parameters: {
        type: 'object',
        properties: {
          lever: { type: 'string', enum: ['price', 'volume', 'transactions', 'basket', 'cost'], description: 'Which single driver changes.' },
          changePct: { type: 'number', description: 'Percentage change to apply: 10 for +10%, -5 for a 5% cut.' },
          scope: { type: 'string', enum: ['current', 'all'], description: "'current' (default) reads only the most recent upload. Only pass 'all' after the user has explicitly agreed to include historical/other uploads." },
        },
        required: ['lever', 'changePct'],
      },
    },
  },
];

const IMPLEMENTATIONS = {
  getRevenueProfitSummary: queries.getRevenueProfitSummary,
  getWeeklyRevenue: queries.getWeeklyRevenue,
  getGrowthTrend: queries.getGrowthTrend,
  getTopProducts: queries.getTopProducts,
  getCategoryPerformance: queries.getCategoryPerformance,
  getSlowMovers: queries.getSlowMovers,
  getProfitLeakage: queries.getProfitLeakage,
  getProductProfile: queries.getProductProfile,
  simulatePriceChange: queries.simulatePriceChange,
  getTopCustomers: queries.getTopCustomers,
  getFrequentlyBoughtTogether: queries.getFrequentlyBoughtTogether,
  getDataFields: queries.getDataFields,
  getUploadHistory: queries.getUploadHistory,
  getDatasetMetric: queries.getDatasetMetric,
  getLowStock: queries.getLowStock,
  getOverstock: queries.getOverstock,
  getExpirySummary: queries.getExpirySummary,
  getSupplierBreakdown: queries.getSupplierBreakdown,
  getBusinessHealth: queries.getBusinessHealth,
  getTopPriorities: queries.getTopPriorities,
  getRevenueTrendDrivers: queries.getRevenueTrendDrivers,
  getWeatherOutlook: queries.getWeatherOutlook,
  getDecisionOpportunities: queries.getDecisionOpportunities,
  getRecommendations: queries.getRecommendations,
  getExecutiveBrief: queries.getExecutiveBrief,
  getBusinessMetric: queries.getBusinessMetric,
  // Business modeling layer — additive, and deliberately kept in its own
  // module rather than advisorQueries.js: everything there measures what
  // happened, everything here projects what could.
  modelGoal: modeling.modelGoal,
  modelScenario: modeling.modelScenario,
};

async function runTool(organizationId, name, args) {
  const fn = IMPLEMENTATIONS[name];
  if (!fn) return { error: `Unknown tool: ${name}` };
  try {
    return await fn(organizationId, args || {});
  } catch (err) {
    return { error: `${name} failed: ${err.message}` };
  }
}

module.exports = { TOOLS, runTool };
