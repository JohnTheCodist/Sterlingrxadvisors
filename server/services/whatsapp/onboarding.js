/**
 * new -> awaiting_pharmacy_name -> complete state machine. Everything else
 * (file uploads, business questions) is gated behind reaching "complete"
 * first — simplest rule, avoids edge cases like "which org does this
 * upload belong to" for a half-onboarded contact.
 */

const { setOnboardingStatus } = require('./phoneResolver');
const { provisionFromWhatsapp } = require('./orgProvisioning');

const WELCOME =
  "Welcome to SterlingRx Advisors! I'm Alafia, your pharmacy business assistant. " +
  "What's your pharmacy called?";

const ASK_AGAIN = "Sorry, I didn't catch a name. What's your pharmacy called?";

// A bare "hi"/"ok" reply to the welcome question is almost always the user
// greeting back rather than answering it — re-ask instead of silently
// creating an account named "Hi".
const GREETING_WORDS = new Set(['hi', 'hello', 'hey', 'ok', 'okay', 'yes', 'yo', 'sup']);
const NOT_A_NAME = "That doesn't look like a pharmacy name — what should I call your pharmacy?";

const DONE = (name) =>
  `Thanks — "${name}" is set up. Send me your sales file (Excel or CSV) any time and I'll process it, ` +
  `or just ask me a business question.`;

/**
 * @param {{id: string, phoneNumber: string, onboardingStatus: string}} contact
 * @param {string} messageBody - raw incoming text (may be empty if this message was media)
 * @returns {Promise<{handled: boolean, reply: string|null, organizationId: string|null}>}
 *   handled=false means onboarding is already complete and the caller should
 *   proceed to normal message handling.
 */
async function handleOnboarding(contact, messageBody) {
  if (contact.onboardingStatus === 'complete' && contact.organizationId) {
    return { handled: false, reply: null, organizationId: contact.organizationId };
  }

  if (contact.onboardingStatus === 'new') {
    await setOnboardingStatus(contact.id, 'awaiting_pharmacy_name');
    return { handled: true, reply: WELCOME, organizationId: null };
  }

  // awaiting_pharmacy_name
  const name = (messageBody || '').trim();
  if (!name) {
    return { handled: true, reply: ASK_AGAIN, organizationId: null };
  }
  if (GREETING_WORDS.has(name.toLowerCase())) {
    return { handled: true, reply: NOT_A_NAME, organizationId: null };
  }

  const { organizationId } = await provisionFromWhatsapp(contact.phoneNumber, name, contact.id);
  return { handled: true, reply: DONE(name), organizationId };
}

module.exports = { handleOnboarding };
