/**
 * Orchestrates one incoming WhatsApp message: resolve contact -> branch on
 * onboarding / file upload / business question -> acknowledge Twilio
 * immediately with empty TwiML -> process (potentially slow) work
 * asynchronously -> send the real reply via the REST API. A full
 * normalize-and-analyze pass can plausibly exceed Twilio's webhook
 * response timeout, so nothing slow happens before the ack.
 */

const { getSql } = require('../db');
const { resolveContact } = require('./phoneResolver');
const { handleOnboarding } = require('./onboarding');
const { downloadMedia } = require('./mediaDownloader');
const { processUpload } = require('./uploadPipeline');
const { buildSummaryText } = require('./summaryText');
const { buildSummaryPdf } = require('./pdfSummary');
const { storePdfExport, buildPublicUrl, fetchPdfExport } = require('./pdfLink');
const { appendMessage, getRecentHistory } = require('./conversationStore');
const { sendWhatsappMessage, sendTypingIndicator } = require('./messageSender');
const { formatForWhatsapp } = require('./formatForWhatsapp');
const { chatStream } = require('../advisorAgent');

// No rate-limiting middleware exists anywhere in this codebase yet — this is
// a basic per-phone-number cap (messages/hour) as a sensible default against
// abuse, not a full solution. In-memory is fine: worst case a restart resets
// everyone's count.
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const rateLimitState = new Map();

function isRateLimited(phoneNumber) {
  const now = Date.now();
  const entry = rateLimitState.get(phoneNumber);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitState.set(phoneNumber, { count: 1, windowStart: now });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

async function getOrganizationName(organizationId) {
  const sql = getSql();
  const [org] = await sql`select name from organizations where id = ${organizationId}`;
  return org?.name || 'Your Pharmacy';
}

async function handleFileUpload(organizationId, phoneNumber, body) {
  await sendTypingIndicator(body.MessageSid);
  // processUpload can take a while on a real file (many rows, network
  // round-trips to Postgres) — without this, a question asked mid-upload
  // finds no data yet and reads as a silent failure, not a job in progress.
  await sendWhatsappMessage(phoneNumber, "Got your file — analyzing it now, this'll take a moment. I'll send your summary as soon as it's ready.");

  const buffer = await downloadMedia(body.MediaUrl0, body.MediaContentType0);
  const result = await processUpload(organizationId, buffer);

  const pharmacyName = await getOrganizationName(organizationId);
  const summaryText = buildSummaryText(result);
  const pdfBuffer = await buildSummaryPdf(pharmacyName, result);

  const exportId = await storePdfExport(organizationId, `${pharmacyName.replace(/\W+/g, '_')}_summary.pdf`, pdfBuffer);
  const pdfUrl = buildPublicUrl(exportId);

  await sendWhatsappMessage(phoneNumber, summaryText, pdfUrl);
}

async function handleTextQuestion(organizationId, phoneNumber, messageBody, messageSid) {
  if (!messageBody.trim()) {
    await sendWhatsappMessage(phoneNumber, 'Send me a business question, or a sales file (Excel/CSV) to analyze.');
    return;
  }

  // The tool-calling loop can take a few seconds (data lookups, sometimes
  // more than one in sequence) — the typing bubble tells the user Alafia
  // is working instead of leaving them staring at silence.
  await sendTypingIndicator(messageSid);

  await appendMessage(organizationId, phoneNumber, 'user', messageBody);
  const history = await getRecentHistory(organizationId, phoneNumber);
  const { reply } = await chatStream(organizationId, history, null, 'whatsapp');
  await appendMessage(organizationId, phoneNumber, 'assistant', reply);

  await sendWhatsappMessage(phoneNumber, formatForWhatsapp(reply));
}

async function processIncomingMessage(body) {
  const contact = await resolveContact(body.From);
  const { phoneNumber } = contact;

  if (isRateLimited(phoneNumber)) {
    await sendWhatsappMessage(phoneNumber, "You've sent a lot of messages in the last hour — please try again shortly.");
    return;
  }

  const onboardingResult = await handleOnboarding(contact, body.Body || '');
  if (onboardingResult.handled) {
    await sendWhatsappMessage(phoneNumber, onboardingResult.reply);
    return;
  }

  const organizationId = onboardingResult.organizationId;
  const numMedia = parseInt(body.NumMedia || '0', 10);

  if (numMedia > 0) {
    await handleFileUpload(organizationId, phoneNumber, body);
  } else {
    await handleTextQuestion(organizationId, phoneNumber, body.Body || '', body.MessageSid);
  }
}

/**
 * Express handler for POST /webhooks/whatsapp. Twilio signature verification
 * runs as middleware before this — by the time this executes, the request
 * is confirmed genuine.
 */
function handleIncomingWhatsapp(req, res) {
  res.set('Content-Type', 'text/xml');
  res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

  const body = req.body || {};
  processIncomingMessage(body).catch(async (err) => {
    console.error('[whatsapp] Failed to process incoming message:', err);
    try {
      const phoneNumber = String(body.From || '').replace(/^whatsapp:/i, '').trim();
      if (phoneNumber) {
        await sendWhatsappMessage(phoneNumber, "Sorry, something went wrong processing that. Please try again in a moment.");
      }
    } catch (sendErr) {
      console.error('[whatsapp] Failed to send error notice:', sendErr);
    }
  });
}

/**
 * Express handler for GET /pdf/whatsapp/:id — the short-lived, unguessable
 * link Twilio fetches to relay the generated PDF as a media attachment.
 */
async function servePdfExport(req, res) {
  const record = await fetchPdfExport(req.params.id);
  if (!record) {
    return res.status(404).send('This link has expired or does not exist.');
  }
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${record.filename}"`);
  res.send(record.pdfData);
}

module.exports = { handleIncomingWhatsapp, servePdfExport };
