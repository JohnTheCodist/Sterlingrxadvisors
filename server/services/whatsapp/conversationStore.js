/**
 * Reads/writes whatsapp_message — the conversation history chatStream()
 * needs, capped at the last WHATSAPP_HISTORY_TURNS turns (default ~20),
 * same role as the web AdvisorChat's in-memory history but persisted per
 * phone number since a WhatsApp chat has no client-side session.
 */

const { getSql } = require('../db');

const HISTORY_TURNS = Number(process.env.WHATSAPP_HISTORY_TURNS) || 20;

async function appendMessage(organizationId, phoneNumber, role, content) {
  const sql = getSql();
  await sql`
    insert into whatsapp_message (organization_id, phone_number, role, content)
    values (${organizationId}, ${phoneNumber}, ${role}, ${content})
  `;
}

/**
 * @returns {Promise<{role: string, content: string}[]>} oldest-first, ready for chatStream()
 */
async function getRecentHistory(organizationId, phoneNumber) {
  const sql = getSql();
  const rows = await sql`
    select role, content from whatsapp_message
    where organization_id = ${organizationId} and phone_number = ${phoneNumber}
    order by created_at desc
    limit ${HISTORY_TURNS}
  `;
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

module.exports = { appendMessage, getRecentHistory };
