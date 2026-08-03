/**
 * Where LLM requests are sent, and with whose credentials.
 *
 * Two deployments share this one server codebase:
 *
 *   direct (default)  The cloud/web product. The server holds LLM_API_KEY and
 *                     calls the provider itself. This is exactly what shipped
 *                     before this module existed.
 *
 *   relay             The desktop product. The app runs on a pharmacy's own PC,
 *                     where any bundled API key could be read straight out of
 *                     the Electron bundle, so there is none. Requests carry a
 *                     licence key to our relay, which holds the real provider
 *                     key, checks the subscription, meters usage, and streams
 *                     the provider's response back untouched.
 *
 * The request BODY is byte-identical in both modes and the response stream is
 * forwarded verbatim, so callers cannot tell the difference. That matters more
 * than it looks: advisorAgent.js depends on the exact SSE shape, on prompt
 * caching of a stable prefix, and on `usage` arriving in the final chunk. A
 * relay that reformatted anything would break all three.
 *
 * Splitting this into a branch or a fork was the alternative, and the reason
 * against it is maintenance: every fix would have to land twice, forever.
 * One codebase, one switch.
 */

const LLM_MODE = (process.env.LLM_MODE || 'direct').toLowerCase();
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_API_URL = process.env.LLM_API_URL || 'https://api.openai.com/v1/chat/completions';
const RELAY_URL = process.env.RELAY_URL || '';
const LICENSE_KEY = process.env.LICENSE_KEY || '';

/**
 * Relay mode has to be asked for explicitly AND be usable. A half-configured
 * relay must not silently disable the Advisor for the cloud product, so
 * anything short of both settings falls back to direct.
 */
function isRelayMode() {
  return LLM_MODE === 'relay' && Boolean(RELAY_URL);
}

/**
 * The URL and headers for one chat-completion request.
 * Callers keep building the body themselves — this decides only the envelope.
 *
 * @returns {{ url: string, headers: Record<string,string>, mode: 'direct'|'relay' }}
 */
function chatEndpoint() {
  if (isRelayMode()) {
    return {
      url: `${RELAY_URL.replace(/\/+$/, '')}/v1/llm/chat`,
      headers: {
        'Content-Type': 'application/json',
        // No provider key exists on this machine by design. The licence key
        // identifies the pharmacy; the relay supplies the real credential.
        'X-License-Key': LICENSE_KEY,
      },
      mode: 'relay',
    };
  }
  return {
    url: LLM_API_URL,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    mode: 'direct',
  };
}

/**
 * Whether the Advisor can run at all. Direct mode needs a provider key; relay
 * mode needs a licence key. Callers already gate on LLM_API_KEY being present,
 * so relay deployments need this to answer for them.
 */
function isConfigured() {
  return isRelayMode() ? Boolean(LICENSE_KEY) : Boolean(LLM_API_KEY);
}

module.exports = { chatEndpoint, isRelayMode, isConfigured, LLM_MODE };
