// ai-wot — REST API Server
// v0.3.0: Diversity metrics, negative attestation display, revocation info

const http = require('http');
const wot = require('./wot');
const { temporalDecay, NEGATIVE_TYPES } = require('./scoring');

const VERSION = '0.3.0';

// ─── Cache ──────────────────────────────────────────────────────

const cache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// ─── Badge SVG ──────────────────────────────────────────────────

function generateBadgeSvg(score, label = 'ai.wot trust') {
  let color, textColor;
  if (score === null || score === undefined) {
    color = '#9e9e9e'; // gray
    textColor = '#fff';
    score = '?';
  } else if (score >= 70) {
    color = '#4caf50'; // green
    textColor = '#fff';
  } else if (score >= 30) {
    color = '#ff9800'; // yellow/amber
    textColor = '#000';
  } else {
    color = '#f44336'; // red
    textColor = '#fff';
  }

  const labelWidth = 80;
  const valueWidth = 46;
  const totalWidth = labelWidth + valueWidth;
  const scoreText = typeof score === 'number' ? `${score}/100` : score;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${label}: ${scoreText}">
  <title>${label}: ${scoreText}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text aria-hidden="true" x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelWidth / 2}" y="14">${label}</text>
    <text aria-hidden="true" x="${labelWidth + valueWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${scoreText}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14" fill="${textColor}">${scoreText}</text>
  </g>
</svg>`;
}

// ─── Diversity Badge SVG ────────────────────────────────────────

function generateDiversityBadgeSvg(diversity, label = 'diversity') {
  let color;
  if (diversity === null || diversity === undefined) {
    color = '#9e9e9e';
    diversity = '?';
  } else if (diversity >= 0.6) {
    color = '#4caf50'; // green — well distributed
  } else if (diversity >= 0.3) {
    color = '#ff9800'; // yellow — moderate
  } else {
    color = '#f44336'; // red — concentrated
  }

  const labelWidth = 64;
  const valueWidth = 40;
  const totalWidth = labelWidth + valueWidth;
  const text = typeof diversity === 'number' ? diversity.toFixed(2) : diversity;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${label}: ${text}">
  <title>${label}: ${text}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text aria-hidden="true" x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelWidth / 2}" y="14">${label}</text>
    <text aria-hidden="true" x="${labelWidth + valueWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${text}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14">${text}</text>
  </g>
</svg>`;
}

// ─── Route Matching ─────────────────────────────────────────────

function matchRoute(url) {
  let m;

  // GET /v1/score/:pubkey
  m = url.match(/^\/v1\/score\/([0-9a-fA-F]{64})$/);
  if (m) return { handler: 'score', pubkey: m[1].toLowerCase() };

  // GET /v1/attestations/:pubkey
  m = url.match(/^\/v1\/attestations\/([0-9a-fA-F]{64})$/);
  if (m) return { handler: 'attestations', pubkey: m[1].toLowerCase() };

  // GET /v1/badge/:pubkey.svg
  m = url.match(/^\/v1\/badge\/([0-9a-fA-F]{64})\.svg$/);
  if (m) return { handler: 'badge', pubkey: m[1].toLowerCase() };

  // GET /v1/diversity/:pubkey.svg
  m = url.match(/^\/v1\/diversity\/([0-9a-fA-F]{64})\.svg$/);
  if (m) return { handler: 'diversityBadge', pubkey: m[1].toLowerCase() };

  // GET /v1/network/stats
  if (url === '/v1/network/stats') return { handler: 'stats' };

  // GET /health
  if (url === '/health') return { handler: 'health' };

  return null;
}

// ─── Handlers ───────────────────────────────────────────────────

async function handleScore(pubkey) {
  const cacheKey = `score:${pubkey}`;
  let data = getCached(cacheKey);
  if (!data) {
    const score = await wot.calculateTrustScore(pubkey);
    data = {
      pubkey,
      score: score.display,
      raw: score.raw,
      attestationCount: score.attestationCount,
      positiveCount: score.positiveCount,
      negativeCount: score.negativeCount,
      gatedCount: score.gatedCount,
      diversity: score.diversity,
      breakdown: score.breakdown.map(b => ({
        attester: b.attester,
        type: b.type,
        contribution: b.contribution,
        decayFactor: b.decayFactor,
        zapSats: b.zapSats,
        timestamp: b.timestamp,
        gated: b.gated || false,
        gateReason: b.gateReason || undefined
      }))
    };
    setCache(cacheKey, data);
  }
  return { status: 200, body: data };
}

async function handleAttestations(pubkey) {
  const cacheKey = `att:${pubkey}`;
  let data = getCached(cacheKey);
  if (!data) {
    const attestations = await wot.queryAttestations(pubkey);
    data = {
      pubkey,
      count: attestations.length,
      revokedCount: attestations._revokedCount || 0,
      attestations: attestations.map(a => {
        const lTag = a.tags.find(t => t[0] === 'l' && t[2] === wot.NAMESPACE);
        const type = lTag ? lTag[1] : 'unknown';
        return {
          id: a.id,
          attester: a.pubkey,
          type,
          isNegative: NEGATIVE_TYPES.includes(type),
          comment: a.content || '',
          created_at: a.created_at,
          age_days: Math.round((Date.now() / 1000 - a.created_at) / 86400 * 10) / 10,
          decay: Math.round(temporalDecay(a.created_at) * 1000) / 1000
        };
      }).sort((a, b) => b.created_at - a.created_at)
    };
    setCache(cacheKey, data);
  }
  return { status: 200, body: data };
}

async function handleBadge(pubkey) {
  const cacheKey = `badge:${pubkey}`;
  let svg = getCached(cacheKey);
  if (!svg) {
    try {
      const score = await wot.calculateTrustScore(pubkey);
      svg = generateBadgeSvg(score.display);
    } catch (e) {
      svg = generateBadgeSvg(null);
    }
    setCache(cacheKey, svg);
  }
  return { status: 200, body: svg, contentType: 'image/svg+xml' };
}

async function handleDiversityBadge(pubkey) {
  const cacheKey = `divbadge:${pubkey}`;
  let svg = getCached(cacheKey);
  if (!svg) {
    try {
      const score = await wot.calculateTrustScore(pubkey);
      svg = generateDiversityBadgeSvg(score.diversity.diversity);
    } catch (e) {
      svg = generateDiversityBadgeSvg(null);
    }
    setCache(cacheKey, svg);
  }
  return { status: 200, body: svg, contentType: 'image/svg+xml' };
}

async function handleStats() {
  const cacheKey = 'stats';
  let data = getCached(cacheKey);
  if (!data) {
    const filter = {
      kinds: [1985],
      '#L': ['ai.wot'],
      limit: 200
    };
    const events = await wot.queryRelays(filter);

    const uniqueAttesters = new Set();
    const uniqueTargets = new Set();
    const typeCounts = {};
    let oldest = Infinity;
    let newest = 0;
    let positiveCount = 0;
    let negativeCount = 0;

    for (const e of events) {
      uniqueAttesters.add(e.pubkey);
      const pTag = e.tags.find(t => t[0] === 'p');
      if (pTag) uniqueTargets.add(pTag[1]);
      const lTag = e.tags.find(t => t[0] === 'l' && t[2] === 'ai.wot');
      if (lTag) {
        typeCounts[lTag[1]] = (typeCounts[lTag[1]] || 0) + 1;
        if (NEGATIVE_TYPES.includes(lTag[1])) {
          negativeCount++;
        } else {
          positiveCount++;
        }
      }
      if (e.created_at < oldest) oldest = e.created_at;
      if (e.created_at > newest) newest = e.created_at;
    }

    // Check for revocations
    const revoked = await wot.queryRevocations([...uniqueAttesters]);

    data = {
      totalAttestations: events.length,
      positiveAttestations: positiveCount,
      negativeAttestations: negativeCount,
      revokedAttestations: revoked.size,
      uniqueAttesters: uniqueAttesters.size,
      uniqueTargets: uniqueTargets.size,
      typeCounts,
      oldestAttestation: oldest === Infinity ? null : new Date(oldest * 1000).toISOString(),
      newestAttestation: newest === 0 ? null : new Date(newest * 1000).toISOString(),
      relays: wot.RELAYS,
      protocol: 'ai.wot',
      version: VERSION
    };
    setCache(cacheKey, data);
  }
  return { status: 200, body: data };
}

// ─── Server ─────────────────────────────────────────────────────

function createServer(opts = {}) {
  const port = opts.port || process.env.AI_WOT_PORT || 3000;

  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const url = req.url.split('?')[0];
    const route = matchRoute(url);

    if (!route) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Not found',
        endpoints: [
          'GET /v1/score/:pubkey',
          'GET /v1/attestations/:pubkey',
          'GET /v1/badge/:pubkey.svg',
          'GET /v1/diversity/:pubkey.svg',
          'GET /v1/network/stats',
          'GET /health'
        ]
      }));
      return;
    }

    try {
      let result;

      switch (route.handler) {
        case 'score':
          result = await handleScore(route.pubkey);
          break;
        case 'attestations':
          result = await handleAttestations(route.pubkey);
          break;
        case 'badge':
          result = await handleBadge(route.pubkey);
          break;
        case 'diversityBadge':
          result = await handleDiversityBadge(route.pubkey);
          break;
        case 'stats':
          result = await handleStats();
          break;
        case 'health':
          result = { status: 200, body: { status: 'ok', version: VERSION, protocol: 'ai.wot' } };
          break;
      }

      const contentType = result.contentType || 'application/json';
      res.writeHead(result.status, { 'Content-Type': contentType });

      if (contentType === 'image/svg+xml') {
        res.end(result.body);
      } else {
        res.end(JSON.stringify(result.body, null, 2));
      }
    } catch (err) {
      console.error(`Error handling ${url}:`, err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  return {
    server,
    start() {
      return new Promise((resolve) => {
        server.listen(port, () => {
          console.log(`🌐 ai.wot REST API server v${VERSION} running on http://localhost:${port}`);
          console.log('');
          console.log('  Endpoints:');
          console.log(`    GET /v1/score/:pubkey          — Trust score + diversity`);
          console.log(`    GET /v1/attestations/:pubkey   — Attestation list`);
          console.log(`    GET /v1/badge/:pubkey.svg      — Trust badge (SVG)`);
          console.log(`    GET /v1/diversity/:pubkey.svg  — Diversity badge (SVG)`);
          console.log(`    GET /v1/network/stats          — Network statistics`);
          console.log(`    GET /health                    — Health check`);
          console.log('');
          resolve(server);
        });
      });
    },
    stop() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

module.exports = { createServer, generateBadgeSvg, generateDiversityBadgeSvg };
