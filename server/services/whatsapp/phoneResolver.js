/**
 * Phone number -> whatsapp_contact row resolution.
 *
 * The webhook route has no Supabase bearer token — a phone number is the
 * only identity it gets. This finds or creates the whatsapp_contact row
 * for an incoming number, which carries onboarding_status and, once
 * onboarding completes, organization_id.
 */

const { getSql } = require('../db');

function normalizePhone(rawFrom) {
  // Twilio's `From` field looks like "whatsapp:+2348012345678" — store
  // just the E.164 number, not the channel prefix.
  return String(rawFrom || '').replace(/^whatsapp:/i, '').trim();
}

/**
 * @param {string} rawFrom - Twilio's raw `From` field
 * @returns {Promise<{id: string, phoneNumber: string, organizationId: string|null, onboardingStatus: string}>}
 */
async function resolveContact(rawFrom) {
  const phoneNumber = normalizePhone(rawFrom);
  if (!phoneNumber) throw new Error('resolveContact: missing phone number');

  const sql = getSql();
  const [existing] = await sql`
    select id, organization_id, onboarding_status from whatsapp_contact where phone_number = ${phoneNumber}
  `;
  if (existing) {
    await sql`update whatsapp_contact set last_message_at = now() where id = ${existing.id}`;
    return {
      id: existing.id,
      phoneNumber,
      organizationId: existing.organization_id,
      onboardingStatus: existing.onboarding_status,
    };
  }

  const [created] = await sql`
    insert into whatsapp_contact (phone_number, onboarding_status, last_message_at)
    values (${phoneNumber}, 'new', now())
    returning id, organization_id, onboarding_status
  `;
  return {
    id: created.id,
    phoneNumber,
    organizationId: created.organization_id,
    onboardingStatus: created.onboarding_status,
  };
}

async function setOnboardingStatus(contactId, status) {
  const sql = getSql();
  await sql`update whatsapp_contact set onboarding_status = ${status}, updated_at = now() where id = ${contactId}`;
}

async function linkContactToOrganization(contactId, organizationId) {
  const sql = getSql();
  await sql`
    update whatsapp_contact
    set organization_id = ${organizationId}, onboarding_status = 'complete', updated_at = now()
    where id = ${contactId}
  `;
}

module.exports = { normalizePhone, resolveContact, setOnboardingStatus, linkContactToOrganization };
