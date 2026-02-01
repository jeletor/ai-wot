#!/usr/bin/env node
// Nostr Web of Trust — CLI Tool
// Usage:
//   node wot-cli.cjs attest <pubkey> <type> "<comment>"
//   node wot-cli.cjs lookup <pubkey>
//   node wot-cli.cjs score <pubkey>
//   node wot-cli.cjs my-score

const path = require('path');
const wot = require('./wot.cjs');
const keys = require(path.join(__dirname, '..', 'nostr-keys.json'));

const secretKey = Buffer.from(keys.secretKeyHex, 'hex');
const myPubkey = keys.publicKeyHex;

const COMMANDS = {
  attest: attestCommand,
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

async function attestCommand(args) {
  if (args.length < 3) {
    console.error('Usage: node wot-cli.cjs attest <pubkey> <type> "<comment>" [--event <event-id>]');
    console.error('\nTypes: service-quality, identity-continuity, general-trust');
    process.exit(1);
  }

  const targetPubkey = args[0];
  const type = args[1];
  const comment = args[2];

  // Parse optional flags
  let eventRef = null;
  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--event' && args[i + 1]) {
      eventRef = args[++i];
    }
  }

  if (targetPubkey === myPubkey) {
    console.error('❌ Cannot self-attest. The protocol forbids attesting to your own pubkey.');
    process.exit(1);
  }

  console.log('📝 Publishing attestation...');
  console.log(`   Target: ${targetPubkey.substring(0, 16)}...`);
  console.log(`   Type:   ${type}`);
  console.log(`   Comment: "${comment}"`);
  if (eventRef) console.log(`   Event ref: ${eventRef}`);
  console.log('');

  const { event, results } = await wot.publishAttestation(
    secretKey,
    targetPubkey,
    type,
    comment,
    { eventRef }
  );

  console.log(`Event ID: ${event.id}`);
  console.log('');

  for (const r of results) {
    console.log(`  ${r.relay}: ${r.success ? '✅' : '❌ ' + (r.reason || 'Failed')}`);
  }

  const successCount = results.filter(r => r.success).length;
  console.log(`\nPublished to ${successCount}/${results.length} relays`);

  if (successCount > 0) {
    console.log(`\n🔗 View: https://primal.net/e/${event.id}`);
  }
}

async function lookupCommand(args) {
  const pubkey = args[0];
  if (!pubkey) {
    console.error('Usage: node wot-cli.cjs lookup <pubkey>');
    process.exit(1);
  }

  console.log('🔍 Querying attestations across relays...\n');
  const summary = await wot.getAttestationSummary(pubkey);
  console.log(summary);
}

async function scoreCommand(args) {
  const pubkey = args[0];
  if (!pubkey) {
    console.error('Usage: node wot-cli.cjs score <pubkey>');
    process.exit(1);
  }

  console.log('📊 Calculating trust score...\n');
  const score = await wot.calculateTrustScore(pubkey);

  console.log(`  Pubkey:       ${pubkey.substring(0, 16)}...${pubkey.substring(56)}`);
  console.log(`  Trust Score:  ${score.display} / 100`);
  console.log(`  Raw Score:    ${score.raw}`);
  console.log(`  Attestations: ${score.attestationCount}`);

  if (score.breakdown.length > 0) {
    console.log(`\n  Top contributors:`);
    const sorted = score.breakdown.sort((a, b) => b.contribution - a.contribution).slice(0, 5);
    for (const b of sorted) {
      console.log(`    ${b.attester.substring(0, 12)}... → ${b.type} (weight: ${b.contribution})`);
    }
  }
}

async function myScoreCommand() {
  console.log(`🤖 Looking up trust score for self (${myPubkey.substring(0, 16)}...)\n`);
  const summary = await wot.getAttestationSummary(myPubkey);
  console.log(summary);
}

function helpCommand() {
  console.log(`
╔══════════════════════════════════════════════════════╗
║   Nostr Web of Trust (WoT) CLI — ai.wot protocol    ║
╚══════════════════════════════════════════════════════╝

Commands:

  attest <pubkey> <type> "<comment>"
    Publish an attestation about another agent.
    Types: service-quality, identity-continuity, general-trust
    Options: --event <event-id>  Reference a specific event

  lookup <pubkey>
    Show the full trust profile for a pubkey.

  score <pubkey>
    Show the calculated trust score for a pubkey.

  my-score
    Show your own trust score.

  help
    Show this help message.

Examples:

  node wot-cli.cjs attest abc123...def general-trust "Reliable agent, good interactions"
  node wot-cli.cjs lookup abc123...def
  node wot-cli.cjs my-score
`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
