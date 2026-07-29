/**
 * Twilio REST client wrapper for outbound WhatsApp messages. Used for the
 * asynchronous reply after the webhook has already acknowledged Twilio with
 * empty TwiML — a full upload-processing pass can plausibly exceed
 * Twilio's webhook response timeout, so the real reply goes out via the
 * REST API instead of the synchronous TwiML response.
 */

const twilio = require('twilio');

// Twilio rejects any WhatsApp message body over 1600 characters
// (RestException code 21617) — confirmed against the real sandbox API.
const MAX_CHARS = 1600;

let client = null;
function getClient() {
  if (client) return client;
  client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return client;
}

function splitMessage(text) {
  if (text.length <= MAX_CHARS) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > MAX_CHARS) {
    let cut = remaining.lastIndexOf('\n', MAX_CHARS);
    if (cut <= 0) cut = MAX_CHARS;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

/**
 * @param {string} toPhoneNumber - E.164, no "whatsapp:" prefix
 * @param {string} text
 * @param {string} [mediaUrl] - attached only to the final message part
 */
async function sendWhatsappMessage(toPhoneNumber, text, mediaUrl = null) {
  const from = process.env.TWILIO_WHATSAPP_NUMBER;
  const to = `whatsapp:${toPhoneNumber}`;
  const parts = splitMessage(text);
  const sdk = getClient();

  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    await sdk.messages.create({
      from,
      to,
      body: parts[i],
      ...(isLast && mediaUrl ? { mediaUrl: [mediaUrl] } : {}),
    });
  }
}

/**
 * Shows WhatsApp's native "typing..." bubble to the user while a slow
 * question is being answered (Twilio's Typing Indicators API, public beta —
 * no SDK helper exists for it yet, so this is a raw REST call). Also marks
 * the referenced message as read. Disappears after ~25s or on delivery of
 * the real reply, whichever is first. Best-effort: if the account/number
 * doesn't have this beta feature enabled, fail silently rather than block
 * the actual response.
 *
 * @param {string} messageSid - the incoming message's SID (Twilio's `MessageSid` webhook field)
 */
async function sendTypingIndicator(messageSid) {
  if (!messageSid) return;
  try {
    const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const res = await fetch('https://messaging.twilio.com/v3/Indicators/Typing.json', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      // Twilio's own docs prose says lowercase "whatsapp", but the API
      // actually rejects that with a generic 400 — confirmed by testing
      // directly against a real message SID that only "WHATSAPP" works.
      body: JSON.stringify({ channel: 'WHATSAPP', messageId: messageSid }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[whatsapp] Typing indicator not sent (${res.status}): ${text.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn('[whatsapp] Typing indicator request failed:', err.message);
  }
}

module.exports = { sendWhatsappMessage, splitMessage, sendTypingIndicator };
