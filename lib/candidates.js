// ai-wot — Candidate-Confirm Pattern
// v0.7.0: Auto-generate attestation candidates from transactions,
// require explicit confirmation before publishing.
//
// Designed by Reticuli + stillhere on Colony (2026-02-02):
// "auto-generate attestation candidates from transactions,
//  require y/n before publishing"
//
// The gap this fills: commerce happens all the time, but trust
// attestations require manual action. Candidates bridge the gap
// by presenting pre-built attestations that just need a yes/no.

const crypto = require('crypto');

// Lazy-require wot.js and receipts.js to avoid circular dependency
// (wot.js requires candidates.js, candidates.js requires wot.js)
let _wot = null;
let _receipts = null;

function getWot() {
  if (!_wot) _wot = require('./wot');
  return _wot;
}

function getReceipts() {
  if (!_receipts) _receipts = require('./receipts');
  return _receipts;
}

// ─── Candidate Store ────────────────────────────────────────────

/**
 * In-memory candidate store with persistence hooks.
 *
 * Each candidate represents a potential attestation generated from
 * a real transaction. It sits in a queue until the agent confirms
 * or rejects it.
 *
 * Candidates have states:
 *   pending → confirmed → published
 *   pending → rejected
 *   pending → expired
 */
class CandidateStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxAge=86400000] - Auto-expire candidates after this (ms, default 24h)
   * @param {number} [opts.maxCandidates=1000] - Max stored candidates
   * @param {Function} [opts.onPersist] - Called with all candidates when store changes (for external persistence)
   * @param {Function} [opts.onCandidate] - Called when a new candidate is added
   */
  constructor(opts = {}) {
    this.maxAge = opts.maxAge || 86_400_000;
    this.maxCandidates = opts.maxCandidates || 1000;
    this.onPersist = opts.onPersist || null;
    this.onCandidate = opts.onCandidate || null;
    this._candidates = new Map(); // id → candidate
  }

  /**
   * Add a candidate to the store.
   * @param {object} candidate - Must have: type, targetPubkey, comment
   * @returns {object} The stored candidate with id, status, createdAt
   */
  add(candidate) {
    if (!candidate.type || !candidate.targetPubkey || !candidate.comment) {
      throw new Error('Candidate must have type, targetPubkey, and comment');
    }

    const id = candidate.id || crypto.randomBytes(8).toString('hex');
    const stored = {
      id,
      status: 'pending',
      type: candidate.type,
      targetPubkey: candidate.targetPubkey,
      comment: candidate.comment,
      eventRef: candidate.eventRef || null,
      source: candidate.source || 'manual',
      metadata: candidate.metadata || {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
      publishedEventId: null,
    };

    // Enforce max size
    if (this._candidates.size >= this.maxCandidates) {
      this._evictOldest();
    }

    this._candidates.set(id, stored);
    this._persist();
    if (this.onCandidate) this.onCandidate(stored);
    return stored;
  }

  /**
   * Get a candidate by ID.
   */
  get(id) {
    return this._candidates.get(id) || null;
  }

  /**
   * List candidates, optionally filtered by status.
   * @param {object} [filter]
   * @param {string} [filter.status] - 'pending', 'confirmed', 'rejected', 'published', 'expired'
   * @param {string} [filter.targetPubkey] - Filter by target
   * @param {string} [filter.source] - Filter by source ('dvm', 'l402', 'manual', etc.)
   * @param {number} [filter.limit=50]
   * @returns {object[]}
   */
  list(filter = {}) {
    this._expireOld();
    let results = [...this._candidates.values()];

    if (filter.status) results = results.filter(c => c.status === filter.status);
    if (filter.targetPubkey) results = results.filter(c => c.targetPubkey === filter.targetPubkey);
    if (filter.source) results = results.filter(c => c.source === filter.source);

    results.sort((a, b) => b.createdAt - a.createdAt);
    return results.slice(0, filter.limit || 50);
  }

  /**
   * Confirm a candidate (marks it for publishing).
   * @param {string} id
   * @param {object} [edits] - Optional edits: { comment, type, rating }
   * @returns {object|null} Updated candidate or null if not found
   */
  confirm(id, edits = {}) {
    const c = this._candidates.get(id);
    if (!c || c.status !== 'pending') return null;

    c.status = 'confirmed';
    c.updatedAt = Date.now();
    if (edits.comment) c.comment = edits.comment;
    if (edits.type) c.type = edits.type;
    if (edits.rating) c.metadata.rating = edits.rating;

    this._persist();
    return c;
  }

  /**
   * Reject a candidate.
   * @param {string} id
   * @param {string} [reason]
   * @returns {object|null}
   */
  reject(id, reason) {
    const c = this._candidates.get(id);
    if (!c || c.status !== 'pending') return null;

    c.status = 'rejected';
    c.updatedAt = Date.now();
    c.metadata.rejectReason = reason || null;

    this._persist();
    return c;
  }

  /**
   * Mark a candidate as published.
   * @param {string} id
   * @param {string} eventId - The published Nostr event ID
   */
  markPublished(id, eventId) {
    const c = this._candidates.get(id);
    if (!c) return null;

    c.status = 'published';
    c.publishedEventId = eventId;
    c.updatedAt = Date.now();

    this._persist();
    return c;
  }

  /**
   * Confirm and immediately publish a candidate.
   * @param {string} id - Candidate ID
   * @param {Buffer|Uint8Array} secretKey - Nostr secret key
   * @param {object} [opts] - { edits, relays }
   * @returns {Promise<{candidate, event, results}|null>}
   */
  async confirmAndPublish(id, secretKey, opts = {}) {
    const confirmed = this.confirm(id, opts.edits || {});
    if (!confirmed) return null;

    const { publishAttestation } = getWot();
    const { event, results } = await publishAttestation(
      secretKey,
      confirmed.targetPubkey,
      confirmed.type,
      confirmed.comment,
      {
        relays: opts.relays,
        eventRef: confirmed.eventRef,
      }
    );

    this.markPublished(id, event.id);
    return { candidate: confirmed, event, results };
  }

  /**
   * Publish all confirmed candidates.
   * @param {Buffer|Uint8Array} secretKey
   * @param {object} [opts]
   * @returns {Promise<object[]>} Array of publish results
   */
  async publishAllConfirmed(secretKey, opts = {}) {
    const confirmed = this.list({ status: 'confirmed' });
    const results = [];

    for (const c of confirmed) {
      try {
        const result = await this.confirmAndPublish(c.id, secretKey, {
          ...opts,
          edits: {}, // Already confirmed
        });
        // Re-confirm since confirmAndPublish calls confirm again
        if (result) results.push(result);
      } catch (err) {
        results.push({ candidate: c, error: err.message });
      }
    }

    return results;
  }

  /**
   * Get stats about the candidate store.
   */
  stats() {
    this._expireOld();
    const counts = { pending: 0, confirmed: 0, rejected: 0, published: 0, expired: 0, total: 0 };
    for (const c of this._candidates.values()) {
      counts[c.status] = (counts[c.status] || 0) + 1;
      counts.total++;
    }
    return counts;
  }

  /**
   * Load candidates from external persistence.
   * @param {object[]} candidates
   */
  load(candidates) {
    for (const c of candidates) {
      this._candidates.set(c.id, c);
    }
  }

  /**
   * Export all candidates (for persistence).
   */
  export() {
    return [...this._candidates.values()];
  }

  // ── Internal ──────────────────────────────────────────────

  _expireOld() {
    const cutoff = Date.now() - this.maxAge;
    for (const [id, c] of this._candidates.entries()) {
      if (c.status === 'pending' && c.createdAt < cutoff) {
        c.status = 'expired';
        c.updatedAt = Date.now();
      }
    }
  }

  _evictOldest() {
    // Remove oldest non-pending candidates first, then oldest pending
    const sorted = [...this._candidates.entries()]
      .sort((a, b) => a[1].createdAt - b[1].createdAt);

    for (const [id, c] of sorted) {
      if (c.status !== 'pending') {
        this._candidates.delete(id);
        return;
      }
    }
    // All pending — evict oldest
    if (sorted.length > 0) {
      this._candidates.delete(sorted[0][0]);
    }
  }

  _persist() {
    if (this.onPersist) {
      try {
        this.onPersist(this.export());
      } catch (_) {}
    }
  }
}

// ─── Auto-Generation Sources ────────────────────────────────────

/**
 * Watch DVM results and auto-generate candidates.
 *
 * @param {string} myPubkey - Your hex pubkey (to detect your DVM requests)
 * @param {CandidateStore} store - Candidate store to add to
 * @param {object} [opts]
 * @param {string[]} [opts.relays] - Relay URLs
 * @param {Function} [opts.filter] - Optional filter: (parsedResult) => bool
 * @param {string} [opts.defaultType='service-quality']
 * @returns {{ stop: Function }}
 */
function watchDVMCandidates(myPubkey, store, opts = {}) {
  const defaultType = opts.defaultType || 'service-quality';

  const { watchDVMResults, generateReceiptCandidate } = getReceipts();
  const watcher = watchDVMResults(myPubkey, (parsed, raw) => {
    // Apply optional filter
    if (opts.filter && !opts.filter(parsed)) return false;

    // Generate candidate
    const receiptCandidate = generateReceiptCandidate(parsed, {
      type: defaultType,
    });

    store.add({
      type: receiptCandidate.type,
      targetPubkey: receiptCandidate.targetPubkey,
      comment: receiptCandidate.comment,
      eventRef: receiptCandidate.eventRef,
      source: 'dvm',
      metadata: {
        requestKind: parsed.requestKind,
        requestKindName: parsed.requestKindName,
        amountSats: parsed.amountSats,
        resultEventId: parsed.resultEventId,
        requestEventId: parsed.requestEventId,
      },
    });

    return false; // Don't auto-publish — wait for confirmation
  }, { relays: opts.relays });

  return { stop: watcher.stop };
}

/**
 * Generate a candidate from an L402 payment.
 *
 * @param {CandidateStore} store
 * @param {object} params
 * @param {string} params.providerPubkey - Pubkey of the service provider
 * @param {string} params.endpoint - API endpoint that was accessed
 * @param {number} params.amountSats - Sats paid
 * @param {string} [params.paymentHash] - Lightning payment hash
 * @param {string} [params.description] - What the service provided
 * @returns {object} The created candidate
 */
function generateL402Candidate(store, params) {
  const parts = ['L402 payment'];
  parts.push(params.endpoint);
  parts.push(`${params.amountSats} sats`);
  if (params.description) parts.push(params.description);

  return store.add({
    type: 'work-completed',
    targetPubkey: params.providerPubkey,
    comment: parts.join(' | '),
    eventRef: params.paymentHash || null,
    source: 'l402',
    metadata: {
      endpoint: params.endpoint,
      amountSats: params.amountSats,
      paymentHash: params.paymentHash,
      description: params.description,
    },
  });
}

/**
 * Generate a candidate from a generic service interaction.
 *
 * @param {CandidateStore} store
 * @param {object} params
 * @param {string} params.targetPubkey
 * @param {string} params.type - Attestation type
 * @param {string} params.comment
 * @param {string} [params.source='manual']
 * @param {object} [params.metadata={}]
 * @returns {object}
 */
function generateCandidate(store, params) {
  return store.add({
    type: params.type,
    targetPubkey: params.targetPubkey,
    comment: params.comment,
    source: params.source || 'manual',
    metadata: params.metadata || {},
  });
}

// ─── CLI Integration ────────────────────────────────────────────

/**
 * File-based persistence for the candidate store.
 *
 * @param {string} filePath - JSON file path
 * @returns {{ load: Function, save: Function }}
 */
function filePersistence(filePath) {
  const fs = require('fs');
  return {
    load() {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        return [];
      }
    },
    save(candidates) {
      fs.writeFileSync(filePath, JSON.stringify(candidates, null, 2));
    },
  };
}

// ─── Exports ────────────────────────────────────────────────────

module.exports = {
  CandidateStore,
  watchDVMCandidates,
  generateL402Candidate,
  generateCandidate,
  filePersistence,
};
