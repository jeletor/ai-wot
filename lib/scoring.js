// ai-wot — Trust Score Calculation with Temporal Decay, Negative Attestations, and Sybil Metrics
// v0.3.0: Added dispute/warning types, revocation support, diversity scoring

const NAMESPACE = 'ai.wot';

const VALID_TYPES = ['service-quality', 'identity-continuity', 'general-trust', 'dispute', 'warning'];

const POSITIVE_TYPES = ['service-quality', 'identity-continuity', 'general-trust'];
const NEGATIVE_TYPES = ['dispute', 'warning'];

const TYPE_MULTIPLIERS = {
  'service-quality': 1.5,
  'identity-continuity': 1.0,
  'general-trust': 0.8,
  'dispute': -1.5,
  'warning': -0.8
};

const ZAP_MULTIPLIER = 0.5;
const DAMPENING_FACTOR = 0.5;
const DEFAULT_HALF_LIFE_DAYS = 90;
const NEGATIVE_ATTESTATION_TRUST_GATE = 20; // minimum display score to issue effective negative attestations

// ─── Temporal Decay ─────────────────────────────────────────────

/**
 * Calculate the temporal decay factor for an attestation.
 *
 * Uses exponential decay with a configurable half-life:
 *   decay = 0.5 ^ (ageDays / halfLifeDays)
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

// ─── Diversity Score ────────────────────────────────────────────

/**
 * Calculate sybil resistance / diversity metrics from a score breakdown.
 *
 * diversity = (uniqueAttesters / attestationCount) × (1 - maxSingleAttesterShare)
 *
 * @param {Array} breakdown - Score breakdown array from calculateTrustScore
 * @returns {{diversity: number, uniqueAttesters: number, maxAttesterShare: number, topAttester: string|null}}
 */
function calculateDiversity(breakdown) {
  if (!breakdown || breakdown.length === 0) {
    return { diversity: 0, uniqueAttesters: 0, maxAttesterShare: 0, topAttester: null };
  }

  // Only count positive contributions for diversity
  const positiveBreakdown = breakdown.filter(b => b.contribution > 0);
  if (positiveBreakdown.length === 0) {
    return { diversity: 0, uniqueAttesters: 0, maxAttesterShare: 0, topAttester: null };
  }

  const totalContribution = positiveBreakdown.reduce((sum, b) => sum + b.contribution, 0);
  const attesterContributions = new Map();

  for (const b of positiveBreakdown) {
    attesterContributions.set(
      b.attester,
      (attesterContributions.get(b.attester) || 0) + b.contribution
    );
  }

  const uniqueAttesters = attesterContributions.size;
  let maxShare = 0;
  let topAttester = null;

  for (const [attester, contribution] of attesterContributions) {
    const share = totalContribution > 0 ? contribution / totalContribution : 0;
    if (share > maxShare) {
      maxShare = share;
      topAttester = attester;
    }
  }

  const attesterRatio = Math.min(1, uniqueAttesters / positiveBreakdown.length);
  const diversity = Math.round(attesterRatio * (1 - maxShare) * 100) / 100;

  return {
    diversity,
    uniqueAttesters,
    maxAttesterShare: Math.round(maxShare * 100) / 100,
    topAttester
  };
}

// ─── Score Calculation ──────────────────────────────────────────

/**
 * Calculate trust score from a set of attestations.
 *
 * v0.3.0: Supports negative attestations (dispute, warning) with trust gating.
 * Negative attestations from low-trust agents are ignored.
 * Raw score is floored at 0.
 *
 * @param {Array} attestations - Array of attestation events
 * @param {Map} zapTotals - Map of eventId → total sats
 * @param {object} opts - Options:
 *   - halfLifeDays: Temporal decay half-life (default: 90)
 *   - depth: Current recursion depth
 *   - maxDepth: Max recursion depth (default: 2)
 *   - resolveAttesterScore: async function(pubkey) → score object
 *   - now: Current timestamp for decay calculation
 *   - negativeTrustGate: Min display score for negative attestations (default: 20)
 * @returns {Promise<{raw, display, attestationCount, breakdown, diversity}>}
 */
async function calculateTrustScore(attestations, zapTotals, opts = {}) {
  const halfLifeDays = opts.halfLifeDays || DEFAULT_HALF_LIFE_DAYS;
  const depth = opts.depth || 0;
  const maxDepth = opts.maxDepth || 2;
  const now = opts.now || Math.floor(Date.now() / 1000);
  const negativeTrustGate = opts.negativeTrustGate !== undefined ? opts.negativeTrustGate : NEGATIVE_ATTESTATION_TRUST_GATE;

  let rawScore = 0;
  const breakdown = [];

  for (const att of attestations) {
    // Strict match: ["l", "type", "ai.wot"]
    let lTag = att.tags.find(t => t[0] === 'l' && t[2] === NAMESPACE);

    // Lenient match: if namespace tag ["L", "ai.wot"] exists,
    // accept bare ["l", "type"] tags (common malformation)
    if (!lTag) {
      const hasNamespaceTag = att.tags.some(t => t[0] === 'L' && t[1] === NAMESPACE);
      if (hasNamespaceTag) {
        lTag = att.tags.find(t => t[0] === 'l' && VALID_TYPES.includes(t[1]) && (!t[2] || t[2] === NAMESPACE));
      }
    }

    if (!lTag) continue;
    const attType = lTag[1];
    if (!VALID_TYPES.includes(attType)) continue;

    const isNegative = NEGATIVE_TYPES.includes(attType);
    const typeMult = TYPE_MULTIPLIERS[attType];

    // Negative attestations require non-empty content
    if (isNegative && (!att.content || att.content.trim().length === 0)) {
      breakdown.push({
        attester: att.pubkey,
        type: attType,
        zapSats: 0,
        zapWeight: 0,
        decayFactor: 0,
        attesterTrust: 0,
        typeMult,
        contribution: 0,
        comment: '[IGNORED: empty content on negative attestation]',
        eventId: att.id,
        timestamp: att.created_at,
        gated: true
      });
      continue;
    }

    // Zap weight
    const sats = zapTotals.get(att.id) || 0;
    const zWeight = zapWeight(sats);

    // Temporal decay
    const decayFactor = temporalDecay(att.created_at, halfLifeDays, now);

    // Attester trust (recursive, with depth limit)
    let attesterTrust = 1.0;
    let attesterDisplayScore = 100; // assumed max if we can't resolve
    if (depth < maxDepth && opts.resolveAttesterScore) {
      const attesterScore = await opts.resolveAttesterScore(att.pubkey);
      attesterDisplayScore = attesterScore.display || 0;
      if (attesterScore.raw > 0) {
        attesterTrust = Math.pow(attesterScore.raw, DAMPENING_FACTOR);
      }
    }

    // Gate negative attestations: only effective if attester has trust >= gate
    if (isNegative && attesterDisplayScore < negativeTrustGate) {
      breakdown.push({
        attester: att.pubkey,
        type: attType,
        zapSats: sats,
        zapWeight: Math.round(zWeight * 100) / 100,
        decayFactor: Math.round(decayFactor * 1000) / 1000,
        attesterTrust: Math.round(attesterTrust * 100) / 100,
        attesterDisplayScore,
        typeMult,
        contribution: 0,
        comment: att.content ? att.content.substring(0, 80) : '',
        eventId: att.id,
        timestamp: att.created_at,
        gated: true,
        gateReason: `Attester trust ${attesterDisplayScore} < gate ${negativeTrustGate}`
      });
      continue;
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
      timestamp: att.created_at,
      gated: false
    });
  }

  // Floor raw score at 0
  const flooredRaw = Math.max(0, Math.round(rawScore * 100) / 100);

  const result = {
    raw: flooredRaw,
    display: Math.min(100, Math.round(Math.max(0, rawScore) * 10)),
    attestationCount: attestations.length,
    positiveCount: breakdown.filter(b => !b.gated && b.contribution > 0).length,
    negativeCount: breakdown.filter(b => !b.gated && b.contribution < 0).length,
    gatedCount: breakdown.filter(b => b.gated).length,
    breakdown,
    diversity: calculateDiversity(breakdown.filter(b => !b.gated))
  };

  return result;
}

// ─── Exports ────────────────────────────────────────────────────

module.exports = {
  calculateTrustScore,
  calculateDiversity,
  temporalDecay,
  zapWeight,
  TYPE_MULTIPLIERS,
  VALID_TYPES,
  POSITIVE_TYPES,
  NEGATIVE_TYPES,
  ZAP_MULTIPLIER,
  DAMPENING_FACTOR,
  DEFAULT_HALF_LIFE_DAYS,
  NEGATIVE_ATTESTATION_TRUST_GATE,
  NAMESPACE
};
