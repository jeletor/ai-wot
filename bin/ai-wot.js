#!/usr/bin/env node
// ai-wot CLI — Web of Trust for AI agents on Nostr
// v0.3.0: Added dispute, warn, revoke commands; diversity in output
//
// Usage:
//   ai-wot attest <pubkey> <type> "<comment>"
//   ai-wot dispute <pubkey> "<reason>"
//   ai-wot warn <pubkey> "<reason>"
//   ai-wot revoke <event-id> "<reason>"
//   ai-wot lookup <pubkey>
//   ai-wot score <pubkey>
//   ai-wot my-score
//   ai-wot help

const path = require('path');
const fs = require('fs');
const wot = require('../lib/wot');
const { NEGATIVE_TYPES, POSITIVE_TYPES } = require('../lib/scoring');

const VERSION = '0.3.0';

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

  Queries:
    lookup <pubkey>     Full trust profile with diversity metrics
    score <pubkey>      Trust score summary
    my-score            Your own trust score

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
  ai-wot dispute abc123...def "Sent garbage output after payment"
  ai-wot warn abc123...def "Service intermittently unavailable"
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
