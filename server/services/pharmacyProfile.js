/**
 * Pharmacy Profile — minimal single-location settings store, now backed by
 * Postgres's organization_profile table (one row per organization) instead
 * of a single shared JSON file. v1 of the platform is explicitly
 * single-location, so this only carries `state` (needed for weather
 * lookups); city/coordinates can be added later without touching the star
 * schema.
 */

const { getSql, assertOrgId } = require('./db');

const DEFAULT_PROFILE = { state: null, city: null, updatedAt: null };

async function get(organizationId) {
  assertOrgId(organizationId);
  const db = getSql();
  const [row] = await db`
    select state, city, updated_at from organization_profile where organization_id = ${organizationId}
  `;
  if (!row) return { ...DEFAULT_PROFILE };
  return {
    state: row.state,
    city: row.city,
    updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
  };
}

async function update(organizationId, fields) {
  assertOrgId(organizationId);
  const db = getSql();
  const current = await get(organizationId);
  const next = { ...current, ...fields };

  await db`
    insert into organization_profile (organization_id, state, city, updated_at)
    values (${organizationId}, ${next.state}, ${next.city}, now())
    on conflict (organization_id) do update set
      state = excluded.state,
      city = excluded.city,
      updated_at = excluded.updated_at
  `;

  return get(organizationId);
}

module.exports = { get, update };
