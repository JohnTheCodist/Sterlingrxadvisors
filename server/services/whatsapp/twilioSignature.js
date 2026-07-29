/**
 * Twilio webhook signature verification.
 *
 * A public unauthenticated endpoint (/webhooks/whatsapp) needs its own
 * security boundary since it can't go through requireAuth (no Supabase
 * bearer token exists for an incoming WhatsApp message). Twilio signs
 * every webhook request with X-Twilio-Signature, computed from the exact
 * request URL + form body — this middleware verifies that signature and
 * rejects anything that isn't genuinely from Twilio before any handler runs.
 */

const twilio = require('twilio');

function verifyTwilioSignature(req, res, next) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error('[whatsapp] TWILIO_AUTH_TOKEN not configured — rejecting webhook.');
    return res.status(503).send('WhatsApp channel not configured.');
  }

  const signature = req.headers['x-twilio-signature'];
  const publicBaseUrl = process.env.PUBLIC_BASE_URL;
  if (!signature || !publicBaseUrl) {
    return res.status(403).send('Missing signature or server misconfiguration.');
  }

  // Twilio signs the exact public URL it called, not whatever Express sees
  // behind a proxy/tunnel — reconstruct it from the configured public origin.
  const url = `${publicBaseUrl.replace(/\/$/, '')}${req.originalUrl}`;

  const valid = twilio.validateRequest(authToken, signature, url, req.body || {});
  if (!valid) {
    console.warn('[whatsapp] Rejected webhook with invalid Twilio signature.');
    return res.status(403).send('Invalid signature.');
  }

  next();
}

module.exports = { verifyTwilioSignature };
