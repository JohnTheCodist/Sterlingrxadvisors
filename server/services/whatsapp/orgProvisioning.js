/**
 * Creates a brand-new pharmacy account entirely from WhatsApp — no website
 * visit required. Mirrors POST /api/organizations (organizations + owner
 * membership), but the "user" side is a phone-based Supabase Auth account
 * instead of an already-signed-in bearer token, since WhatsApp never gives
 * us one.
 */

const { getSupabaseClient } = require('../supabaseClient');
const { getSql } = require('../db');
const { linkContactToOrganization } = require('./phoneResolver');

/**
 * @param {string} phoneNumber - E.164, no "whatsapp:" prefix
 * @param {string} pharmacyName
 * @param {string} contactId - whatsapp_contact.id, to link once provisioning succeeds
 * @returns {Promise<{organizationId: string, userId: string}>}
 */
async function provisionFromWhatsapp(phoneNumber, pharmacyName, contactId) {
  const supabase = getSupabaseClient();
  const db = getSql();

  // Reuse an existing shadow account rather than blindly creating one.
  // createUser() hard-fails with "Phone number already registered by
  // another user" whenever an auth user for this number already exists —
  // which happens any time the auth account outlives its organization
  // (organizations were wiped, the org was deleted, a failed run). That
  // surfaced to the owner as a bare "something went wrong" with no way
  // out. Supabase stores the number WITHOUT the leading "+", so match on
  // the bare form.
  const bareNumber = phoneNumber.replace(/^\+/, '');
  const [existingUser] = await db`select id from auth.users where phone = ${bareNumber}`;

  let userId;
  if (existingUser) {
    userId = existingUser.id;
  } else {
    const { data: userData, error: userErr } = await supabase.auth.admin.createUser({
      phone: phoneNumber,
      phone_confirm: true,
    });
    if (userErr) throw new Error(`Failed to create shadow account: ${userErr.message}`);
    userId = userData.user.id;
  }

  const [org] = await db`insert into organizations (name) values (${pharmacyName.trim()}) returning id`;
  await db`insert into organization_members (organization_id, user_id, role) values (${org.id}, ${userId}, 'owner')`;

  await linkContactToOrganization(contactId, org.id);

  return { organizationId: org.id, userId };
}

module.exports = { provisionFromWhatsapp };
