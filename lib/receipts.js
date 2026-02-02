// ai-wot — DVM Receipt Flow
// v0.4.0: Automatic trust attestations from DVM interactions
//
// Closes the economy→trust loop: Agent pays DVM → gets result → publishes
// service-quality attestation referencing the transaction.
//
// NIP-90 DVM kinds:
//   Request: 5xxx (e.g. 5050 = text generation)
//   Result:  6xxx (e.g. 6050 = text generation result)
//   Feedback: 7000

const { publishAttestation, queryRelays, RELAYS, NAMESPACE } = require('./wot');
const WebSocket = require('ws');

// ─── Constants ──────────────────────────────────────────────────

const DVM_REQUEST_KIND_MIN = 5000;
const DVM_REQUEST_KIND_MAX = 5999;
const DVM_RESULT_KIND_MIN = 6000;
const DVM_RESULT_KIND_MAX = 6999;
const DVM_FEEDBACK_KIND = 7000;

const DVM_KIND_NAMES = {
  5050: 'text-generation',
  5100: 'image-generation',
  5200: 'text-to-speech',
  5300: 'content-discovery',
  5301: 'people-discovery',
  5302: 'content-search',
  5400: 'content-curation',
  5500: 'translation',
  5900: 'custom'
};

// ─── DVM Result Parsing ─────────────────────────────────────────

/**
 * Parse a DVM result event (kind 6xxx) into structured metadata.
 *
 * @param {object} event - A Nostr event (kind 6xxx)
 * @returns {object|null} Parsed DVM result, or null if not a valid DVM result
 */
function parseDVMResult(event) {
  if (!event || !event.kind) return null;

  // Must be a DVM result kind (6xxx)
  if (event.kind < DVM_RESULT_KIND_MIN || event.kind > DVM_RESULT_KIND_MAX) {
    return null;
  }

  const requestKind = event.kind - 1000; // 6050 → 5050
  const requestEventId = findTagValue(event.tags, 'e');
  const requesterPubkey = findTagValue(event.tags, 'p');
  const amountTag = findTagValue(event.tags, 'amount');

  return {
    resultEventId: event.id,
    resultKind: event.kind,
    requestKind,
    requestKindName: DVM_KIND_NAMES[requestKind] || `kind-${requestKind}`,
    requestEventId,
    dvmPubkey: event.pubkey,
    requesterPubkey,
    content: event.content || '',
    createdAt: event.created_at,
    amountMillisats: amountTag ? parseInt(amountTag, 10) : null,
    amountSats: amountTag ? Math.floor(parseInt(amountTag, 10) / 1000) : null
  };
}

/**
 * Parse a DVM feedback event (kind 7000).
 *
 * @param {object} event - A Nostr event (kind 7000)
 * @returns {object|null} Parsed feedback, or null if invalid
 */
function parseDVMFeedback(event) {
  if (!event || event.kind !== DVM_FEEDBACK_KIND) return null;

  const requestEventId = findTagValue(event.tags, 'e');
  const status = findTagValue(event.tags, 'status');
  const amountTag = findTagValue(event.tags, 'amount');

  // Try to extract bolt11 invoice from content
  let bolt11 = null;
  if (event.content) {
    try {
      const parsed = JSON.parse(event.content);
      bolt11 = parsed.bolt11 || parsed.invoice || null;
    } catch (_) {
      // Content might be the invoice directly
      if (event.content.startsWith('lnbc')) {
        bolt11 = event.content;
      }
    }
  }

  return {
    feedbackEventId: event.id,
    requestEventId,
    dvmPubkey: event.pubkey,
    status, // 'processing', 'payment-required', 'error', etc.
    amountMillisats: amountTag ? parseInt(amountTag, 10) : null,
    amountSats: amountTag ? Math.floor(parseInt(amountTag, 10) / 1000) : null,
    bolt11,
    content: event.content || '',
    createdAt: event.created_at
  };
}

// ─── Receipt Attestation ────────────────────────────────────────

/**
 * Generate a receipt candidate from a DVM result WITHOUT publishing.
 *
 * Returns the attestation data that can later be passed to publishReceipt
 * as the `candidate` option.
 *
 * @param {object} dvmResult - Parsed DVM result from parseDVMResult()
 * @param {object} [opts] - Options:
 *   - comment: Human-readable quality note
 *   - amountSats: Override amount paid
 *   - rating: Optional 1-5 quality rating
 *   - type: Attestation type (default: 'service-quality')
 * @returns {object} Candidate object: { type, comment, targetPubkey, eventRef, tags, dvmResult, amountSats, rating }
 */
function generateReceiptCandidate(dvmResult, opts = {}) {
  if (!dvmResult || !dvmResult.dvmPubkey) {
    throw new Error('dvmResult must include dvmPubkey');
  }

  if (!dvmResult.resultEventId) {
    throw new Error('dvmResult must include resultEventId to create traceable receipt');
  }

  const type = opts.type || 'service-quality';
  const sats = opts.amountSats || dvmResult.amountSats || null;
  const rating = opts.rating ? Math.max(1, Math.min(5, Math.round(opts.rating))) : null;

  // Build structured comment
  const parts = ['DVM receipt'];
  parts.push(`kind:${dvmResult.requestKind} (${dvmResult.requestKindName})`);
  if (sats) parts.push(`${sats} sats`);
  if (rating) parts.push(`rating:${rating}/5`);
  if (opts.comment) {
    parts.push(opts.comment);
  }
  const comment = parts.join(' | ');

  // Build tags that would be used in the attestation
  const tags = [
    ['L', NAMESPACE],
    ['l', type, NAMESPACE],
    ['p', dvmResult.dvmPubkey],
    ['e', dvmResult.resultEventId, '']
  ];

  return {
    type,
    comment,
    targetPubkey: dvmResult.dvmPubkey,
    eventRef: dvmResult.resultEventId,
    tags,
    dvmResult: {
      dvmPubkey: dvmResult.dvmPubkey,
      resultEventId: dvmResult.resultEventId,
      requestEventId: dvmResult.requestEventId,
      requestKind: dvmResult.requestKind,
      requestKindName: dvmResult.requestKindName,
    },
    amountSats: sats,
    rating
  };
}

/**
 * Publish a service-quality attestation as a DVM receipt.
 *
 * This is the core function that closes the economy→trust loop:
 * Agent pays for DVM service → gets result → publishes traceable attestation.
 *
 * The attestation content is structured for machine-readability while
 * remaining human-readable:
 *   "DVM receipt | kind:5050 (text-generation) | 21 sats | Good translation"
 *
 * @param {Buffer|Uint8Array} secretKey - Your 32-byte secret key
 * @param {object} dvmResult - Parsed DVM result from parseDVMResult()
 * @param {object} [opts] - Options:
 *   - comment: Human-readable quality note (default: auto-generated)
 *   - amountSats: Override amount paid (if not in the DVM result)
 *   - rating: Optional 1-5 quality rating
 *   - relays: Relay URLs to publish to
 *   - type: Attestation type (default: 'service-quality')
 *   - candidate: Pre-built candidate from generateReceiptCandidate() — if provided, uses this instead of building from dvmResult
 * @returns {Promise<{event, results, receipt}>}
 */
async function publishReceipt(secretKey, dvmResult, opts = {}) {
  // If a candidate is provided, use its data instead of building from dvmResult
  let type, sats, rating, comment, targetPubkey, eventRef, candidateDvmResult;

  if (opts.candidate) {
    const c = opts.candidate;
    type = c.type;
    comment = c.comment;
    targetPubkey = c.targetPubkey;
    eventRef = c.eventRef;
    sats = c.amountSats;
    rating = c.rating;
    candidateDvmResult = c.dvmResult;
  } else {
    if (!dvmResult || !dvmResult.dvmPubkey) {
      throw new Error('dvmResult must include dvmPubkey');
    }

    if (!dvmResult.resultEventId) {
      throw new Error('dvmResult must include resultEventId to create traceable receipt');
    }

    type = opts.type || 'service-quality';
    sats = opts.amountSats || dvmResult.amountSats || null;
    rating = opts.rating ? Math.max(1, Math.min(5, Math.round(opts.rating))) : null;
    targetPubkey = dvmResult.dvmPubkey;
    eventRef = dvmResult.resultEventId;

    // Build structured comment
    const parts = ['DVM receipt'];
    parts.push(`kind:${dvmResult.requestKind} (${dvmResult.requestKindName})`);
    if (sats) parts.push(`${sats} sats`);
    if (rating) parts.push(`rating:${rating}/5`);
    if (opts.comment) {
      parts.push(opts.comment);
    }
    comment = parts.join(' | ');

    candidateDvmResult = {
      dvmPubkey: dvmResult.dvmPubkey,
      resultEventId: dvmResult.resultEventId,
      requestEventId: dvmResult.requestEventId,
      requestKind: dvmResult.requestKind,
      requestKindName: dvmResult.requestKindName,
    };
  }

  const { event, results } = await publishAttestation(
    secretKey,
    targetPubkey,
    type,
    comment,
    {
      eventRef: eventRef,
      relays: opts.relays
    }
  );

  const receipt = {
    attestationEventId: event.id,
    dvmPubkey: candidateDvmResult.dvmPubkey,
    dvmResultEventId: candidateDvmResult.resultEventId,
    dvmRequestEventId: candidateDvmResult.requestEventId,
    requestKind: candidateDvmResult.requestKind,
    requestKindName: candidateDvmResult.requestKindName,
    amountSats: sats,
    rating,
    comment,
    type,
    timestamp: event.created_at
  };

  return { event, results, receipt };
}

// ─── DVM History Query ──────────────────────────────────────────

/**
 * Find your past DVM requests and their results.
 *
 * Returns matched pairs of (request → result) with attestation status.
 *
 * @param {string} myPubkey - Your hex pubkey
 * @param {object} [opts] - Options:
 *   - relays: Relay URLs
 *   - limit: Max results (default: 50)
 *   - since: Unix timestamp to search from
 *   - kinds: Array of DVM request kinds to filter (e.g., [5050])
 * @returns {Promise<Array<{request, result, feedback, attested}>>}
 */
async function queryDVMHistory(myPubkey, opts = {}) {
  const relays = opts.relays || RELAYS;
  const limit = opts.limit || 50;

  // Step 1: Find my DVM requests
  const requestFilter = {
    kinds: [],
    authors: [myPubkey],
    limit
  };

  // Build kinds list
  if (opts.kinds && opts.kinds.length > 0) {
    requestFilter.kinds = opts.kinds;
  } else {
    // Default: all DVM request kinds
    for (let k = DVM_REQUEST_KIND_MIN; k <= DVM_REQUEST_KIND_MAX; k++) {
      requestFilter.kinds.push(k);
    }
  }

  if (opts.since) {
    requestFilter.since = opts.since;
  }

  const requests = await queryRelays(requestFilter, relays);

  if (requests.length === 0) return [];

  // Step 2: Find results for those requests
  const requestIds = requests.map(r => r.id);
  const resultFilter = {
    kinds: [],
    '#e': requestIds,
    limit: limit * 2
  };

  // Result kinds = request kinds + 1000
  for (const req of requests) {
    const resultKind = req.kind + 1000;
    if (!resultFilter.kinds.includes(resultKind)) {
      resultFilter.kinds.push(resultKind);
    }
  }

  const results = await queryRelays(resultFilter, relays);

  // Step 3: Find existing attestations I've made about the DVM pubkeys
  const dvmPubkeys = [...new Set(results.map(r => r.pubkey))];
  const myAttestations = new Map(); // dvmPubkey+resultEventId → attestation

  if (dvmPubkeys.length > 0) {
    const attFilter = {
      kinds: [1985],
      '#L': [NAMESPACE],
      authors: [myPubkey],
      limit: 200
    };

    const atts = await queryRelays(attFilter, relays);
    for (const att of atts) {
      const eTag = att.tags.find(t => t[0] === 'e');
      const pTag = att.tags.find(t => t[0] === 'p');
      if (eTag && pTag) {
        myAttestations.set(`${pTag[1]}:${eTag[1]}`, att);
      }
    }
  }

  // Step 4: Match requests → results
  const resultsByRequest = new Map();
  for (const result of results) {
    const reqRef = findTagValue(result.tags, 'e');
    if (reqRef) {
      if (!resultsByRequest.has(reqRef)) {
        resultsByRequest.set(reqRef, []);
      }
      resultsByRequest.get(reqRef).push(result);
    }
  }

  // Step 5: Build history entries
  const history = [];
  for (const request of requests) {
    const matchedResults = resultsByRequest.get(request.id) || [];

    for (const result of matchedResults) {
      const parsed = parseDVMResult(result);
      const attestKey = `${result.pubkey}:${result.id}`;
      const existingAttestation = myAttestations.get(attestKey);

      history.push({
        request: {
          eventId: request.id,
          kind: request.kind,
          kindName: DVM_KIND_NAMES[request.kind] || `kind-${request.kind}`,
          content: request.content ? request.content.substring(0, 200) : '',
          createdAt: request.created_at
        },
        result: parsed,
        attested: !!existingAttestation,
        attestationId: existingAttestation ? existingAttestation.id : null
      });
    }

    // Include unmatched requests (no result yet)
    if (matchedResults.length === 0) {
      history.push({
        request: {
          eventId: request.id,
          kind: request.kind,
          kindName: DVM_KIND_NAMES[request.kind] || `kind-${request.kind}`,
          content: request.content ? request.content.substring(0, 200) : '',
          createdAt: request.created_at
        },
        result: null,
        attested: false,
        attestationId: null
      });
    }
  }

  // Sort by most recent first
  history.sort((a, b) => {
    const aTime = a.result ? a.result.createdAt : a.request.createdAt;
    const bTime = b.result ? b.result.createdAt : b.request.createdAt;
    return bTime - aTime;
  });

  return history;
}

// ─── DVM Result Watcher ─────────────────────────────────────────

/**
 * Watch for incoming DVM results and optionally auto-attest.
 *
 * Opens persistent subscriptions to relays, listening for DVM results
 * addressed to your pubkey. Calls the callback for each result, which
 * can decide whether to publish a receipt attestation.
 *
 * @param {string} myPubkey - Your hex pubkey
 * @param {function} callback - Called with (parsedResult, rawEvent). Return truthy to auto-attest.
 * @param {object} [opts] - Options:
 *   - relays: Relay URLs
 *   - kinds: DVM result kinds to watch (default: all 6xxx)
 *   - secretKey: If provided + callback returns truthy, auto-publishes receipt
 *   - autoAttestOpts: Options passed to publishReceipt for auto-attestations
 * @returns {{stop: function, connections: Map}} - Call stop() to close all connections
 */
function watchDVMResults(myPubkey, callback, opts = {}) {
  const relays = opts.relays || RELAYS;
  const connections = new Map();
  let stopped = false;

  const subId = 'wot_dvm_' + Math.random().toString(36).slice(2, 10);
  const seen = new Set();

  // Build filter for DVM results addressed to us
  const filter = {
    '#p': [myPubkey],
    since: Math.floor(Date.now() / 1000) - 10 // Start from ~now
  };

  if (opts.kinds && opts.kinds.length > 0) {
    filter.kinds = opts.kinds;
  } else {
    filter.kinds = [];
    for (let k = DVM_RESULT_KIND_MIN; k <= DVM_RESULT_KIND_MAX; k++) {
      filter.kinds.push(k);
    }
    filter.kinds.push(DVM_FEEDBACK_KIND);
  }

  function connectRelay(relayUrl) {
    if (stopped) return;

    let ws;
    try {
      ws = new WebSocket(relayUrl);
    } catch (err) {
      console.error(`[watcher] Failed to connect to ${relayUrl}: ${err.message}`);
      scheduleReconnect(relayUrl);
      return;
    }

    connections.set(relayUrl, ws);

    ws.on('open', () => {
      ws.send(JSON.stringify(['REQ', subId, filter]));
    });

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg[0] !== 'EVENT' || msg[1] !== subId) return;

        const event = msg[2];
        if (seen.has(event.id)) return;
        seen.add(event.id);

        // Parse based on kind
        let parsed;
        if (event.kind === DVM_FEEDBACK_KIND) {
          parsed = parseDVMFeedback(event);
        } else {
          parsed = parseDVMResult(event);
        }

        if (!parsed) return;

        // Call user callback
        const shouldAttest = await callback(parsed, event);

        // Auto-attest if requested
        if (shouldAttest && opts.secretKey && parsed.dvmPubkey && parsed.resultEventId) {
          try {
            const { receipt } = await publishReceipt(
              opts.secretKey,
              parsed,
              opts.autoAttestOpts || {}
            );
            console.log(`[watcher] Auto-attested DVM ${parsed.dvmPubkey.substring(0, 12)}... → ${receipt.attestationEventId}`);
          } catch (err) {
            console.error(`[watcher] Auto-attest failed: ${err.message}`);
          }
        }
      } catch (_) {}
    });

    ws.on('close', () => {
      connections.delete(relayUrl);
      if (!stopped) scheduleReconnect(relayUrl);
    });

    ws.on('error', (err) => {
      try { ws.close(); } catch (_) {}
    });
  }

  function scheduleReconnect(relayUrl) {
    if (stopped) return;
    setTimeout(() => connectRelay(relayUrl), 5000 + Math.random() * 5000);
  }

  // Connect to all relays
  for (const relay of relays) {
    connectRelay(relay);
  }

  return {
    connections,
    stop() {
      stopped = true;
      for (const [url, ws] of connections) {
        try {
          ws.send(JSON.stringify(['CLOSE', subId]));
          ws.close();
        } catch (_) {}
      }
      connections.clear();
    }
  };
}

// ─── Batch Attestations ─────────────────────────────────────────

/**
 * Publish attestations for multiple agents at once.
 *
 * Useful for bootstrapping trust networks or acknowledging multiple
 * DVM interactions in a batch.
 *
 * @param {Buffer|Uint8Array} secretKey - Your 32-byte secret key
 * @param {Array<{pubkey, type, comment, eventRef}>} targets - Agents to attest
 * @param {object} [opts] - Options:
 *   - relays: Relay URLs
 *   - delayMs: Delay between attestations to avoid rate limits (default: 500)
 * @returns {Promise<Array<{pubkey, event, results, error}>>}
 */
async function publishBatchAttestations(secretKey, targets, opts = {}) {
  const delayMs = opts.delayMs || 500;
  const results = [];

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];

    try {
      const { event, results: relayResults } = await publishAttestation(
        secretKey,
        target.pubkey,
        target.type || 'general-trust',
        target.comment || '',
        {
          eventRef: target.eventRef,
          relays: opts.relays
        }
      );

      const successCount = relayResults.filter(r => r.success).length;
      results.push({
        pubkey: target.pubkey,
        event,
        results: relayResults,
        success: successCount > 0,
        error: null
      });
    } catch (err) {
      results.push({
        pubkey: target.pubkey,
        event: null,
        results: [],
        success: false,
        error: err.message
      });
    }

    // Delay between attestations (except last)
    if (i < targets.length - 1 && delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

// ─── Helpers ────────────────────────────────────────────────────

function findTagValue(tags, name) {
  if (!tags) return null;
  const tag = tags.find(t => t[0] === name);
  return tag ? tag[1] : null;
}

// ─── Exports ────────────────────────────────────────────────────

module.exports = {
  // DVM parsing
  parseDVMResult,
  parseDVMFeedback,

  // Receipt attestation
  publishReceipt,
  generateReceiptCandidate,

  // History & discovery
  queryDVMHistory,

  // Live watcher
  watchDVMResults,

  // Batch operations
  publishBatchAttestations,

  // Constants
  DVM_REQUEST_KIND_MIN,
  DVM_REQUEST_KIND_MAX,
  DVM_RESULT_KIND_MIN,
  DVM_RESULT_KIND_MAX,
  DVM_FEEDBACK_KIND,
  DVM_KIND_NAMES
};
