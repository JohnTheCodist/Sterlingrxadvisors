/**
 * Downloads a media attachment Twilio told us about in the webhook body
 * (MediaUrl0/MediaContentType0). Twilio's media URLs require HTTP Basic
 * Auth with the same Account SID/Auth Token used to sign the webhook.
 */

const { isAllowedFile } = require('../fileUpload');

const MAX_BYTES = 15 * 1024 * 1024; // WhatsApp's own media cap is 16MB; stay under it

async function downloadMedia(mediaUrl, contentType, filenameHint = 'upload') {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) throw new Error('Twilio credentials not configured');

  if (!isAllowedFile(filenameHint, contentType)) {
    throw new Error(`Unsupported file type: ${contentType}`);
  }

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const response = await fetch(mediaUrl, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to download media: ${response.status} ${response.statusText}`);
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength && contentLength > MAX_BYTES) {
    throw new Error('File is too large (max 15MB).');
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length > MAX_BYTES) {
    throw new Error('File is too large (max 15MB).');
  }

  return buffer;
}

module.exports = { downloadMedia, MAX_BYTES };
