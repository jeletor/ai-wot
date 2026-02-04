#!/usr/bin/env node
// ai-wot CLI — Web of Trust for AI agents on Nostr
// v0.4.0: DVM receipts, batch attestations, DVM history
//
// Usage:
//   ai-wot attest <pubkey> <type> "<comment>"
//   ai-wot dispute <pubkey> "<reason>"
//   ai-wot warn <pubkey> "<reason>"
//   ai-wot revoke <event-id> "<reason>"
//   ai-wot receipt <dvm-result-event-id> [--amount <sats>] [--rating <1-5>] [--comment "<text>"]
//   ai-wot batch <file.json>
//   ai-wot dvm-history [--kinds 5050,5100] [--unattested]
//   ai-wot lookup <pubkey>
//   ai-wot score <pubkey>
//   ai-wot my-score
//   ai-wot help

const path = require('path');
const fs = require('fs');
const wot = require('../lib/wot');
const { NEGATIVE_TYPES, POSITIVE_TYPES } = require('../lib/scoring');
const {
  parseDVMResult, publishReceipt, queryDVMHistory,
  publishBatchAttestations, DVM_KIND_NAMES
} = require('../lib/receipts');
const { CandidateStore, filePersistence } = require('../lib/candidates');

const VERSION = '0.7.0';
const CANDIDATES_DIR = path.join(process.env.HOME || '', '.ai-wot');
const CANDIDATES_FILE = path.join(CANDIDATES_DIR, 'candidates.json');

// ─── Key Loading ────────────────────────────────────────────────

function loadKeys() {
  // Try environment variable
  if (process.env.NOSTR_SECRET_KEY) {
    const hex = process.env.NOSTR_SECRET_KEY;
    if (/^[0-9a-f]{64}$/i.test(hex)) {
      const secretKey = Uint8Array.from(Buffer.from(hex, 'hex'));
      const { finalizeEvent } = require('nostr-tools/pure');
      const event = finalizeEvent({
        kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: ''
      }, secretKey);
      return { secretKey, pubkey: event.pubkey };
    }
  }

  // Try nostr-keys.json in common locations
  const searchPaths = [
    path.join(process.cwd(), 'nostr-keys.json'),
    path.join(process.env.HOME || '', '.nostr', 'keys.json'),
    path.join(process.env.HOME || '', '.openclaw', 'workspace', 'bitcoin', 'nostr-keys.json')
  ];

  for (const p of searchPaths) {
    if (fs.existsSync(p)) {
      try {
        const keys = JSON.parse(fs.readFileSync(p, 'utf-8'));
        const secretKey = Uint8Array.from(Buffer.from(keys.secretKeyHex, 'hex'));
        return { secretKey, pubkey: keys.publicKeyHex };
      } catch (e) {
        // continue to next path
      }
    }
  }

  return null;
}

// ─── Commands ───────────────────────────────────────────────────

async function attestCommand(args) {
  if (args.length < 3) {
    console.error('Usage: ai-wot attest <pubkey> <type> "<comment>" [--event <event-id>]');
    console.error(`\nPositive types: ${POSITIVE_TYPES.join(', ')}`);
    console.error(`Negative types: ${NEGATIVE_TYPES.join(', ')} (use 'dispute' or 'warn' shorthand instead)`);
    process.exit(1);
  }

  const keys = loadKeys();
  if (!keys) {
    console.error('❌ No keys found. Set NOSTR_SECRET_KEY env var or place nostr-keys.json in cwd.');
    process.exit(1);
  }

  const targetPubkey = args[0];
  const type = args[1];
  const comment = args[2];

  let eventRef = null;
  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--event' && args[i + 1]) {
      eventRef = args[++i];
    }
  }

  if (targetPubkey === keys.pubkey) {
    console.error('❌ Cannot self-attest. The protocol forbids attesting to your own pubkey.');
    process.exit(1);
  }

  const isNeg = NEGATIVE_TYPES.includes(type);
  const icon = isNeg ? '⚠️' : '📝';

  console.log(`${icon} Publishing ${isNeg ? 'NEGATIVE ' : ''}attestation...`);
  console.log(`   Target: ${targetPubkey.substring(0, 16)}...`);
  console.log(`   Type:   ${type}`);
  console.log(`   Comment: "${comment}"`);
  if (eventRef) console.log(`   Event ref: ${eventRef}`);
  console.log('');

  const { event, results } = await wot.publishAttestation(
    keys.secretKey, targetPubkey, type, comment, { eventRef }
  );

  console.log(`Event ID: ${event.id}\n`);

  for (const r of results) {
    console.log(`  ${r.relay}: ${r.success ? '✅' : '❌ ' + (r.reason || 'Failed')}`);
  }

  const successCount = results.filter(r => r.success).length;
  console.log(`\nPublished to ${successCount}/${results.length} relays`);

  if (successCount > 0) {
    console.log(`\n🔗 View: https://primal.net/e/${event.id}`);
  }
}

async function disputeCommand(args) {
  if (args.length < 2) {
    console.error('Usage: ai-wot dispute <pubkey> "<reason>" [--event <event-id>]');
    console.error('\nPublish a dispute (strong negative attestation, -1.5x weight).');
    console.error('Reason is REQUIRED — you must explain what went wrong.');
    process.exit(1);
  }

  // Delegate to attestCommand with type pre-filled
  return attestCommand([args[0], 'dispute', ...args.slice(1)]);
}

async function warnCommand(args) {
  if (args.length < 2) {
    console.error('Usage: ai-wot warn <pubkey> "<reason>" [--event <event-id>]');
    console.error('\nPublish a warning (mild negative attestation, -0.8x weight).');
    console.error('Reason is REQUIRED — you must explain the concern.');
    process.exit(1);
  }

  // Delegate to attestCommand with type pre-filled
  return attestCommand([args[0], 'warning', ...args.slice(1)]);
}

async function revokeCommand(args) {
  if (args.length < 2) {
    console.error('Usage: ai-wot revoke <attestation-event-id> "<reason>"');
    console.error('\nRevoke a previous attestation you published. Uses NIP-09 deletion.');
    process.exit(1);
  }

  const keys = loadKeys();
  if (!keys) {
    console.error('❌ No keys found. Set NOSTR_SECRET_KEY env var or place nostr-keys.json in cwd.');
    process.exit(1);
  }

  const eventId = args[0];
  const reason = args[1];

  console.log('🗑️  Publishing revocation...');
  console.log(`   Revoking event: ${eventId.substring(0, 16)}...`);
  console.log(`   Reason: "${reason}"`);
  console.log('');

  const { event, results } = await wot.publishRevocation(keys.secretKey, eventId, reason);

  console.log(`Revocation event ID: ${event.id}\n`);

  for (const r of results) {
    console.log(`  ${r.relay}: ${r.success ? '✅' : '❌ ' + (r.reason || 'Failed')}`);
  }

  const successCount = results.filter(r => r.success).length;
  console.log(`\nPublished to ${successCount}/${results.length} relays`);

  if (successCount > 0) {
    console.log('\n✅ Attestation revoked. It will be excluded from future trust calculations.');
  }
}

async function lookupCommand(args) {
  const pubkey = args[0];
  if (!pubkey) {
    console.error('Usage: ai-wot lookup <pubkey>');
    process.exit(1);
  }

  console.log('🔍 Querying attestations across relays...\n');
  const summary = await wot.getAttestationSummary(pubkey);
  console.log(summary);
}

async function scoreCommand(args) {
  const pubkey = args[0];
  if (!pubkey) {
    console.error('Usage: ai-wot score <pubkey>');
    process.exit(1);
  }

  console.log('📊 Calculating trust score...\n');
  const score = await wot.calculateTrustScore(pubkey);

  console.log(`  Pubkey:       ${pubkey.substring(0, 16)}...${pubkey.substring(56)}`);
  console.log(`  Trust Score:  ${score.display} / 100`);
  console.log(`  Raw Score:    ${score.raw}`);
  console.log(`  Attestations: ${score.attestationCount} (${score.positiveCount}+ ${score.negativeCount}- ${score.gatedCount}⊘)`);
  console.log(`  Diversity:    ${score.diversity.diversity} (${score.diversity.uniqueAttesters} unique attesters)`);

  if (score.diversity.maxAttesterShare > 0.5) {
    console.log(`  ⚠ Trust concentrated: top attester provides ${Math.round(score.diversity.maxAttesterShare * 100)}%`);
  }

  if (score.breakdown.length > 0) {
    console.log('\n  Top contributors:');
    const sorted = score.breakdown
      .filter(b => !b.gated)
      .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
      .slice(0, 5);
    for (const b of sorted) {
      const sign = b.contribution < 0 ? '⚠' : '✓';
      console.log(`    ${sign} ${b.attester.substring(0, 12)}... → ${b.type} (weight: ${b.contribution}, decay: ${(b.decayFactor * 100).toFixed(0)}%)`);
    }
  }
}

async function myScoreCommand() {
  const keys = loadKeys();
  if (!keys) {
    console.error('❌ No keys found. Set NOSTR_SECRET_KEY env var or place nostr-keys.json in cwd.');
    process.exit(1);
  }

  console.log(`🤖 Looking up trust score for self (${keys.pubkey.substring(0, 16)}...)\n`);
  const summary = await wot.getAttestationSummary(keys.pubkey);
  console.log(summary);
}

// ─── DVM Receipt Command ────────────────────────────────────────

async function receiptCommand(args) {
  if (args.length < 1) {
    console.error('Usage: ai-wot receipt <dvm-result-event-id> [options]');
    console.error('\nOptions:');
    console.error('  --amount <sats>      Amount paid for the DVM service');
    console.error('  --rating <1-5>       Quality rating');
    console.error('  --comment "<text>"   Additional comment');
    console.error('\nPublishes a service-quality attestation referencing a DVM interaction.');
    console.error('The DVM result event is fetched from relays to extract provider pubkey.');
    process.exit(1);
  }

  const keys = loadKeys();
  if (!keys) {
    console.error('❌ No keys found. Set NOSTR_SECRET_KEY env var or place nostr-keys.json in cwd.');
    process.exit(1);
  }

  const resultEventId = args[0];
  if (!/^[0-9a-f]{64}$/i.test(resultEventId)) {
    console.error('❌ Invalid event ID. Must be a 64-character hex string.');
    process.exit(1);
  }

  // Parse options
  let amountSats = null;
  let rating = null;
  let comment = null;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--amount' && args[i + 1]) {
      amountSats = parseInt(args[++i], 10);
    } else if (args[i] === '--rating' && args[i + 1]) {
      rating = parseInt(args[++i], 10);
    } else if (args[i] === '--comment' && args[i + 1]) {
      comment = args[++i];
    }
  }

  console.log('🔍 Fetching DVM result event from relays...\n');

  // Fetch the DVM result event
  const filter = { ids: [resultEventId] };
  const events = await wot.queryRelays(filter);

  if (events.length === 0) {
    console.error('❌ Event not found on any relay. Check the event ID.');
    process.exit(1);
  }

  const resultEvent = events[0];
  const parsed = parseDVMResult(resultEvent);

  if (!parsed) {
    console.error(`❌ Event kind ${resultEvent.kind} is not a DVM result (expected 6000-6999).`);
    process.exit(1);
  }

  console.log('📋 DVM Interaction:');
  console.log(`   DVM Provider: ${parsed.dvmPubkey.substring(0, 16)}...`);
  console.log(`   Service:      ${parsed.requestKindName} (kind ${parsed.requestKind})`);
  console.log(`   Result ID:    ${parsed.resultEventId.substring(0, 16)}...`);
  if (parsed.requestEventId) {
    console.log(`   Request ID:   ${parsed.requestEventId.substring(0, 16)}...`);
  }
  if (amountSats || parsed.amountSats) {
    console.log(`   Amount:       ${amountSats || parsed.amountSats} sats`);
  }
  if (rating) console.log(`   Rating:       ${rating}/5`);
  console.log('');

  console.log('📝 Publishing receipt attestation...\n');

  const { event, results, receipt } = await publishReceipt(
    keys.secretKey,
    parsed,
    { amountSats, rating, comment }
  );

  console.log(`Attestation ID: ${event.id}\n`);

  for (const r of results) {
    console.log(`  ${r.relay}: ${r.success ? '✅' : '❌ ' + (r.reason || 'Failed')}`);
  }

  const successCount = results.filter(r => r.success).length;
  console.log(`\nPublished to ${successCount}/${results.length} relays`);

  if (successCount > 0) {
    console.log(`\n✅ DVM receipt published. Trust loop closed.`);
    console.log(`   Content: "${receipt.comment}"`);
    console.log(`\n🔗 View: https://primal.net/e/${event.id}`);
  }
}

// ─── Batch Attestation Command ──────────────────────────────────

async function batchCommand(args) {
  if (args.length < 1) {
    console.error('Usage: ai-wot batch <file.json>');
    console.error('\nThe JSON file should contain an array of attestation targets:');
    console.error('  [');
    console.error('    { "pubkey": "abc...", "type": "service-quality", "comment": "Great DVM" },');
    console.error('    { "pubkey": "def...", "type": "general-trust", "comment": "Reliable agent" }');
    console.error('  ]');
    console.error('\nEach entry can have: pubkey (required), type, comment, eventRef');
    process.exit(1);
  }

  const keys = loadKeys();
  if (!keys) {
    console.error('❌ No keys found. Set NOSTR_SECRET_KEY env var or place nostr-keys.json in cwd.');
    process.exit(1);
  }

  const filePath = args[0];
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    process.exit(1);
  }

  let targets;
  try {
    targets = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error(`❌ Invalid JSON: ${err.message}`);
    process.exit(1);
  }

  if (!Array.isArray(targets) || targets.length === 0) {
    console.error('❌ File must contain a non-empty array of targets.');
    process.exit(1);
  }

  // Validate
  for (const t of targets) {
    if (!t.pubkey || !/^[0-9a-f]{64}$/i.test(t.pubkey)) {
      console.error(`❌ Invalid pubkey: ${t.pubkey}`);
      process.exit(1);
    }
    if (t.pubkey === keys.pubkey) {
      console.error(`❌ Cannot self-attest (${t.pubkey.substring(0, 16)}...).`);
      process.exit(1);
    }
  }

  console.log(`📦 Batch attestation: ${targets.length} targets\n`);

  const results = await publishBatchAttestations(keys.secretKey, targets);

  let successCount = 0;
  for (const r of results) {
    const status = r.success ? '✅' : '❌';
    const detail = r.error || `${r.results.filter(x => x.success).length} relays`;
    console.log(`  ${status} ${r.pubkey.substring(0, 16)}... — ${detail}`);
    if (r.success) successCount++;
  }

  console.log(`\n${successCount}/${targets.length} attestations published successfully.`);
}

// ─── DVM History Command ────────────────────────────────────────

async function dvmHistoryCommand(args) {
  const keys = loadKeys();
  if (!keys) {
    console.error('❌ No keys found. Set NOSTR_SECRET_KEY env var or place nostr-keys.json in cwd.');
    process.exit(1);
  }

  // Parse options
  let kinds = null;
  let unattested = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--kinds' && args[i + 1]) {
      kinds = args[++i].split(',').map(k => parseInt(k, 10));
    } else if (args[i] === '--unattested') {
      unattested = true;
    }
  }

  console.log('🔍 Querying DVM interaction history...\n');

  const history = await queryDVMHistory(keys.pubkey, { kinds });

  let filtered = history;
  if (unattested) {
    filtered = history.filter(h => !h.attested && h.result);
  }

  if (filtered.length === 0) {
    console.log(unattested
      ? '  No unattested DVM interactions found.'
      : '  No DVM interactions found.');
    return;
  }

  console.log(`  Found ${filtered.length} DVM interactions${unattested ? ' (unattested only)' : ''}:\n`);

  for (const h of filtered) {
    const date = new Date(h.request.createdAt * 1000).toISOString().split('T')[0];
    const status = h.result ? '✅' : '⏳';
    const attested = h.attested ? ' [attested]' : '';

    console.log(`  ${status} ${date}  ${h.request.kindName} (kind ${h.request.kind})${attested}`);
    console.log(`     Request: ${h.request.eventId.substring(0, 16)}...`);

    if (h.result) {
      console.log(`     Result:  ${h.result.resultEventId.substring(0, 16)}...`);
      console.log(`     DVM:     ${h.result.dvmPubkey.substring(0, 16)}...`);
      if (h.result.amountSats) {
        console.log(`     Amount:  ${h.result.amountSats} sats`);
      }
    } else {
      console.log(`     (no result yet)`);
    }
    console.log('');
  }

  const unattestedCount = filtered.filter(h => !h.attested && h.result).length;
  if (unattestedCount > 0 && !unattested) {
    console.log(`  💡 ${unattestedCount} interaction(s) not yet attested. Use --unattested to filter.`);
    console.log(`     Use 'ai-wot receipt <result-event-id>' to publish a receipt.`);
  }
}

// ─── Candidate Commands ─────────────────────────────────────────

function getCandidateStore() {
  if (!fs.existsSync(CANDIDATES_DIR)) {
    fs.mkdirSync(CANDIDATES_DIR, { recursive: true });
  }
  const persistence = filePersistence(CANDIDATES_FILE);
  const store = new CandidateStore({
    onPersist: (candidates) => persistence.save(candidates),
  });
  store.load(persistence.load());
  return store;
}

async function candidatesCommand(args) {
  const sub = args[0];

  if (sub === 'confirm') return candidateConfirmCommand(args.slice(1));
  if (sub === 'reject') return candidateRejectCommand(args.slice(1));
  if (sub === 'confirm-all') return candidateConfirmAllCommand(args.slice(1));
  if (sub === 'publish') return candidatePublishCommand(args.slice(1));
  if (sub === 'stats') return candidateStatsCommand(args.slice(1));

  // Default: list candidates
  return candidateListCommand(args);
}

async function candidateListCommand(args) {
  const store = getCandidateStore();
  const filter = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--status' && args[i + 1]) filter.status = args[++i];
    else if (args[i] === '--source' && args[i + 1]) filter.source = args[++i];
    else if (args[i] === '--limit' && args[i + 1]) filter.limit = parseInt(args[++i], 10);
  }

  if (!filter.status) filter.status = 'pending';
  const candidates = store.list(filter);

  if (candidates.length === 0) {
    console.log(`📋 No ${filter.status} candidates found.`);
    return;
  }

  console.log(`📋 ${candidates.length} ${filter.status} candidate(s):\n`);
  for (const c of candidates) {
    const age = Math.round((Date.now() - c.createdAt) / 60000);
    const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
    console.log(`  ${c.id}  ${c.type}  ${c.source}`);
    console.log(`    Target: ${c.targetPubkey.substring(0, 16)}...`);
    console.log(`    Comment: "${c.comment}"`);
    console.log(`    Created: ${ageStr}  Status: ${c.status}`);
    console.log('');
  }
}

async function candidateConfirmCommand(args) {
  if (!args[0]) {
    console.error('Usage: ai-wot candidates confirm <id> [--comment "..."] [--type ...]');
    process.exit(1);
  }

  const store = getCandidateStore();
  const id = args[0];
  const edits = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--comment' && args[i + 1]) edits.comment = args[++i];
    else if (args[i] === '--type' && args[i + 1]) edits.type = args[++i];
  }

  const c = store.confirm(id, edits);
  if (!c) {
    console.error(`❌ Candidate ${id} not found or not pending.`);
    process.exit(1);
  }

  console.log(`✅ Confirmed candidate ${id}`);
  console.log(`   Type: ${c.type}`);
  console.log(`   Target: ${c.targetPubkey.substring(0, 16)}...`);
  console.log(`   Comment: "${c.comment}"`);
  console.log(`\n   Use 'ai-wot candidates publish ${id}' to publish to relays.`);
}

async function candidateRejectCommand(args) {
  if (!args[0]) {
    console.error('Usage: ai-wot candidates reject <id> [--reason "..."]');
    process.exit(1);
  }

  const store = getCandidateStore();
  const id = args[0];
  let reason = null;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--reason' && args[i + 1]) reason = args[++i];
  }

  const c = store.reject(id, reason);
  if (!c) {
    console.error(`❌ Candidate ${id} not found or not pending.`);
    process.exit(1);
  }

  console.log(`❌ Rejected candidate ${id}`);
  if (reason) console.log(`   Reason: "${reason}"`);
}

async function candidateConfirmAllCommand(args) {
  const store = getCandidateStore();
  let source = null;
  let publish = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source' && args[i + 1]) source = args[++i];
    else if (args[i] === '--publish') publish = true;
  }

  const filter = { status: 'pending' };
  if (source) filter.source = source;
  const pending = store.list(filter);

  if (pending.length === 0) {
    console.log('📋 No pending candidates to confirm.');
    return;
  }

  let confirmed = 0;
  for (const c of pending) {
    if (store.confirm(c.id)) confirmed++;
  }
  console.log(`✅ Confirmed ${confirmed} candidate(s).`);

  if (publish) {
    const keys = loadKeys();
    if (!keys) {
      console.error('❌ No keys found — confirmed but cannot publish. Set NOSTR_SECRET_KEY or place nostr-keys.json.');
      return;
    }

    console.log('\n📡 Publishing all confirmed candidates...\n');
    const results = await store.publishAllConfirmed(keys.secretKey);
    let ok = 0;
    for (const r of results) {
      if (r.error) {
        console.log(`  ❌ ${r.candidate.id}: ${r.error}`);
      } else {
        console.log(`  ✅ ${r.candidate.id} → ${r.event.id.substring(0, 16)}...`);
        ok++;
      }
    }
    console.log(`\n📡 Published ${ok}/${results.length} attestations.`);
  }
}

async function candidatePublishCommand(args) {
  const keys = loadKeys();
  if (!keys) {
    console.error('❌ No keys found. Set NOSTR_SECRET_KEY env var or place nostr-keys.json in cwd.');
    process.exit(1);
  }

  const store = getCandidateStore();
  let publishAll = false;
  let id = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--all') publishAll = true;
    else if (!id) id = args[i];
  }

  if (publishAll) {
    // Publish all confirmed candidates
    const confirmed = store.list({ status: 'confirmed' });
    if (confirmed.length === 0) {
      console.log('📋 No confirmed candidates to publish. Confirm some first with `ai-wot candidates confirm <id>`.');
      return;
    }

    console.log(`📡 Publishing ${confirmed.length} confirmed candidate(s)...\n`);
    const results = await store.publishAllConfirmed(keys.secretKey);
    let ok = 0;
    for (const r of results) {
      if (r.error) {
        console.log(`  ❌ ${r.candidate.id}: ${r.error}`);
      } else {
        console.log(`  ✅ ${r.candidate.id} → ${r.event.id.substring(0, 16)}...`);
        ok++;
      }
    }
    console.log(`\n📡 Published ${ok}/${results.length} attestations.`);
    return;
  }

  if (!id) {
    console.error('Usage: ai-wot candidates publish <id> | ai-wot candidates publish --all');
    process.exit(1);
  }

  // Confirm + publish a single candidate
  const c = store.get(id);
  if (!c) {
    console.error(`❌ Candidate ${id} not found.`);
    process.exit(1);
  }

  console.log(`📡 Publishing candidate ${id}...`);
  console.log(`   Type: ${c.type}`);
  console.log(`   Target: ${c.targetPubkey.substring(0, 16)}...`);
  console.log(`   Comment: "${c.comment}"\n`);

  const result = await store.confirmAndPublish(id, keys.secretKey);
  if (!result) {
    console.error(`❌ Could not publish candidate ${id} (not pending/confirmed?).`);
    process.exit(1);
  }

  const successCount = result.results.filter(r => r.success).length;
  for (const r of result.results) {
    console.log(`  ${r.relay}: ${r.success ? '✅' : '❌ ' + (r.reason || 'Failed')}`);
  }
  console.log(`\n✅ Published to ${successCount}/${result.results.length} relays`);
  console.log(`🔗 View: https://primal.net/e/${result.event.id}`);
}

async function candidateStatsCommand() {
  const store = getCandidateStore();
  const stats = store.stats();

  console.log('📊 Candidate Store Stats:\n');
  console.log(`   Pending:    ${stats.pending}`);
  console.log(`   Confirmed:  ${stats.confirmed}`);
  console.log(`   Published:  ${stats.published}`);
  console.log(`   Rejected:   ${stats.rejected}`);
  console.log(`   Expired:    ${stats.expired}`);
  console.log(`   ─────────────────`);
  console.log(`   Total:      ${stats.total}`);
  console.log(`\n   File: ${CANDIDATES_FILE}`);
}

function helpCommand() {
  console.log(`
╔══════════════════════════════════════════════════════╗
║   ai-wot — Web of Trust for AI Agents on Nostr      ║
║   Version ${VERSION} • Protocol: ai.wot                  ║
╚══════════════════════════════════════════════════════╝

Commands:

  Positive Attestations:
    attest <pubkey> <type> "<comment>"
      Publish an attestation about another agent.
      Types: service-quality, identity-continuity, general-trust
      Options: --event <event-id>  Reference a specific event

  Negative Attestations:
    dispute <pubkey> "<reason>"
      Flag an agent for fraud, scams, or deliberate harm (-1.5x weight).
      Reason is REQUIRED.

    warn <pubkey> "<reason>"
      Flag an agent for unreliable/sketchy behavior (-0.8x weight).
      Reason is REQUIRED.

  Revocations:
    revoke <event-id> "<reason>"
      Revoke a previous attestation you published (NIP-09 deletion).

  DVM Receipts (v0.4.0):
    receipt <dvm-result-event-id> [options]
      Publish a service-quality attestation referencing a DVM interaction.
      Closes the economy→trust loop: pay for service → attest quality.
      Options:
        --amount <sats>      Amount paid
        --rating <1-5>       Quality rating
        --comment "<text>"   Additional note

    dvm-history [options]
      View your DVM interaction history and attestation status.
      Options:
        --kinds 5050,5100    Filter by DVM request kinds
        --unattested         Show only unattested interactions

    batch <file.json>
      Publish attestations for multiple agents from a JSON file.
      Format: [{ "pubkey": "...", "type": "...", "comment": "..." }, ...]

  Queries:
    lookup <pubkey>     Full trust profile with diversity metrics
    score <pubkey>      Trust score summary
    my-score            Your own trust score

  Candidates (v0.7.0):
    candidates [--status pending] [--source dvm] [--limit 10]
      List attestation candidates (default: pending).

    candidates confirm <id> [--comment "..."] [--type ...]
      Confirm a candidate for publishing.

    candidates reject <id> [--reason "..."]
      Reject a candidate.

    candidates confirm-all [--source dvm] [--publish]
      Confirm all pending candidates. With --publish, also publish.

    candidates publish [<id>|--all]
      Publish a confirmed candidate (or --all confirmed) to relays.

    candidates stats
      Show candidate store statistics.

  Other:
    help                Show this help message

Negative Attestation Rules:
  • Only agents with trust ≥ 20 can issue effective negative attestations
  • Empty-content negative attestations are ignored
  • This prevents sybil attacks from disposable identities

Environment:
  NOSTR_SECRET_KEY    Hex-encoded 32-byte secret key
  AI_WOT_PORT         Server port (default: 3000)

Examples:
  ai-wot attest abc123...def service-quality "Great DVM output"
  ai-wot receipt abc123...def --amount 21 --rating 5 --comment "Fast translation"
  ai-wot dvm-history --unattested
  ai-wot batch targets.json
  ai-wot dispute abc123...def "Sent garbage output after payment"
  ai-wot revoke evt123...def "Issue was resolved"
  ai-wot score abc123...def
  ai-wot my-score
`);
}

// ─── Main ───────────────────────────────────────────────────────

const COMMANDS = {
  attest: attestCommand,
  dispute: disputeCommand,
  warn: warnCommand,
  revoke: revokeCommand,
  receipt: receiptCommand,
  batch: batchCommand,
  'dvm-history': dvmHistoryCommand,
  candidates: candidatesCommand,
  lookup: lookupCommand,
  score: scoreCommand,
  'my-score': myScoreCommand,
  help: helpCommand
};

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || !COMMANDS[command]) {
    helpCommand();
    process.exit(command ? 1 : 0);
  }

  try {
    await COMMANDS[command](args.slice(1));
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
