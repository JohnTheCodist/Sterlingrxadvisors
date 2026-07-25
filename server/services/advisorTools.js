/**
 * AI Advisor — tool schemas (OpenAI-style function calling) + dispatch.
 *
 * Each tool is a thin, named wrapper around a advisorQueries.js function.
 * The LLM never sees raw SQL or gets free-form data access — it can only
 * call one of these named, typed functions, and every result it can talk
 * about comes back through here.
 */

const queries = require('./advisorQueries');

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'getRevenueProfitSummary',
      description: 'Total revenue, gross profit, gross margin, quantity sold, transaction count for all data on record. Use for "how much did I sell/make" style questions.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getWeeklyRevenue',
      description: 'Revenue, profit, and transaction count broken down by week. Use for "this week" / "last week" style questions.',
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
      description: 'Revenue, profit, and margin by product category. Use for "which category performs best".',
      parameters: { type: 'object', properties: {} },
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
      description: 'Products with margin below a threshold, ordered by revenue (biggest naira impact first). Use for "where am I losing profit".',
      parameters: {
        type: 'object',
        properties: {
          marginThreshold: { type: 'number', description: 'Margin percent below which a product counts as leaking profit, default 15' },
          n: { type: 'integer', description: 'Max products to return, default 10' },
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
      name: 'getLowStock',
      description: 'Products running low on stock. Uses real stock-level data if an inventory dataset was uploaded (estimated:false); otherwise falls back to a sales-velocity estimate (estimated:true) — say so if estimated. Use for "which products are running low", "what should I reorder today".',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getOverstock',
      description: 'Products that are overstocked relative to how fast they sell (estimated:true — always a velocity-based proxy in this dataset). Use for "which products are overstocked".',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getExpirySummary',
      description: 'Products approaching or past expiry, if expiry-date data was uploaded. Returns available:false if not. Use for "which products are expiring soon".',
      parameters: { type: 'object', properties: {} },
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
  getLowStock: queries.getLowStock,
  getOverstock: queries.getOverstock,
  getExpirySummary: queries.getExpirySummary,
  getBusinessHealth: queries.getBusinessHealth,
  getTopPriorities: queries.getTopPriorities,
  getRevenueTrendDrivers: queries.getRevenueTrendDrivers,
};

function runTool(name, args) {
  const fn = IMPLEMENTATIONS[name];
  if (!fn) return { error: `Unknown tool: ${name}` };
  try {
    return fn(args || {});
  } catch (err) {
    return { error: `${name} failed: ${err.message}` };
  }
}

module.exports = { TOOLS, runTool };
