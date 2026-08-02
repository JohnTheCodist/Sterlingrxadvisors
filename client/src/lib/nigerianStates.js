/**
 * Nigeria's 36 states + FCT — the only values the weather signal can resolve.
 *
 * This list is imported by every surface that collects a state (signup,
 * onboarding, dashboard settings) rather than retyped beside each form. The
 * server validates the same set against the weather service's own state→city
 * map, so a value that reaches the database is always one weather can look
 * up. Two copies of this list would drift, and the symptom of drift is a
 * weather panel that quietly stops appearing.
 */
export const NIGERIAN_STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue',
  'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu',
  'Federal Capital Territory', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano',
  'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun',
  'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara',
];
