/**
 * Shared upload-file constants + spreadsheet parsing — extracted from
 * index.js so the WhatsApp media-download path can accept/parse the same
 * file types as the web upload flow without duplicating the allowlist.
 */

const path = require('path');
const xlsx = require('xlsx');

const ALLOWED_MIMES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/vnd.ms-excel',
  'text/plain',
  'application/octet-stream',
];
const ALLOWED_EXTS = ['.xlsx', '.csv'];

function isAllowedFile(filename, mimeType) {
  const ext = path.extname(filename || '').toLowerCase();
  return ALLOWED_MIMES.includes(mimeType) || ALLOWED_EXTS.includes(ext);
}

function parseSheet(buffer) {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const sheets = {};
  workbook.SheetNames.forEach((name) => {
    sheets[name] = xlsx.utils.sheet_to_json(workbook.Sheets[name], { defval: null });
  });
  return sheets;
}

module.exports = { ALLOWED_MIMES, ALLOWED_EXTS, isAllowedFile, parseSheet };
