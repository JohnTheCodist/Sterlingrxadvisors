/**
 * Tests for resuming an answer that hit the token cap.
 *
 * The reported symptom was Advisor answers stopping mid-sentence. Cause: the
 * agent loop's "no tool calls means we're done" branch never looked at
 * finish_reason, so a reply the provider truncated at max_tokens returned as
 * though it had finished naturally. The owner saw a sentence that just
 * stopped, and — worse — that half-answer was persisted to conversation
 * history as the complete reply.
 *
 * These stub the provider's streaming call rather than the network, so the
 * real loop logic runs: continuation counting, the tool-iteration budget
 * staying separate from it, and what actually gets returned for persistence.
 */

process.env.LLM_API_KEY = process.env.LLM_API_KEY || 'test-key';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@localhost:5432/test';

const Module = require('module');
const agentPath = require.resolve('../services/advisorAgent');
const queriesPath = require.resolve('../services/advisorQueries');
const toolsPath = require.resolve('../services/advisorTools');

let passed = 0, failed = 0;
const failures = [];
const section = (n) => console.log(`\n=== ${n} ===`);
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log(`  ok    ${name}`); })
    .catch((e) => { failed++; failures.push({ name, message: e.message }); console.log(`  FAIL  ${name}\n        ${e.message}`); });
}
const assert = (c, m) => { if (!c) throw new Error(m || 'Assertion failed'); };
const eq = (a, e, m) => { if (a !== e) throw new Error(`${m || 'mismatch'}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); };

const ORG = '11111111-1111-1111-1111-111111111111';

/**
 * Loads a fresh advisorAgent with global.fetch stubbed to replay a scripted
 * sequence of provider responses. Each script entry is either
 * { content, finishReason } or { toolCall: 'name' }.
 */
function withScriptedLlm(script, fn) {
  const realFetch = global.fetch;
  const realQueries = require.cache[queriesPath];
  const realTools = require.cache[toolsPath];
  let callIndex = 0;
  const sentBodies = [];

  require.cache[queriesPath] = {
    id: queriesPath, filename: queriesPath, loaded: true,
    exports: { getDataScope: async () => null },
  };
  require.cache[toolsPath] = {
    id: toolsPath, filename: toolsPath, loaded: true,
    exports: { TOOLS: [], runTool: async () => ({ ok: true }) },
  };

  global.fetch = async (url, opts) => {
    const step = script[Math.min(callIndex, script.length - 1)];
    sentBodies.push(JSON.parse(opts.body));
    callIndex++;

    const chunks = [];
    if (step.toolCall) {
      chunks.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: step.toolCall, arguments: '{}' } }] } }] });
      chunks.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      for (const ch of step.content.match(/.{1,12}/g) || []) {
        chunks.push({ choices: [{ delta: { content: ch } }] });
      }
      chunks.push({ choices: [{ delta: {}, finish_reason: step.finishReason || 'stop' }] });
    }

    const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    const encoder = new TextEncoder();
    // The implementation consumes `response.body` with `for await`, so the
    // stub has to be async-iterable — not a getReader()-style stream.
    return {
      ok: true,
      status: 200,
      body: {
        async *[Symbol.asyncIterator]() {
          yield encoder.encode(body);
        },
      },
    };
  };

  delete require.cache[agentPath];
  const agent = require('../services/advisorAgent');

  return Promise.resolve(fn(agent, () => ({ callCount: callIndex, sentBodies })))
    .finally(() => {
      global.fetch = realFetch;
      require.cache[queriesPath] = realQueries;
      require.cache[toolsPath] = realTools;
      delete require.cache[agentPath];
    });
}

async function main() {
  section('A capped answer is resumed, not returned half-finished');

  await test('finish_reason "length" triggers a continuation request', async () => {
    await withScriptedLlm(
      [
        { content: 'Your revenue grew because', finishReason: 'length' },
        { content: ' of higher basket size.', finishReason: 'stop' },
      ],
      async (agent, stats) => {
        const { reply } = await agent.chatStream(ORG, [{ role: 'user', content: 'why?' }]);
        eq(stats().callCount, 2, 'a second call must be made to resume');
        assert(reply.includes('Your revenue grew because'), 'first segment retained');
        assert(reply.includes('of higher basket size.'), 'continuation appended');
      },
    );
  });

  await test('the resumed reply persists the WHOLE answer, not just the last segment', async () => {
    // The subtle half of the bug: message.content after a continuation holds
    // only the final segment, so returning it would persist a reply missing
    // its own opening — even though the owner watched the whole thing stream.
    await withScriptedLlm(
      [
        { content: 'OPENING-PARAGRAPH.', finishReason: 'length' },
        { content: ' CLOSING-PARAGRAPH.', finishReason: 'stop' },
      ],
      async (agent) => {
        const { reply } = await agent.chatStream(ORG, [{ role: 'user', content: 'q' }]);
        assert(reply.startsWith('OPENING-PARAGRAPH.'), `lost the opening: ${reply}`);
        assert(reply.includes('CLOSING-PARAGRAPH.'), 'lost the closing');
      },
    );
  });

  await test('the continuation instruction tells it not to repeat itself', async () => {
    await withScriptedLlm(
      [
        { content: 'part one', finishReason: 'length' },
        { content: 'part two', finishReason: 'stop' },
      ],
      async (agent, stats) => {
        await agent.chatStream(ORG, [{ role: 'user', content: 'q' }]);
        const second = stats().sentBodies[1];
        const last = second.messages[second.messages.length - 1];
        eq(last.role, 'user');
        assert(/do not repeat/i.test(last.content), 'must instruct against repetition');
        assert(/continue/i.test(last.content), 'must instruct to continue');
      },
    );
  });

  await test('an answer that finishes normally makes exactly one call', async () => {
    await withScriptedLlm(
      [{ content: 'Short and complete.', finishReason: 'stop' }],
      async (agent, stats) => {
        const { reply } = await agent.chatStream(ORG, [{ role: 'user', content: 'q' }]);
        eq(stats().callCount, 1, 'no continuation for a completed answer');
        eq(reply, 'Short and complete.');
      },
    );
  });

  section('Bounded, and honest when it runs out');

  await test('continuations stop at the cap rather than looping forever', async () => {
    // Every response claims truncation — without a bound this never ends.
    await withScriptedLlm(
      [{ content: 'more and more', finishReason: 'length' }],
      async (agent, stats) => {
        const { reply } = await agent.chatStream(ORG, [{ role: 'user', content: 'q' }]);
        assert(stats().callCount <= 4, `runaway loop: ${stats().callCount} calls`);
        assert(/cut here|unusually long/i.test(reply), `should disclose it was cut: ${reply}`);
      },
    );
  });

  await test('exhausting continuations keeps the real answer instead of replacing it', async () => {
    await withScriptedLlm(
      [{ content: 'REAL-EVIDENCED-CONTENT', finishReason: 'length' }],
      async (agent) => {
        const { reply } = await agent.chatStream(ORG, [{ role: 'user', content: 'q' }]);
        assert(reply.includes('REAL-EVIDENCED-CONTENT'),
          'must not discard an answer the owner already saw in favour of a generic message');
        assert(!/too many steps/i.test(reply),
          'the "too many steps" message is for tool exhaustion, not a long answer');
      },
    );
  });

  section('Continuation calls skip the tool schemas');

  await test('the resume request omits tools, the first request keeps them', async () => {
    // ~6,000 tokens of schemas re-sent to say "keep writing" is pure latency
    // on every long answer, and cannot change the outcome.
    await withScriptedLlm(
      [
        { content: 'first half', finishReason: 'length' },
        { content: ' second half', finishReason: 'stop' },
      ],
      async (agent, stats) => {
        await agent.chatStream(ORG, [{ role: 'user', content: 'q' }]);
        const [first, second] = stats().sentBodies;
        assert('tools' in first, 'the initial call must offer tools');
        assert(!('tools' in second), 'the continuation must not re-send tool schemas');
        assert(!('tool_choice' in second), 'tool_choice is meaningless without tools');
      },
    );
  });

  section('Continuations do not eat the tool-call budget');

  await test('a tool call followed by a capped answer still resumes', async () => {
    // If continuations and tool iterations shared one counter, a question that
    // needed evidence AND produced a long answer would fail for the wrong
    // reason — running out of "steps" when it had only taken one.
    await withScriptedLlm(
      [
        { toolCall: 'getRevenueProfitSummary' },
        { content: 'Based on that data,', finishReason: 'length' },
        { content: ' revenue rose 12%.', finishReason: 'stop' },
      ],
      async (agent, stats) => {
        const { reply, toolCalls } = await agent.chatStream(ORG, [{ role: 'user', content: 'q' }]);
        eq(stats().callCount, 3, 'tool call + capped answer + continuation');
        eq(toolCalls.length, 1, 'the tool call is still recorded');
        assert(reply.includes('Based on that data,') && reply.includes('revenue rose 12%.'),
          `both segments expected: ${reply}`);
      },
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
    process.exit(1);
  }
}

main();
