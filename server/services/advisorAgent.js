/**
 * AI Advisor — conversational analyst.
 *
 * Runs a multi-step tool-calling loop against the same OpenAI-compatible
 * LLM already used by analysisAgent.js (same env vars, same "never invent
 * data" discipline) — but instead of a single one-shot prompt, the model
 * can call real data tools (advisorTools.js), read the result, and call
 * another tool before answering. This is what lets it handle questions
 * that weren't anticipated in advance, and answer with real numbers
 * instead of guessing.
 */

const { TOOLS, runTool } = require('./advisorTools');

const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_API_URL = process.env.LLM_API_URL || 'https://api.openai.com/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '30000', 10);

const MAX_TOOL_ITERATIONS = 5;

function buildSystemPrompt() {
  const today = new Date().toISOString().substring(0, 10);
  return `You are a senior pharmacy business analyst for a Nigerian independent pharmacy, chatting directly with the pharmacy owner. Today's date is ${today}.

## How to answer
You have tools that query the pharmacy's real, cleaned sales/inventory data. For any question that needs a number, call the relevant tool(s) first — never state a number you didn't get from a tool. You may call more than one tool in sequence to answer a compound or "why"/"what if" question (e.g. look up a product, then simulate a price change, then compare it to total revenue).

For substantive questions, structure the answer as:
1. What happened — the fact, with real numbers.
2. Why (if relevant) — what's driving it, using specific products/months from the tool results.
3. So what — the business impact in naira, units, or customers.
4. What next — a concrete, specific recommendation, if one is warranted.
Keep it conversational and concise — you're chatting, not writing a report. Skip steps that don't apply to a simple lookup question.

## Rules
1. Only state numbers/facts returned by a tool. Never invent or estimate a number a tool didn't give you.
2. Any projected/simulated number (e.g. from simulatePriceChange) must state its assumption explicitly, in plain language — don't present a projection as certain.
3. If getProductProfile or getFrequentlyBoughtTogether returns ambiguous:true with candidates, ask the user which one they meant instead of guessing.
4. If a tool returns estimated:true, say so plainly (e.g. "based on sales velocity, since no stock-count data was uploaded") rather than presenting it as an exact figure.
5. If a question is outside what any tool can answer (e.g. asking about competitors, market conditions, or anything not in this pharmacy's own data), say so directly and plainly. Then check getTopPriorities() — if something there is genuinely topically related to what they asked about, mention it as something they can act on. Do not force a connection if nothing is actually related.
6. Be specific: name real products, real naira amounts, real percentages from tool results — never "a product" or "a lot".
7. Nigerian pharmacy context: typical margins are 20-40%, cash is a dominant payment method, top 3 products often drive 40-60% of revenue.`;
}

async function callLlm(messages) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const response = await fetch(LLM_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
        max_tokens: 1024,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`LLM API returned ${response.status}: ${text.slice(0, 300)}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Runs the tool-calling loop for one user turn.
 * @param {Array<{role: string, content: string}>} history - prior conversation (client-held)
 * @returns {Promise<{reply: string, toolCalls: string[]}>}
 */
async function chat(history) {
  if (!LLM_API_KEY) {
    return {
      reply: 'The AI Advisor needs an LLM API key configured on the server (LLM_API_KEY) before it can answer questions.',
      toolCalls: [],
    };
  }

  const messages = [{ role: 'system', content: buildSystemPrompt() }, ...history];
  const toolCallsUsed = [];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    let data;
    try {
      data = await callLlm(messages);
    } catch (err) {
      return { reply: `Sorry, I couldn't reach the AI service (${err.message}). Try again in a moment.`, toolCalls: toolCallsUsed };
    }

    const message = data.choices?.[0]?.message;
    if (!message) {
      return { reply: 'Sorry, I got an unexpected response from the AI service.', toolCalls: toolCallsUsed };
    }

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return { reply: message.content || "I wasn't able to come up with an answer.", toolCalls: toolCallsUsed };
    }

    messages.push(message);

    for (const call of message.tool_calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) { /* leave empty */ }
      toolCallsUsed.push(call.function.name);
      const result = runTool(call.function.name, args);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  return {
    reply: "I needed too many steps to answer that confidently — could you ask it more specifically, e.g. about one product or one time period?",
    toolCalls: toolCallsUsed,
  };
}

module.exports = { chat };
