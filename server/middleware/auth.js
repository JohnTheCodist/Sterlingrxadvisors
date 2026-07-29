/**
 * Auth middleware — verifies a Supabase access token and resolves the
 * caller's real organization membership, scoping every downstream request.
 *
 * Two variants:
 *   - requireAuth: valid token AND at least one real organization
 *     membership required. Attaches req.user, req.organizationId,
 *     req.organizationRole. This is the default for almost every /api/*
 *     route once wired into server/index.js.
 *   - requireAuthOnly: valid token required, but no membership required —
 *     used only by the org-creation endpoint, since a brand-new user is
 *     about to create their first organization and doesn't have one yet.
 *
 * v1 has no org switcher (see the migration plan) — a user has exactly one
 * organization, auto-selected as memberships[0]. An X-Organization-Id
 * header is still accepted and honored IF it matches a real membership row,
 * so a switcher can be added later without touching this file again — but
 * a header claiming an organization the caller doesn't actually belong to
 * is rejected, never trusted at face value.
 */

const { getSupabaseClient } = require('../services/supabaseClient');
const { getMembershipsForUser } = require('../services/db');

function extractToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

async function verifyUser(req, res) {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return null;
  }
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return null;
  }
  return data.user;
}

async function requireAuthOnly(req, res, next) {
  const user = await verifyUser(req, res);
  if (!user) return; // response already sent by verifyUser
  req.user = user;
  next();
}

async function requireAuth(req, res, next) {
  const user = await verifyUser(req, res);
  if (!user) return;
  req.user = user;

  const memberships = await getMembershipsForUser(user.id);
  if (memberships.length === 0) {
    return res.status(403).json({ error: 'No organization membership. Create an organization first.' });
  }

  const requestedOrgId = req.headers['x-organization-id'];
  const match = requestedOrgId
    ? memberships.find((m) => m.organization_id === requestedOrgId)
    : memberships[0];

  if (!match) {
    return res.status(403).json({ error: 'Not a member of the requested organization.' });
  }

  req.organizationId = match.organization_id;
  req.organizationRole = match.role;
  next();
}

module.exports = { requireAuth, requireAuthOnly };
