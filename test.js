#!/usr/bin/env node
// ai-wot — Test Suite
// Verifies scoring math: temporal decay, type multipliers, zap weights, normalization

const { temporalDecay, zapWeight, calculateTrustScore, TYPE_MULTIPLIERS, DEFAULT_HALF_LIFE_DAYS } = require('./lib/scoring');
const { generateBadgeSvg } = require('./lib/server');

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}`);
    failed++;
  }
}

function approxEqual(a, b, epsilon = 0.01) {
  return Math.abs(a - b) < epsilon;
}

// ─── Temporal Decay Tests ───────────────────────────────────────

console.log('\n📐 Temporal Decay');

const now = 1738368000; // fixed reference point

// Brand new attestation (0 days old)
assert(approxEqual(temporalDecay(now, 90, now), 1.0), 'Fresh attestation → decay = 1.0');

// 90 days old (one half-life)
const age90 = now - (90 * 86400);
assert(approxEqual(temporalDecay(age90, 90, now), 0.5), '90 days old → decay = 0.5');

// 180 days old (two half-lives)
const age180 = now - (180 * 86400);
assert(approxEqual(temporalDecay(age180, 90, now), 0.25), '180 days old → decay = 0.25');

// 45 days old (half a half-life)
const age45 = now - (45 * 86400);
assert(approxEqual(temporalDecay(age45, 90, now), 0.707, 0.01), '45 days old → decay ≈ 0.707');

// 360 days old (four half-lives)
const age360 = now - (360 * 86400);
assert(approxEqual(temporalDecay(age360, 90, now), 0.0625), '360 days old → decay = 0.0625');

// Custom half-life (30 days)
const age30 = now - (30 * 86400);
assert(approxEqual(temporalDecay(age30, 30, now), 0.5), '30 days with 30-day half-life → 0.5');

// Future attestation (should clamp to 1.0)
assert(approxEqual(temporalDecay(now + 1000, 90, now), 1.0), 'Future attestation → decay = 1.0');

// ─── Zap Weight Tests ───────────────────────────────────────────

console.log('\n⚡ Zap Weight');

assert(approxEqual(zapWeight(0), 1.0), '0 sats → weight = 1.0');
assert(approxEqual(zapWeight(100), 1.0 + Math.log2(101) * 0.5), '100 sats → correct log weight');
assert(approxEqual(zapWeight(1000), 1.0 + Math.log2(1001) * 0.5), '1000 sats → correct log weight');
assert(zapWeight(100) > zapWeight(0), 'More sats → higher weight');
assert(zapWeight(1000) > zapWeight(100), 'Even more sats → even higher');
assert(zapWeight(-10) === 1.0, 'Negative sats → base weight');

// ─── Type Multiplier Tests ──────────────────────────────────────

console.log('\n🏷️  Type Multipliers');

assert(TYPE_MULTIPLIERS['service-quality'] === 1.5, 'service-quality = 1.5x');
assert(TYPE_MULTIPLIERS['identity-continuity'] === 1.0, 'identity-continuity = 1.0x');
assert(TYPE_MULTIPLIERS['general-trust'] === 0.8, 'general-trust = 0.8x');

// ─── Score Calculation Tests ────────────────────────────────────

console.log('\n📊 Score Calculation');

// Helper to create a mock attestation
function mockAttestation(pubkey, type, createdAt, id) {
  return {
    id: id || 'evt_' + Math.random().toString(36).slice(2),
    pubkey,
    created_at: createdAt,
    content: 'test attestation',
    tags: [
      ['L', 'ai.wot'],
      ['l', type, 'ai.wot'],
      ['p', 'target_pubkey']
    ]
  };
}

// Single fresh attestation, no zaps
(async () => {
  const attestations = [mockAttestation('attester1'.padEnd(64, '0'), 'service-quality', now)];
  const zapTotals = new Map();
  const result = await calculateTrustScore(attestations, zapTotals, { now });
  
  // Expected: 1.0 (zap weight) * 1.0 (attester trust) * 1.5 (type mult) * 1.0 (decay) = 1.5
  assert(approxEqual(result.raw, 1.5), 'Single fresh service-quality → raw = 1.5');
  assert(result.display === Math.min(100, Math.round(1.5 * 10)), 'Display score correct');
  assert(result.attestationCount === 1, 'Attestation count = 1');

  // Single attestation with decay
  const attestations2 = [mockAttestation('attester1'.padEnd(64, '0'), 'service-quality', now - 90 * 86400)];
  const result2 = await calculateTrustScore(attestations2, zapTotals, { now });
  // Expected: 1.0 * 1.0 * 1.5 * 0.5 = 0.75
  assert(approxEqual(result2.raw, 0.75), '90-day-old service-quality → raw = 0.75 (half weight)');

  // Multiple attestations with different types and ages
  const attestations3 = [
    mockAttestation('a'.padEnd(64, '0'), 'service-quality', now, 'evt1'),      // fresh, 1.5x
    mockAttestation('b'.padEnd(64, '0'), 'general-trust', now, 'evt2'),         // fresh, 0.8x
    mockAttestation('c'.padEnd(64, '0'), 'identity-continuity', now - 90 * 86400, 'evt3') // 90d old, 1.0x * 0.5 decay
  ];
  const result3 = await calculateTrustScore(attestations3, zapTotals, { now });
  // Expected: 1.5 + 0.8 + (1.0 * 0.5) = 2.8
  assert(approxEqual(result3.raw, 2.8), 'Mixed types and ages → raw = 2.8');
  assert(result3.attestationCount === 3, '3 attestations counted');

  // Attestation with zaps
  const attestations4 = [mockAttestation('a'.padEnd(64, '0'), 'service-quality', now, 'zapped_evt')];
  const zapTotals4 = new Map([['zapped_evt', 1000]]);
  const result4 = await calculateTrustScore(attestations4, zapTotals4, { now });
  const expectedZapWeight = 1.0 + Math.log2(1001) * 0.5;
  const expectedRaw = expectedZapWeight * 1.0 * 1.5 * 1.0;
  assert(approxEqual(result4.raw, expectedRaw), `Zapped attestation → raw ≈ ${expectedRaw.toFixed(2)}`);
  assert(result4.raw > 1.5, 'Zapped attestation > unzapped');

  // Normalization: display score capped at 100
  const manyAttestations = [];
  for (let i = 0; i < 20; i++) {
    manyAttestations.push(mockAttestation(
      String(i).padStart(64, '0'), 'service-quality', now, `evt_many_${i}`
    ));
  }
  const result5 = await calculateTrustScore(manyAttestations, zapTotals, { now });
  assert(result5.display <= 100, 'Display score capped at 100');
  assert(result5.raw > 10, 'Raw score not capped');

  // Decay breakdown included
  const attestations6 = [mockAttestation('a'.padEnd(64, '0'), 'service-quality', now - 45 * 86400, 'decay_evt')];
  const result6 = await calculateTrustScore(attestations6, zapTotals, { now });
  assert(result6.breakdown[0].decayFactor < 1.0, 'Breakdown includes decay factor < 1.0');
  assert(result6.breakdown[0].decayFactor > 0.5, 'Breakdown decay factor > 0.5 for 45-day-old');

  // ─── Badge SVG Tests ──────────────────────────────────────────

  console.log('\n🎖️  Badge SVG');

  const greenBadge = generateBadgeSvg(85);
  assert(greenBadge.includes('#4caf50'), 'Score 85 → green badge');
  assert(greenBadge.includes('85/100'), 'Score 85 → shows 85/100');

  const yellowBadge = generateBadgeSvg(50);
  assert(yellowBadge.includes('#ff9800'), 'Score 50 → yellow badge');

  const redBadge = generateBadgeSvg(15);
  assert(redBadge.includes('#f44336'), 'Score 15 → red badge');

  const grayBadge = generateBadgeSvg(null);
  assert(grayBadge.includes('#9e9e9e'), 'Unknown score → gray badge');
  assert(grayBadge.includes('?'), 'Unknown score → shows ?');

  const zeroBadge = generateBadgeSvg(0);
  assert(zeroBadge.includes('#f44336'), 'Score 0 → red badge');

  const maxBadge = generateBadgeSvg(100);
  assert(maxBadge.includes('#4caf50'), 'Score 100 → green badge');

  // ─── Summary ──────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(50));
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(50) + '\n');

  process.exit(failed > 0 ? 1 : 0);

})().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
