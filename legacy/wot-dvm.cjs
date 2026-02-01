#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  Jeletor WoT Lookup DVM — FREE trust profile lookups
//  Kind 5050 (text generation) — responds to "wot:" / "trust:" queries
//  Part of the ai.wot Web of Trust protocol
// ═══════════════════════════════════════════════════════════════

const { finalizeEvent, verifyEvent } = require('nostr-tools/pure');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const wot = require('./wot.cjs');

// ─── Config ───

const DIR = __dirname;
const keys = JSON.parse(fs.readFileSync(path.join(DIR, '..', 'nostr-keys.json'), 'utf-8'));
const sk = Uint8Array.from(Buffer.from(keys.secretKeyHex, 'hex'));
const myPubkey = keys.publicKeyHex;

const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social'
];

const DVM_KIND_REQUEST = 5050;
const DVM_KIND_RESULT = 6050;
const DVM_KIND_FEEDBACK = 7000;
const RELAY_TIMEOUT_MS = 15000;
const RECONNECT_DELAY_MS = 15000;

const processed = new Set();
const connections = new Map(); // url → ws

// ─── Helpers ───

function log(msg) {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function isHexPubkey(s) {
  return /^[0-9a-f]{64}$/i.test(s);
}

function parseWotQuery(input) {
  // Match: "wot:<pubkey>" or "trust:<pubkey>" (with optional spaces)
  const match = input.trim().match(/^(?:wot|trust)\s*:\s*([0-9a-f]{64})\s*$/i);
  if (match) return match[1].toLowerCase();

  // Also match just a bare hex pubkey after the prefix with any casing
  const match2 = input.trim().match(/^(?:wot|trust)\s*:\s*(.+)$/i);
  if (match2) {
    const candidate = match2[1].trim();
    if (isHexPubkey(candidate)) return candidate.toLowerCase();
  }

  return null;
}

// ─── WebSocket Relay Management ───

function sendToRelay(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function publishEvent(event) {
  const promises = [];
  for (const [url, ws] of connections) {
    if (ws.readyState === WebSocket.OPEN) {
      promises.push(new Promise(resolve => {
        const timeout = setTimeout(() => resolve({ relay: url, success: false, reason: 'timeout' }), 8000);
        const handler = (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg[0] === 'OK' && msg[1] === event.id) {
              clearTimeout(timeout);
              ws.removeListener('message', handler);
              resolve({ relay: url, success: msg[2], reason: msg[3] });
            }
          } catch (_) {}
        };
        ws.on('message', handler);
        sendToRelay(ws, ['EVENT', event]);
      }));
    }
  }
  return Promise.all(promises);
}

// ─── DVM Event Builders ───

function buildFeedback(requestEvent, status, content) {
  return finalizeEvent({
    kind: DVM_KIND_FEEDBACK,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['status', status, ''],
      ['e', requestEvent.id],
      ['p', requestEvent.pubkey]
    ],
    content: content || ''
  }, sk);
}

function buildResult(requestEvent, content) {
  return finalizeEvent({
    kind: DVM_KIND_RESULT,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['request', JSON.stringify(requestEvent)],
      ['e', requestEvent.id],
      ['p', requestEvent.pubkey]
      // No amount tag — this DVM is FREE
    ],
    content
  }, sk);
}

// ─── Request Handler ───

async function handleRequest(event) {
  if (processed.has(event.id)) return;
  processed.add(event.id);

  // Extract input text
  const inputTags = event.tags.filter(t => t[0] === 'i');
  const inputs = inputTags.map(t => t[1]).join('\n');
  const input = inputs || event.content || '';

  log(`Request from ${event.pubkey.substring(0, 12)}... — input: "${input.substring(0, 60)}"`);

  // Check if this is a WoT query
  const targetPubkey = parseWotQuery(input);
  if (!targetPubkey) {
    // Not a WoT query — ignore silently (let other DVMs handle it)
    log(`  ↳ Not a WoT query, ignoring`);
    return;
  }

  log(`  ↳ WoT lookup for ${targetPubkey.substring(0, 16)}...`);

  // Send processing feedback
  const feedbackEvent = buildFeedback(event, 'processing', '🔍 Looking up trust profile...');
  await publishEvent(feedbackEvent);

  try {
    // Get the full attestation summary
    const summary = await wot.getAttestationSummary(targetPubkey);

    // Build response
    const response = [
      summary,
      '',
      '─────────────────────────────────────',
      '🌀 Powered by ai.wot — Nostr Web of Trust for AI Agents',
      `📡 Query: wot:${targetPubkey}`,
      '💡 Attest: node wot-cli.cjs attest <pubkey> <type> "<comment>"',
      '🆓 This lookup is FREE — a public good for the Nostr ecosystem'
    ].join('\n');

    const resultEvent = buildResult(event, response);
    const results = await publishEvent(resultEvent);
    const ok = results.filter(r => r.success).length;
    log(`  ✅ Result delivered to ${ok}/${results.length} relays (${response.length} chars)`);
  } catch (err) {
    log(`  ❌ Error: ${err.message}`);
    const errorEvent = buildFeedback(event, 'error', `Error: ${err.message}`);
    await publishEvent(errorEvent);
  }
}

// ─── DVM Announcement (kind 31990) ───

async function publishAnnouncement() {
  const event = finalizeEvent({
    kind: 31990,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', 'jeletor-wot-lookup'],
      ['k', '5050'],
      ['t', 'wot'],
      ['t', 'trust'],
      ['t', 'reputation'],
      ['t', 'ai-agents'],
      // NIP-89 handler information
      ['web', 'https://primal.net/p/' + keys.npub, 'profile'],
      ['amount', '0', 'free'],
      ['nip90Params', 'input', 'text', 'Format: wot:<hex-pubkey> or trust:<hex-pubkey>']
    ],
    content: JSON.stringify({
      name: 'Jeletor WoT Lookup',
      about: 'Free Web of Trust profile lookups for AI agents on Nostr. Send "wot:<hex-pubkey>" or "trust:<hex-pubkey>" as input to get the full trust profile, attestation history, and trust score for any agent. Part of the ai.wot protocol.',
      picture: '',
      nip90: {
        input: 'text — "wot:<hex-pubkey>" or "trust:<hex-pubkey>"',
        output: 'text — formatted trust profile with score, attestation breakdown, and details',
        pricing: 'FREE — this is a public good'
      }
    })
  }, sk);

  log('Publishing DVM announcement (kind 31990)...');
  const results = await wot.publishToRelays(event, RELAYS);
  for (const r of results) {
    log(`  ${r.relay}: ${r.success ? '✅' : '❌ ' + (r.reason || 'Failed')}`);
  }
  const ok = results.filter(r => r.success).length;
  log(`Announcement published to ${ok}/${results.length} relays`);
  return event;
}

// ─── Relay Connection ───

function connectRelay(url) {
  if (connections.has(url)) {
    const existing = connections.get(url);
    if (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING) {
      return;
    }
    try { existing.close(); } catch (_) {}
  }

  log(`Connecting to ${url}...`);
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    log(`❌ ${url}: ${err.message}`);
    setTimeout(() => connectRelay(url), RECONNECT_DELAY_MS);
    return;
  }

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);

  ws.on('open', () => {
    connections.set(url, ws);
    log(`✅ Connected to ${url}`);

    const now = Math.floor(Date.now() / 1000);
    const subId = 'wot_dvm_' + Math.random().toString(36).slice(2, 8);

    // Subscribe to kind 5050 requests (both targeted and broadcast)
    sendToRelay(ws, ['REQ', subId, {
      kinds: [DVM_KIND_REQUEST],
      '#p': [myPubkey],
      since: now
    }]);

    // Also subscribe to broadcast requests (not p-tagged)
    const subId2 = 'wot_dvm_bc_' + Math.random().toString(36).slice(2, 8);
    sendToRelay(ws, ['REQ', subId2, {
      kinds: [DVM_KIND_REQUEST],
      since: now
    }]);
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg[0] === 'EVENT' && msg[2]) {
        const event = msg[2];
        if (event.kind === DVM_KIND_REQUEST) {
          handleRequest(event).catch(e =>
            log(`Handler error: ${e.message}`)
          );
        }
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    connections.delete(url);
    log(`⚠️ Disconnected from ${url}, reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    setTimeout(() => connectRelay(url), RECONNECT_DELAY_MS);
  });

  ws.on('error', (err) => {
    log(`❌ ${url} error: ${err.message}`);
  });
}

// ─── Main ───

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  🔍 Jeletor WoT Lookup DVM');
  console.log('  Kind: 5050 → trust profile lookups');
  console.log('  Protocol: ai.wot (NIP-32 labels)');
  console.log('  Pricing: FREE 🆓');
  console.log(`  Pubkey: ${myPubkey.substring(0, 20)}...`);
  console.log('  Query format: wot:<hex-pubkey>');
  console.log('═══════════════════════════════════════════════\n');

  // Publish DVM announcement
  try {
    await publishAnnouncement();
  } catch (e) {
    log(`⚠️ Announcement failed: ${e.message}`);
  }

  // Connect to all relays
  for (const url of RELAYS) {
    connectRelay(url);
    // Stagger connections slightly
    await new Promise(r => setTimeout(r, 500));
  }

  // Heartbeat every 5 min
  setInterval(() => {
    log(`heartbeat — ${processed.size} lookups, ${[...connections.values()].filter(ws => ws.readyState === WebSocket.OPEN).length} relays`);
  }, 5 * 60 * 1000);

  // Re-publish announcement every 6 hours (keeps it fresh)
  setInterval(() => {
    publishAnnouncement().catch(e => log(`Announcement refresh failed: ${e.message}`));
  }, 6 * 60 * 60 * 1000);

  // Clean up processed set every hour
  setInterval(() => { processed.clear(); }, 60 * 60 * 1000);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
