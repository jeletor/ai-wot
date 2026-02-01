// Nostr Web of Trust (WoT) — Core Library
// Implements the ai.wot attestation protocol using NIP-32 labels (kind 1985)

const { finalizeEvent, verifyEvent } = require('nostr-tools/pure');
const WebSocket = require('ws');

const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social'
];

const NAMESPACE = 'ai.wot';

const VALID_TYPES = ['service-quality', 'identity-continuity', 'general-trust'];

const TYPE_MULTIPLIERS = {
  'service-quality': 1.5,
  'identity-continuity': 1.0,
  'general-trust': 0.8
};

const ZAP_MULTIPLIER = 0.5;
const DAMPENING_FACTOR = 0.5;
const MAX_RECURSION_DEPTH = 2;
const RELAY_TIMEOUT_MS = 12000;

// ─── Relay Helpers ──────────────────────────────────────────────

/**
 * Publish an event to all relays. Returns array of { relay, success, reason? }
 */
function publishToRelays(event, relays = RELAYS) {
  return Promise.all(relays.map(relay => publishToRelay(relay, event)));
}

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
 * Query relays with a filter. Returns deduplicated array of events.
 */
function queryRelays(filter, relays = RELAYS) {
  return new Promise((resolve) => {
    const events = new Map(); // id → event (dedup)
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

function queryRelay(relay, filter) {
  return new Promise((resolve, reject) => {
    const events = [];
    let ws;
    const subId = 'wot_' + Math.random().toString(36).slice(2, 10);

    const timeout = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      resolve(events); // return whatever we got
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
      resolve(events); // return whatever we got
    });
  });
}

// ─── Core Functions ─────────────────────────────────────────────

/**
 * Create and publish an attestation event.
 * 
 * @param {Buffer|Uint8Array} secretKey - 32-byte secret key
 * @param {string} targetPubkey - hex pubkey of the agent being attested
 * @param {string} type - one of: service-quality, identity-continuity, general-trust
 * @param {string} comment - human-readable explanation
 * @param {object} opts - optional: { eventRef, relayHint, relays }
 * @returns {Promise<{event, results}>}
 */
async function publishAttestation(secretKey, targetPubkey, type, comment, opts = {}) {
  if (!VALID_TYPES.includes(type)) {
    throw new Error(`Invalid attestation type: "${type}". Must be one of: ${VALID_TYPES.join(', ')}`);
  }

  if (!targetPubkey || targetPubkey.length !== 64) {
    throw new Error('targetPubkey must be a 64-character hex string');
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
 * 
 * @param {string} pubkey - hex pubkey to look up
 * @param {object} opts - optional: { relays, type }
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

  const events = await queryRelays(filter, opts.relays || RELAYS);

  // Filter out self-attestations
  return events.filter(e => e.pubkey !== pubkey);
}

/**
 * Query zap receipts for a set of event IDs.
 * Returns map of eventId → total sats zapped.
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
    // Find which attestation event this zap references
    const eTag = receipt.tags.find(t => t[0] === 'e');
    if (!eTag) continue;
    const targetEventId = eTag[1];

    // Extract sats from bolt11 in the description tag
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
    } catch (_) {
      // Can't parse zap description, skip
    }
  }

  return zapTotals;
}

/**
 * Calculate the trust score for a pubkey.
 * 
 * @param {string} pubkey - hex pubkey
 * @param {object} opts - optional: { relays, depth, _cache }
 * @returns {Promise<{raw, display, attestationCount, breakdown}>}
 */
async function calculateTrustScore(pubkey, opts = {}) {
  const depth = opts.depth || 0;
  const cache = opts._cache || new Map();
  const relays = opts.relays || RELAYS;

  // Check cache
  if (cache.has(pubkey)) return cache.get(pubkey);

  // Set a placeholder to prevent infinite recursion
  const placeholder = { raw: 0, display: 0, attestationCount: 0, breakdown: [] };
  cache.set(pubkey, placeholder);

  const attestations = await queryAttestations(pubkey, { relays });

  if (attestations.length === 0) {
    const result = { raw: 0, display: 0, attestationCount: 0, breakdown: [] };
    cache.set(pubkey, result);
    return result;
  }

  // Fetch zaps for all attestation events
  const eventIds = attestations.map(a => a.id);
  const zapTotals = await queryZapsForEvents(eventIds, relays);

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
    const zapSats = zapTotals.get(att.id) || 0;
    const zapWeight = 1.0 + Math.log2(1 + zapSats) * ZAP_MULTIPLIER;

    // Attester trust (recursive, with depth limit)
    let attesterTrust = 1.0;
    if (depth < MAX_RECURSION_DEPTH) {
      const attesterScore = await calculateTrustScore(att.pubkey, {
        relays,
        depth: depth + 1,
        _cache: cache
      });
      if (attesterScore.raw > 0) {
        attesterTrust = Math.pow(attesterScore.raw, DAMPENING_FACTOR);
      }
    }

    const contribution = zapWeight * attesterTrust * typeMult;
    rawScore += contribution;

    breakdown.push({
      attester: att.pubkey,
      type: attType,
      zapSats,
      zapWeight: Math.round(zapWeight * 100) / 100,
      attesterTrust: Math.round(attesterTrust * 100) / 100,
      typeMult,
      contribution: Math.round(contribution * 100) / 100,
      comment: att.content ? att.content.substring(0, 80) : '',
      eventId: att.id,
      timestamp: att.created_at
    });
  }

  const result = {
    raw: Math.round(rawScore * 100) / 100,
    display: Math.min(100, Math.round(rawScore * 10)),
    attestationCount: attestations.length,
    breakdown
  };

  cache.set(pubkey, result);
  return result;
}

/**
 * Get a human-readable summary of an agent's trust profile.
 * 
 * @param {string} pubkey - hex pubkey
 * @param {object} opts - optional: { relays }
 * @returns {Promise<string>}
 */
async function getAttestationSummary(pubkey, opts = {}) {
  const score = await calculateTrustScore(pubkey, opts);
  const attestations = await queryAttestations(pubkey, opts);

  const lines = [];
  lines.push(`╔══════════════════════════════════════════════════╗`);
  lines.push(`║       Web of Trust Profile                      ║`);
  lines.push(`╠══════════════════════════════════════════════════╣`);
  lines.push(`║  Pubkey: ${pubkey.substring(0, 16)}...${pubkey.substring(56)}      ║`);
  lines.push(`║  Trust Score: ${String(score.display).padStart(3)} / 100                          ║`);
  lines.push(`║  Attestations: ${String(score.attestationCount).padStart(3)}                               ║`);
  lines.push(`╚══════════════════════════════════════════════════╝`);

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
    const bar = '█'.repeat(Math.min(count, 20));
    lines.push(`    ${type.padEnd(22)} ${bar} ${count}`);
  }

  // Recent attestations
  lines.push('\n  Recent Attestations:');
  const sorted = score.breakdown
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 5);

  for (const b of sorted) {
    const date = new Date(b.timestamp * 1000).toISOString().split('T')[0];
    const shortAttester = b.attester.substring(0, 12) + '...';
    lines.push(`    ${date}  ${shortAttester}  ${b.type}`);
    if (b.comment) {
      lines.push(`             "${b.comment}"`);
    }
    if (b.zapSats > 0) {
      lines.push(`             ⚡ ${b.zapSats} sats (weight: ${b.zapWeight}x)`);
    }
  }

  // Score details
  lines.push('\n  Score Components:');
  lines.push(`    Raw score: ${score.raw}`);
  lines.push(`    Display score: ${score.display}/100`);
  lines.push(`    Unique attesters: ${new Set(score.breakdown.map(b => b.attester)).size}`);

  return lines.join('\n');
}

// ─── Exports ────────────────────────────────────────────────────

module.exports = {
  publishAttestation,
  queryAttestations,
  calculateTrustScore,
  getAttestationSummary,
  queryZapsForEvents,
  publishToRelays,
  queryRelays,
  RELAYS,
  NAMESPACE,
  VALID_TYPES,
  TYPE_MULTIPLIERS
};
