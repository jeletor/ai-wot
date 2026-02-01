// ai-wot — Core Library
// Nostr Web of Trust protocol for AI agents (NIP-32 labels, kind 1985)
// v0.3.0: Negative attestations, revocations (NIP-09), sybil metrics

const { finalizeEvent, verifyEvent } = require('nostr-tools/pure');
const WebSocket = require('ws');
const {
  calculateTrustScore: computeScore,
  calculateDiversity,
  TYPE_MULTIPLIERS,
  VALID_TYPES,
  POSITIVE_TYPES,
  NEGATIVE_TYPES,
  NEGATIVE_ATTESTATION_TRUST_GATE
} = require('./scoring');

// ─── Constants ──────────────────────────────────────────────────

const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social'
];

const NAMESPACE = 'ai.wot';
const RELAY_TIMEOUT_MS = 12000;
const VERSION = '0.3.0';

// ─── Relay Communication ────────────────────────────────────────

/**
 * Publish an event to a single relay.
 */
function publishToRelay(relay, event) {
  return new Promise((resolve) => {
    let ws;
    const timeout = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      resolve({ relay, success: false, reason: 'Timeout' });
    }, RELAY_TIMEOUT_MS);

    try {
      ws = new WebSocket(relay);
    } catch (err) {
      clearTimeout(timeout);
      resolve({ relay, success: false, reason: err.message });
      return;
    }

    ws.on('open', () => {
      ws.send(JSON.stringify(['EVENT', event]));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg[0] === 'OK') {
          clearTimeout(timeout);
          ws.close();
          resolve(msg[2]
            ? { relay, success: true, eventId: msg[1] }
            : { relay, success: false, reason: msg[3] || 'Rejected' }
          );
        }
      } catch (_) {}
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      try { ws.close(); } catch (_) {}
      resolve({ relay, success: false, reason: err.message });
    });
  });
}

/**
 * Publish an event to multiple relays.
 */
function publishToRelays(event, relays = RELAYS) {
  return Promise.all(relays.map(relay => publishToRelay(relay, event)));
}

/**
 * Query a single relay with a filter.
 */
function queryRelay(relay, filter) {
  return new Promise((resolve, reject) => {
    const events = [];
    let ws;
    const subId = 'wot_' + Math.random().toString(36).slice(2, 10);

    const timeout = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      resolve(events);
    }, RELAY_TIMEOUT_MS);

    try {
      ws = new WebSocket(relay);
    } catch (err) {
      clearTimeout(timeout);
      reject(err);
      return;
    }

    ws.on('open', () => {
      ws.send(JSON.stringify(['REQ', subId, filter]));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg[0] === 'EVENT' && msg[1] === subId) {
          events.push(msg[2]);
        } else if (msg[0] === 'EOSE' && msg[1] === subId) {
          clearTimeout(timeout);
          ws.send(JSON.stringify(['CLOSE', subId]));
          ws.close();
          resolve(events);
        }
      } catch (_) {}
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      try { ws.close(); } catch (_) {}
      resolve(events);
    });
  });
}

/**
 * Query multiple relays with a filter. Deduplicates by event ID.
 */
function queryRelays(filter, relays = RELAYS) {
  return new Promise((resolve) => {
    const events = new Map();
    let completed = 0;
    const total = relays.length;

    const masterTimeout = setTimeout(() => {
      resolve(Array.from(events.values()));
    }, RELAY_TIMEOUT_MS + 2000);

    if (total === 0) {
      clearTimeout(masterTimeout);
      resolve([]);
      return;
    }

    relays.forEach(relay => {
      queryRelay(relay, filter)
        .then(evts => {
          for (const e of evts) {
            if (!events.has(e.id)) events.set(e.id, e);
          }
        })
        .catch(() => {})
        .finally(() => {
          completed++;
          if (completed >= total) {
            clearTimeout(masterTimeout);
            resolve(Array.from(events.values()));
          }
        });
    });
  });
}

// ─── Revocation Support (NIP-09) ────────────────────────────────

/**
 * Query revocations (kind 5 events that delete kind 1985 events).
 * Returns a Set of revoked event IDs.
 *
 * @param {string[]} authors - pubkeys whose revocations to query
 * @param {string[]} relays - relay URLs
 * @returns {Promise<Set<string>>} - Set of revoked event IDs
 */
async function queryRevocations(authors, relays = RELAYS) {
  if (authors.length === 0) return new Set();

  const filter = {
    kinds: [5],
    '#k': ['1985'],
    authors,
    limit: 500
  };

  const deletionEvents = await queryRelays(filter, relays);
  const revokedIds = new Set();

  for (const del of deletionEvents) {
    for (const tag of del.tags) {
      if (tag[0] === 'e') {
        revokedIds.add(tag[1]);
      }
    }
  }

  return revokedIds;
}

/**
 * Publish a revocation event (NIP-09 kind 5) to revoke a previous attestation.
 *
 * @param {Buffer|Uint8Array} secretKey - 32-byte secret key
 * @param {string} attestationEventId - event ID of the attestation to revoke
 * @param {string} reason - explanation for the revocation
 * @param {object} [opts] - { relays }
 * @returns {Promise<{event, results}>}
 */
async function publishRevocation(secretKey, attestationEventId, reason, opts = {}) {
  if (!attestationEventId || attestationEventId.length !== 64) {
    throw new Error('attestationEventId must be a 64-character hex string');
  }

  if (!reason || reason.trim().length === 0) {
    throw new Error('Revocation reason must not be empty');
  }

  const event = finalizeEvent({
    kind: 5,
    created_at: Math.floor(Date.now() / 1000),
    content: reason,
    tags: [
      ['e', attestationEventId],
      ['k', '1985']
    ]
  }, secretKey);

  const relays = opts.relays || RELAYS;
  const results = await publishToRelays(event, relays);

  return { event, results };
}

// ─── Core Functions ─────────────────────────────────────────────

/**
 * Create and publish an attestation event.
 *
 * @param {Buffer|Uint8Array} secretKey - 32-byte secret key
 * @param {string} targetPubkey - hex pubkey of the agent being attested
 * @param {string} type - one of: service-quality, identity-continuity, general-trust, dispute, warning
 * @param {string} comment - human-readable explanation
 * @param {object} [opts] - optional: { eventRef, relayHint, relays, expiration }
 * @returns {Promise<{event, results}>}
 */
async function publishAttestation(secretKey, targetPubkey, type, comment, opts = {}) {
  if (!VALID_TYPES.includes(type)) {
    throw new Error(`Invalid attestation type: "${type}". Must be one of: ${VALID_TYPES.join(', ')}`);
  }

  if (!targetPubkey || targetPubkey.length !== 64) {
    throw new Error('targetPubkey must be a 64-character hex string');
  }

  // Negative attestations require non-empty content
  if (NEGATIVE_TYPES.includes(type) && (!comment || comment.trim().length === 0)) {
    throw new Error(`Negative attestation type "${type}" requires a non-empty comment explaining the issue`);
  }

  const tags = [
    ['L', NAMESPACE],
    ['l', type, NAMESPACE],
    ['p', targetPubkey]
  ];

  if (opts.eventRef) {
    tags.push(['e', opts.eventRef, opts.relayHint || '']);
  }

  // Optional expiration (default: 90 days)
  if (opts.expiration !== false) {
    const expiry = opts.expiration || Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60);
    tags.push(['expiration', String(expiry)]);
  }

  const event = finalizeEvent({
    kind: 1985,
    created_at: Math.floor(Date.now() / 1000),
    content: comment || '',
    tags
  }, secretKey);

  const relays = opts.relays || RELAYS;
  const results = await publishToRelays(event, relays);

  return { event, results };
}

/**
 * Query all attestations about a given pubkey.
 * Automatically filters out revoked attestations.
 *
 * @param {string} pubkey - hex pubkey to look up
 * @param {object} [opts] - optional: { relays, type, limit, includeRevoked }
 * @returns {Promise<Array>} - array of attestation events
 */
async function queryAttestations(pubkey, opts = {}) {
  const filter = {
    kinds: [1985],
    '#L': [NAMESPACE],
    '#p': [pubkey]
  };

  if (opts.type && VALID_TYPES.includes(opts.type)) {
    filter['#l'] = [opts.type];
  }

  if (opts.limit) {
    filter.limit = opts.limit;
  }

  const relays = opts.relays || RELAYS;
  let events = await queryRelays(filter, relays);

  // Filter out self-attestations
  events = events.filter(e => e.pubkey !== pubkey);

  // Filter out revoked attestations (unless explicitly requested)
  if (!opts.includeRevoked) {
    const authors = [...new Set(events.map(e => e.pubkey))];
    if (authors.length > 0) {
      const revokedIds = await queryRevocations(authors, relays);
      if (revokedIds.size > 0) {
        const beforeCount = events.length;
        events = events.filter(e => !revokedIds.has(e.id));
        if (events.length < beforeCount) {
          // Attach revocation metadata
          events._revokedCount = beforeCount - events.length;
        }
      }
    }
  }

  return events;
}

/**
 * Query zap receipts for a set of event IDs.
 */
async function queryZapsForEvents(eventIds, relays = RELAYS) {
  if (eventIds.length === 0) return new Map();

  const filter = {
    kinds: [9735],
    '#e': eventIds,
    limit: 500
  };

  const zapReceipts = await queryRelays(filter, relays);
  const zapTotals = new Map();

  for (const receipt of zapReceipts) {
    const eTag = receipt.tags.find(t => t[0] === 'e');
    if (!eTag) continue;
    const targetEventId = eTag[1];

    const descTag = receipt.tags.find(t => t[0] === 'description');
    if (!descTag) continue;

    try {
      const zapRequest = JSON.parse(descTag[1]);
      const amountTag = zapRequest.tags?.find(t => t[0] === 'amount');
      if (amountTag) {
        const msats = parseInt(amountTag[1], 10);
        const sats = Math.floor(msats / 1000);
        zapTotals.set(targetEventId, (zapTotals.get(targetEventId) || 0) + sats);
      }
    } catch (_) {}
  }

  return zapTotals;
}

/**
 * Calculate the trust score for a pubkey.
 *
 * @param {string} pubkey - hex pubkey
 * @param {object} [opts] - { relays, depth, halfLifeDays, _cache }
 * @returns {Promise<{raw, display, attestationCount, positiveCount, negativeCount, gatedCount, breakdown, diversity}>}
 */
async function calculateTrustScore(pubkey, opts = {}) {
  const depth = opts.depth || 0;
  const cache = opts._cache || new Map();
  const relays = opts.relays || RELAYS;
  const halfLifeDays = opts.halfLifeDays || 90;

  // Check cache
  if (cache.has(pubkey)) return cache.get(pubkey);

  // Placeholder to prevent infinite recursion
  const placeholder = { raw: 0, display: 0, attestationCount: 0, positiveCount: 0, negativeCount: 0, gatedCount: 0, breakdown: [], diversity: { diversity: 0, uniqueAttesters: 0, maxAttesterShare: 0, topAttester: null } };
  cache.set(pubkey, placeholder);

  const attestations = await queryAttestations(pubkey, { relays });

  if (attestations.length === 0) {
    cache.set(pubkey, placeholder);
    return placeholder;
  }

  // Fetch zaps for all attestation events
  const eventIds = attestations.map(a => a.id);
  const zapTotals = await queryZapsForEvents(eventIds, relays);

  // Use scoring module
  const result = await computeScore(attestations, zapTotals, {
    halfLifeDays,
    depth,
    maxDepth: 2,
    cache,
    relays,
    resolveAttesterScore: async (attesterPubkey) => {
      return calculateTrustScore(attesterPubkey, {
        relays,
        depth: depth + 1,
        halfLifeDays,
        _cache: cache
      });
    }
  });

  cache.set(pubkey, result);
  return result;
}

/**
 * Get a human-readable summary of an agent's trust profile.
 */
async function getAttestationSummary(pubkey, opts = {}) {
  const score = await calculateTrustScore(pubkey, opts);
  const attestations = await queryAttestations(pubkey, opts);

  const lines = [];
  lines.push('╔══════════════════════════════════════════════════╗');
  lines.push('║       Web of Trust Profile                      ║');
  lines.push('╠══════════════════════════════════════════════════╣');
  lines.push(`║  Pubkey: ${pubkey.substring(0, 16)}...${pubkey.substring(56)}      ║`);
  lines.push(`║  Trust Score: ${String(score.display).padStart(3)} / 100                          ║`);
  lines.push(`║  Attestations: ${String(score.attestationCount).padStart(3)} (${score.positiveCount}+ ${score.negativeCount}- ${score.gatedCount}⊘)          ║`);
  lines.push(`║  Diversity: ${String(score.diversity.diversity).padStart(4)}                              ║`);
  lines.push('╚══════════════════════════════════════════════════╝');

  if (score.attestationCount === 0) {
    lines.push('\n  No attestations found. This agent has no trust history yet.');
    return lines.join('\n');
  }

  // Type breakdown
  const typeCounts = {};
  for (const att of attestations) {
    const lTag = att.tags.find(t => t[0] === 'l' && t[2] === NAMESPACE);
    if (lTag) {
      typeCounts[lTag[1]] = (typeCounts[lTag[1]] || 0) + 1;
    }
  }

  lines.push('\n  Attestation Breakdown:');
  for (const [type, count] of Object.entries(typeCounts)) {
    const isNeg = NEGATIVE_TYPES.includes(type);
    const bar = (isNeg ? '░' : '█').repeat(Math.min(count, 20));
    const prefix = isNeg ? '⚠' : '✓';
    lines.push(`    ${prefix} ${type.padEnd(22)} ${bar} ${count}`);
  }

  // Diversity info
  lines.push('\n  Sybil Resistance:');
  lines.push(`    Unique attesters: ${score.diversity.uniqueAttesters}`);
  lines.push(`    Diversity score: ${score.diversity.diversity} (0=concentrated, 1=distributed)`);
  if (score.diversity.maxAttesterShare > 0.5) {
    lines.push(`    ⚠ Top attester provides ${Math.round(score.diversity.maxAttesterShare * 100)}% of trust`);
  }

  // Recent attestations
  lines.push('\n  Recent Attestations:');
  const sorted = score.breakdown
    .filter(b => !b.gated)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 5);

  for (const b of sorted) {
    const date = new Date(b.timestamp * 1000).toISOString().split('T')[0];
    const shortAttester = b.attester.substring(0, 12) + '...';
    const sign = b.contribution < 0 ? '⚠' : '✓';
    lines.push(`    ${sign} ${date}  ${shortAttester}  ${b.type}`);
    if (b.comment) {
      lines.push(`               "${b.comment}"`);
    }
    if (b.zapSats > 0) {
      lines.push(`               ⚡ ${b.zapSats} sats (weight: ${b.zapWeight}x)`);
    }
    if (b.decayFactor < 1.0) {
      lines.push(`               📉 decay: ${(b.decayFactor * 100).toFixed(0)}%`);
    }
  }

  // Gated attestations
  const gated = score.breakdown.filter(b => b.gated);
  if (gated.length > 0) {
    lines.push(`\n  Gated Attestations (ignored): ${gated.length}`);
    for (const b of gated.slice(0, 3)) {
      const reason = b.gateReason || 'empty content';
      lines.push(`    ⊘ ${b.attester.substring(0, 12)}... ${b.type} — ${reason}`);
    }
  }

  // Score details
  lines.push('\n  Score Components:');
  lines.push(`    Raw score: ${score.raw}`);
  lines.push(`    Display score: ${score.display}/100`);
  lines.push(`    Positive contributions: ${score.positiveCount}`);
  lines.push(`    Negative contributions: ${score.negativeCount}`);

  return lines.join('\n');
}

// ─── Exports ────────────────────────────────────────────────────

module.exports = {
  // Core operations
  publishAttestation,
  queryAttestations,
  calculateTrustScore,
  getAttestationSummary,
  queryZapsForEvents,

  // Revocations
  publishRevocation,
  queryRevocations,

  // Relay helpers
  publishToRelays,
  publishToRelay,
  queryRelays,
  queryRelay,

  // Constants
  RELAYS,
  NAMESPACE,
  VALID_TYPES,
  POSITIVE_TYPES,
  NEGATIVE_TYPES,
  TYPE_MULTIPLIERS,
  RELAY_TIMEOUT_MS,
  VERSION
};
