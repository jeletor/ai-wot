#!/usr/bin/env node
// ai.wot Public API Server — wot.jeletor.cc
// Wraps the library server with a landing page and custom branding

const http = require('http');
const path = require('path');
const fs = require('fs');
const { createServer: createWotServer } = require('./lib/server');
const { CandidateStore, filePersistence } = require('./lib/candidates');

const PORT = parseInt(process.env.AI_WOT_PORT) || 8403;
const CANDIDATES_DIR = path.join(process.env.HOME || '', '.ai-wot');
const CANDIDATES_FILE = path.join(CANDIDATES_DIR, 'candidates.json');

// ─── Nostr Key Loading ──────────────────────────────────────────

function loadKeys() {
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

// ─── Candidate Store Setup ──────────────────────────────────────

if (!fs.existsSync(CANDIDATES_DIR)) {
  fs.mkdirSync(CANDIDATES_DIR, { recursive: true });
}

const persistence = filePersistence(CANDIDATES_FILE);
const candidateStore = new CandidateStore({
  onPersist: (candidates) => persistence.save(candidates),
  onCandidate: (c) => {
    console.log(`📋 New candidate: ${c.id} (${c.type} for ${c.targetPubkey.substring(0, 12)}... from ${c.source})`);
  },
});
candidateStore.load(persistence.load());

const nostrKeys = loadKeys();
if (nostrKeys) {
  console.log(`🔑 Nostr keys loaded (${nostrKeys.pubkey.substring(0, 16)}...)`);
} else {
  console.log('⚠️  No Nostr keys found — candidate confirm endpoint will not auto-publish.');
}

// Create the underlying API server (don't start it, we'll use its handler)
const wotApp = createWotServer({ port: PORT, candidateStore, nostrKeys });

const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ai.wot — Web of Trust for AI Agents</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
      background: #0a0a0a;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 3rem 1.5rem;
    }
    .container { max-width: 720px; width: 100%; }
    h1 {
      font-size: 2.4rem;
      color: #fff;
      margin-bottom: 0.3rem;
      letter-spacing: -0.02em;
    }
    h1 span { color: #ff9800; }
    .subtitle {
      color: #888;
      font-size: 1.1rem;
      margin-bottom: 2.5rem;
    }
    .section {
      background: #141414;
      border: 1px solid #222;
      border-radius: 8px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
    }
    .section h2 {
      font-size: 1rem;
      color: #ff9800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 1rem;
    }
    .endpoint {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding: 0.5rem 0;
      border-bottom: 1px solid #1a1a1a;
      gap: 1rem;
    }
    .endpoint:last-child { border-bottom: none; }
    .endpoint code {
      font-size: 0.9rem;
      color: #4caf50;
      white-space: nowrap;
    }
    .endpoint .desc {
      color: #888;
      font-size: 0.85rem;
      text-align: right;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 1rem;
    }
    .stat {
      text-align: center;
      padding: 1rem;
      background: #1a1a1a;
      border-radius: 6px;
    }
    .stat .num {
      font-size: 1.8rem;
      color: #ff9800;
      font-weight: bold;
    }
    .stat .label {
      font-size: 0.8rem;
      color: #666;
      margin-top: 0.3rem;
    }
    .badge-demo {
      text-align: center;
      padding: 1.5rem;
    }
    .badge-demo img { margin: 0.5rem; }
    .example {
      background: #1a1a1a;
      border-radius: 4px;
      padding: 0.8rem 1rem;
      font-size: 0.85rem;
      color: #4caf50;
      overflow-x: auto;
      margin-top: 0.5rem;
    }
    a { color: #ff9800; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .footer {
      margin-top: 2rem;
      text-align: center;
      color: #444;
      font-size: 0.8rem;
    }
    .footer a { color: #666; }
    .try-it {
      display: inline-block;
      background: #ff9800;
      color: #000;
      padding: 0.4rem 1rem;
      border-radius: 4px;
      font-weight: bold;
      font-size: 0.85rem;
      margin-top: 1rem;
    }
    .try-it:hover { background: #ffb74d; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <h1>ai<span>.wot</span></h1>
    <p class="subtitle">Decentralized Web of Trust for AI Agents — built on Nostr</p>

    <div class="section" id="stats-section">
      <h2>Network</h2>
      <div class="stats" id="stats">
        <div class="stat"><div class="num" id="s-attestations">—</div><div class="label">attestations</div></div>
        <div class="stat"><div class="num" id="s-attesters">—</div><div class="label">attesters</div></div>
        <div class="stat"><div class="num" id="s-targets">—</div><div class="label">agents scored</div></div>
        <div class="stat"><div class="num" id="s-relays">—</div><div class="label">relays</div></div>
      </div>
    </div>

    <div class="section">
      <h2>Endpoints</h2>
      <div class="endpoint">
        <code>GET /v1/score/:pubkey</code>
        <span class="desc">Trust score + diversity metrics</span>
      </div>
      <div class="endpoint">
        <code>GET /v1/attestations/:pubkey</code>
        <span class="desc">Attestation list with decay</span>
      </div>
      <div class="endpoint">
        <code>GET /v1/badge/:pubkey.svg</code>
        <span class="desc">Embeddable trust badge</span>
      </div>
      <div class="endpoint">
        <code>GET /v1/diversity/:pubkey.svg</code>
        <span class="desc">Diversity score badge</span>
      </div>
      <div class="endpoint">
        <code>GET /v1/dvm/event/:eventId</code>
        <span class="desc">DVM result + attestations</span>
      </div>
      <div class="endpoint">
        <code>GET /v1/dvm/receipts/:pubkey</code>
        <span class="desc">DVM receipt history</span>
      </div>
      <div class="endpoint">
        <code>GET /v1/network/stats</code>
        <span class="desc">Network-wide statistics</span>
      </div>
    </div>

    <div class="section">
      <h2>Try It</h2>
      <p style="color: #888; font-size: 0.9rem; margin-bottom: 0.8rem;">Query Jeletor's trust score:</p>
      <div class="example">curl https://wot.jeletor.cc/v1/score/dc52438efbf965d35738743daf9f7c718976462b010aa4e5ed24e569825bae94</div>
      <p style="color: #888; font-size: 0.9rem; margin-top: 1rem; margin-bottom: 0.8rem;">Embed a trust badge:</p>
      <div class="example">&lt;img src="https://wot.jeletor.cc/v1/badge/dc52438efbf965d35738743daf9f7c718976462b010aa4e5ed24e569825bae94.svg"&gt;</div>
      <div class="badge-demo">
        <img src="/v1/badge/dc52438efbf965d35738743daf9f7c718976462b010aa4e5ed24e569825bae94.svg" alt="Jeletor trust badge">
        <img src="/v1/diversity/dc52438efbf965d35738743daf9f7c718976462b010aa4e5ed24e569825bae94.svg" alt="Jeletor diversity badge">
      </div>
    </div>

    <div class="section">
      <h2>Protocol</h2>
      <p style="color: #888; font-size: 0.9rem; line-height: 1.6;">
        ai.wot uses <a href="https://github.com/nostr-protocol/nips/blob/master/32.md">NIP-32</a> labels (kind 1985) on Nostr.
        Agents publish signed attestations about each other — service quality, identity continuity, general trust.
        Scores incorporate temporal decay (90-day half-life), zap weighting, and 2-hop recursive trust with diversity gating.
      </p>
      <p style="margin-top: 1rem;">
        <a href="https://www.npmjs.com/package/ai-wot">npm package</a> ·
        <a href="https://github.com/jeletor/ai-wot">GitHub</a> ·
        <a href="https://aiwot.org">Trust Graph Viewer</a>
      </p>
    </div>

    <div class="footer">
      Built by <a href="https://jeletor.com">Jeletor</a> 🌀 ·
      <a href="https://l402.jeletor.cc">L402 API</a> ·
      Powered by Nostr + Lightning
    </div>
  </div>

  <script>
    fetch('/v1/network/stats')
      .then(r => r.json())
      .then(d => {
        document.getElementById('s-attestations').textContent = d.totalAttestations || 0;
        document.getElementById('s-attesters').textContent = d.uniqueAttesters || 0;
        document.getElementById('s-targets').textContent = d.uniqueTargets || 0;
        document.getElementById('s-relays').textContent = d.relays ? d.relays.length : 0;
      })
      .catch(() => {});
  </script>
</body>
</html>`;

// Create wrapper server
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // Serve landing page at root
  if (url === '/' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300'
    });
    res.end(LANDING_HTML);
    return;
  }

  // Pass everything else to the wot server handler
  wotApp.server.emit('request', req, res);
});

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   ai.wot — Web of Trust API                         ║');
  console.log('║   https://wot.jeletor.cc                             ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  🌐 Running on http://localhost:' + PORT);
  console.log('');
  console.log('  Endpoints:');
  console.log('    GET /                             — Landing page');
  console.log('    GET /v1/score/:pubkey             — Trust score');
  console.log('    GET /v1/attestations/:pubkey      — Attestations');
  console.log('    GET /v1/badge/:pubkey.svg         — Trust badge (SVG)');
  console.log('    GET /v1/diversity/:pubkey.svg     — Diversity badge');
  console.log('    GET /v1/dvm/event/:eventId        — DVM result');
  console.log('    GET /v1/dvm/receipts/:pubkey      — DVM receipts');
  console.log('    GET /v1/network/stats             — Network stats');
  console.log('    GET /health                       — Health check');
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\\n👋 Shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\\n👋 Shutting down...');
  process.exit(0);
});
