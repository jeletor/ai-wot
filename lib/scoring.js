// ai-wot — Trust Score Calculation with Temporal Decay
// Attestation weight decays over time using a half-life model

const NAMESPACE = 'ai.wot';

const VALID_TYPES = ['service-quality', 'identity-continuity', 'general-trust'];

const TYPE_MULTIPLIERS = {
  'service-quality': 1.5,
  'identity-continuity': 1.0,
  'general-trust': 0.8
};

const ZAP_MULTIPLIER = 0.5;
const DAMPENING_FACTOR = 0.5;
const DEFAULT_HALF_LIFE_DAYS = 90;

// ─── Temporal Decay ─────────────────────────────────────────────

/**
 * Calculate the temporal decay factor for an attestation.
 *
 * Uses exponential decay with a configurable half-life:
 *   decay = 0.5 ^ (ageDays / halfLifeDays)
 *
 * Examples (with 90-day half-life):
 *   0 days old  → 1.0   (full weight)
 *   45 days old → 0.71  (71% weight)
 *   90 days old → 0.5   (50% weight)
 *   180 days    → 0.25  (25% weight)
 *   360 days    → 0.063 (6.3% weight)
 *
 * @param {number} createdAt - Unix timestamp of the attestation
 * @param {number} [halfLifeDays=90] - Half-life in days
 * @param {number} [now] - Current timestamp (defaults to Date.now()/1000)
 * @returns {number} Decay factor between 0 and 1
 */
function temporalDecay(createdAt, halfLifeDays = DEFAULT_HALF_LIFE_DAYS, now) {
  if (!now) now = Math.floor(Date.now() / 1000);
  const ageSeconds = Math.max(0, now - createdAt);
  const ageDays = ageSeconds / 86400;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

// ─── Zap Weight ─────────────────────────────────────────────────

/**
 * Calculate the weight contribution from zap sats.
 *
 * Formula: base_weight + log2(1 + sats) * zap_multiplier
 *
 * @param {number} sats - Zap amount in sats
 * @returns {number} Weight (minimum 1.0)
 */
function zapWeight(sats) {
  if (sats <= 0) return 1.0;
  return 1.0 + Math.log2(1 + sats) * ZAP_MULTIPLIER;
}

// ─── Score Calculation ──────────────────────────────────────────

/**
 * Calculate trust score from a set of attestations.
 *
 * @param {Array} attestations - Array of attestation events
 * @param {Map} zapTotals - Map of eventId → total sats
 * @param {object} opts - Options:
 *   - halfLifeDays: Temporal decay half-life (default: 90)
 *   - depth: Current recursion depth
 *   - maxDepth: Max recursion depth (default: 2)
 *   - resolveAttesterScore: async function(pubkey) → score object
 *   - now: Current timestamp for decay calculation
 * @returns {Promise<{raw, display, attestationCount, breakdown}>}
 */
async function calculateTrustScore(attestations, zapTotals, opts = {}) {
  const halfLifeDays = opts.halfLifeDays || DEFAULT_HALF_LIFE_DAYS;
  const depth = opts.depth || 0;
  const maxDepth = opts.maxDepth || 2;
  const now = opts.now || Math.floor(Date.now() / 1000);

  let rawScore = 0;
  const breakdown = [];

  for (const att of attestations) {
    // Get attestation type
    const lTag = att.tags.find(t => t[0] === 'l' && t[2] === NAMESPACE);
    if (!lTag) continue;
    const attType = lTag[1];
    if (!VALID_TYPES.includes(attType)) continue;

    const typeMult = TYPE_MULTIPLIERS[attType];

    // Zap weight
    const sats = zapTotals.get(att.id) || 0;
    const zWeight = zapWeight(sats);

    // Temporal decay
    const decayFactor = temporalDecay(att.created_at, halfLifeDays, now);

    // Attester trust (recursive, with depth limit)
    let attesterTrust = 1.0;
    if (depth < maxDepth && opts.resolveAttesterScore) {
      const attesterScore = await opts.resolveAttesterScore(att.pubkey);
      if (attesterScore.raw > 0) {
        attesterTrust = Math.pow(attesterScore.raw, DAMPENING_FACTOR);
      }
    }

    const contribution = zWeight * attesterTrust * typeMult * decayFactor;
    rawScore += contribution;

    breakdown.push({
      attester: att.pubkey,
      type: attType,
      zapSats: sats,
      zapWeight: Math.round(zWeight * 100) / 100,
      decayFactor: Math.round(decayFactor * 1000) / 1000,
      attesterTrust: Math.round(attesterTrust * 100) / 100,
      typeMult,
      contribution: Math.round(contribution * 100) / 100,
      comment: att.content ? att.content.substring(0, 80) : '',
      eventId: att.id,
      timestamp: att.created_at
    });
  }

  return {
    raw: Math.round(rawScore * 100) / 100,
    display: Math.min(100, Math.round(rawScore * 10)),
    attestationCount: attestations.length,
    breakdown
  };
}

// ─── Exports ────────────────────────────────────────────────────

module.exports = {
  calculateTrustScore,
  temporalDecay,
  zapWeight,
  TYPE_MULTIPLIERS,
  VALID_TYPES,
  ZAP_MULTIPLIER,
  DAMPENING_FACTOR,
  DEFAULT_HALF_LIFE_DAYS,
  NAMESPACE
};
