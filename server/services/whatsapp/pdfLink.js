/**
 * Short-lived PDF hosting so Twilio can fetch a generated summary and
 * relay it as a WhatsApp media attachment. A DB row (not an in-memory Map)
 * so it survives a server restart. No cron infrastructure exists in this
 * codebase yet, so expired rows are lazy-deleted on next read rather than
 * on a schedule.
 */

const { getSql } = require('../db');

const TTL_MINUTES = Number(process.env.WHATSAPP_PDF_LINK_TTL_MINUTES) || 30;

/**
 * @returns {Promise<string>} the export id (URL token)
 */
async function storePdfExport(organizationId, filename, pdfBuffer) {
  const sql = getSql();
  const [row] = await sql`
    insert into whatsapp_pdf_export (organization_id, filename, pdf_data, expires_at)
    values (${organizationId}, ${filename}, ${pdfBuffer}, now() + (${TTL_MINUTES} * interval '1 minute'))
    returning id
  `;
  return row.id;
}

function buildPublicUrl(exportId) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return `${base}/pdf/whatsapp/${exportId}`;
}

/**
 * @returns {Promise<{filename: string, pdfData: Buffer}|null>} null if not found or expired
 */
async function fetchPdfExport(exportId) {
  const sql = getSql();
  await sql`delete from whatsapp_pdf_export where expires_at < now()`;

  const [row] = await sql`
    select filename, pdf_data from whatsapp_pdf_export where id = ${exportId} and expires_at >= now()
  `;
  if (!row) return null;
  return { filename: row.filename, pdfData: row.pdf_data };
}

module.exports = { storePdfExport, buildPublicUrl, fetchPdfExport };
