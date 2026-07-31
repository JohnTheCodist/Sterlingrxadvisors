/**
 * Holds a file mid-processing while we wait for the owner to answer one
 * clarifying question.
 *
 * A WhatsApp conversation is stateless between webhooks — each message is its
 * own HTTP request — so asking a question means parking the file somewhere
 * until the reply arrives. Stored as bytea with an expiry, the same shape
 * whatsapp_pdf_export already uses for the summary PDFs.
 *
 * One row per phone number, by primary key. A newly sent file replaces
 * whatever was waiting, so an unanswered question can never strand a later
 * upload behind it.
 */

const { getSql } = require('../db');

// Long enough to survive a pharmacist putting their phone down to serve a
// customer, short enough that a forgotten question doesn't reattach itself to
// an unrelated message tomorrow.
const TTL_HOURS = 6;

async function savePending(organizationId, phoneNumber, { fileData, filename, question }) {
  const sql = getSql();
  await sql`
    insert into whatsapp_pending_upload
      (phone_number, organization_id, file_data, filename, question, expires_at)
    values (
      ${phoneNumber}, ${organizationId}, ${fileData}, ${filename},
      ${sql.json(question)}, now() + ${`${TTL_HOURS} hours`}::interval
    )
    on conflict (phone_number) do update set
      organization_id = excluded.organization_id,
      file_data = excluded.file_data,
      filename = excluded.filename,
      question = excluded.question,
      created_at = now(),
      expires_at = excluded.expires_at
  `;
}

/**
 * The file waiting on this number, or null. Expired rows are treated as
 * absent and cleared on the way past, so a stale question never hijacks an
 * unrelated message.
 */
async function getPending(phoneNumber) {
  const sql = getSql();
  const [row] = await sql`
    select organization_id, file_data, filename, question, expires_at
    from whatsapp_pending_upload where phone_number = ${phoneNumber}
  `;
  if (!row) return null;
  if (new Date(row.expires_at) <= new Date()) {
    await clearPending(phoneNumber);
    return null;
  }
  return {
    organizationId: row.organization_id,
    fileData: row.file_data,
    filename: row.filename,
    question: row.question,
  };
}

async function clearPending(phoneNumber) {
  const sql = getSql();
  await sql`delete from whatsapp_pending_upload where phone_number = ${phoneNumber}`;
}

module.exports = { savePending, getPending, clearPending, TTL_HOURS };
