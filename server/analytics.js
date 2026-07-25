/**
 * Backwards-compatible re-export from services/analytics.
 * New code should require('./services/analytics') directly.
 */
const { analyze } = require('./services/analytics');
module.exports = { analyze };
