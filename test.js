#!/usr/bin/env node
// ai-wot — Test Suite v0.3.0
// Tests: temporal decay, type multipliers, zap weights, normalization,
//        negative attestations, trust gating, diversity scoring, revocations, badges

const {
  temporalDecay, zapWeight, calculateTrustScore, calculateDiversity,
  TYPE_MULTIPLIERS, DEFAULT_HALF_LIFE_DAYS,
  VALID_TYPES, POSITIVE_TYPES, NEGATIVE_TYPES,
  NEGATIVE_ATTESTATION_TRUST_GATE
} = require('./lib/scoring');
const { generateBadgeSvg, generateDiversityBadgeSvg } = require('./lib/server');

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

assert(approxEqual(temporalDecay(now, 90, now), 1.0), 'Fresh attestation → decay = 1.0');

const age90 = now - (90 * 86400);
assert(approxEqual(temporalDecay(age90, 90, now), 0.5), '90 days old → decay = 0.5');

const age180 = now - (180 * 86400);
assert(approxEqual(temporalDecay(age180, 90, now), 0.25), '180 days old → decay = 0.25');

const age45 = now - (45 * 86400);
assert(approxEqual(temporalDecay(age45, 90, now), 0.707, 0.01), '45 days old → decay ≈ 0.707');

const age360 = now - (360 * 86400);
assert(approxEqual(temporalDecay(age360, 90, now), 0.0625), '360 days old → decay = 0.0625');

const age30 = now - (30 * 86400);
assert(approxEqual(temporalDecay(age30, 30, now), 0.5), '30 days with 30-day half-life → 0.5');

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
assert(TYPE_MULTIPLIERS['dispute'] === -1.5, 'dispute = -1.5x');
assert(TYPE_MULTIPLIERS['warning'] === -0.8, 'warning = -0.8x');

// ─── Type Classification ────────────────────────────────────────

console.log('\n📋 Type Classification');

assert(VALID_TYPES.length === 5, '5 valid attestation types');
assert(POSITIVE_TYPES.length === 3, '3 positive types');
assert(NEGATIVE_TYPES.length === 2, '2 negative types');
assert(POSITIVE_TYPES.includes('service-quality'), 'service-quality is positive');
assert(NEGATIVE_TYPES.includes('dispute'), 'dispute is negative');
assert(NEGATIVE_TYPES.includes('warning'), 'warning is negative');
assert(!NEGATIVE_TYPES.includes('general-trust'), 'general-trust is NOT negative');
assert(NEGATIVE_ATTESTATION_TRUST_GATE === 20, 'Trust gate threshold = 20');

// ─── Score Calculation Tests ────────────────────────────────────

console.log('\n📊 Score Calculation — Positive');

function mockAttestation(pubkey, type, createdAt, id, content) {
  return {
    id: id || 'evt_' + Math.random().toString(36).slice(2),
    pubkey,
    created_at: createdAt,
    content: content !== undefined ? content : 'test attestation',
    tags: [
      ['L', 'ai.wot'],
      ['l', type, 'ai.wot'],
      ['p', 'target_pubkey']
    ]
  };
}

(async () => {
  const zapEmpty = new Map();

  // Single fresh positive attestation
  const att1 = [mockAttestation('a'.padEnd(64, '0'), 'service-quality', now)];
  const r1 = await calculateTrustScore(att1, zapEmpty, { now });
  assert(approxEqual(r1.raw, 1.5), 'Single fresh service-quality → raw = 1.5');
  assert(r1.display === Math.min(100, Math.round(1.5 * 10)), 'Display score correct');
  assert(r1.attestationCount === 1, 'Attestation count = 1');
  assert(r1.positiveCount === 1, 'Positive count = 1');
  assert(r1.negativeCount === 0, 'Negative count = 0');

  // Single attestation with decay
  const att2 = [mockAttestation('a'.padEnd(64, '0'), 'service-quality', now - 90 * 86400)];
  const r2 = await calculateTrustScore(att2, zapEmpty, { now });
  assert(approxEqual(r2.raw, 0.75), '90-day-old service-quality → raw = 0.75');

  // Multiple positive attestations
  const att3 = [
    mockAttestation('a'.padEnd(64, '0'), 'service-quality', now, 'evt1'),
    mockAttestation('b'.padEnd(64, '0'), 'general-trust', now, 'evt2'),
    mockAttestation('c'.padEnd(64, '0'), 'identity-continuity', now - 90 * 86400, 'evt3')
  ];
  const r3 = await calculateTrustScore(att3, zapEmpty, { now });
  assert(approxEqual(r3.raw, 2.8), 'Mixed types and ages → raw = 2.8');
  assert(r3.attestationCount === 3, '3 attestations counted');

  // Attestation with zaps
  const att4 = [mockAttestation('a'.padEnd(64, '0'), 'service-quality', now, 'zapped_evt')];
  const zap4 = new Map([['zapped_evt', 1000]]);
  const r4 = await calculateTrustScore(att4, zap4, { now });
  assert(r4.raw > 1.5, 'Zapped attestation > unzapped');

  // Display score cap
  const manyAtt = [];
  for (let i = 0; i < 20; i++) {
    manyAtt.push(mockAttestation(String(i).padStart(64, '0'), 'service-quality', now, `evt_many_${i}`));
  }
  const r5 = await calculateTrustScore(manyAtt, zapEmpty, { now });
  assert(r5.display <= 100, 'Display score capped at 100');
  assert(r5.raw > 10, 'Raw score not capped');

  // ─── Negative Attestation Tests ─────────────────────────────

  console.log('\n⚠️  Negative Attestations');

  // Single dispute — should produce negative contribution
  const dispAtt = [mockAttestation('a'.padEnd(64, '0'), 'dispute', now, 'disp1', 'Scam agent')];
  const rDisp = await calculateTrustScore(dispAtt, zapEmpty, { now, negativeTrustGate: 0 });
  assert(rDisp.raw === 0, 'Single dispute → raw floored at 0');
  assert(rDisp.display === 0, 'Single dispute → display = 0');
  assert(rDisp.negativeCount === 1, 'Negative count = 1');

  // Mixed positive and negative
  const mixedAtt = [
    mockAttestation('a'.padEnd(64, '0'), 'service-quality', now, 'pos1'),  // +1.5
    mockAttestation('b'.padEnd(64, '0'), 'dispute', now, 'neg1', 'Bad actor')  // -1.5
  ];
  const rMixed = await calculateTrustScore(mixedAtt, zapEmpty, { now, negativeTrustGate: 0 });
  assert(approxEqual(rMixed.raw, 0), 'Equal positive and dispute cancel out → raw = 0');
  assert(rMixed.positiveCount === 1, 'Mixed: 1 positive');
  assert(rMixed.negativeCount === 1, 'Mixed: 1 negative');

  // Positive outweighs negative
  const morePositive = [
    mockAttestation('a'.padEnd(64, '0'), 'service-quality', now, 'p1'),   // +1.5
    mockAttestation('b'.padEnd(64, '0'), 'service-quality', now, 'p2'),   // +1.5
    mockAttestation('c'.padEnd(64, '0'), 'warning', now, 'w1', 'Sketchy') // -0.8
  ];
  const rMorePos = await calculateTrustScore(morePositive, zapEmpty, { now, negativeTrustGate: 0 });
  assert(approxEqual(rMorePos.raw, 2.2), '2 service-quality + 1 warning → raw = 2.2');

  // Warning has lighter weight than dispute
  const warnAtt = [mockAttestation('a'.padEnd(64, '0'), 'warning', now, 'w1', 'Unreliable')];
  const rWarn = await calculateTrustScore(warnAtt, zapEmpty, { now, negativeTrustGate: 0 });
  assert(rWarn.raw === 0, 'Warning alone → raw floored at 0');

  // Empty content negative attestation is ignored
  const emptyDispute = [mockAttestation('a'.padEnd(64, '0'), 'dispute', now, 'empty1', '')];
  const rEmpty = await calculateTrustScore(emptyDispute, zapEmpty, { now, negativeTrustGate: 0 });
  assert(rEmpty.gatedCount === 1, 'Empty-content dispute is gated');
  assert(rEmpty.negativeCount === 0, 'Empty-content dispute not counted as negative');

  // Whitespace-only content is also ignored
  const wsDispute = [mockAttestation('a'.padEnd(64, '0'), 'dispute', now, 'ws1', '   ')];
  const rWs = await calculateTrustScore(wsDispute, zapEmpty, { now, negativeTrustGate: 0 });
  assert(rWs.gatedCount === 1, 'Whitespace-only dispute is gated');

  // ─── Trust Gating Tests ─────────────────────────────────────

  console.log('\n🔒 Negative Attestation Trust Gating');

  // Low-trust attester's dispute should be gated (default threshold = 20)
  const gatedDispute = [mockAttestation('a'.padEnd(64, '0'), 'dispute', now, 'gated1', 'Bad agent')];
  const rGated = await calculateTrustScore(gatedDispute, zapEmpty, {
    now,
    negativeTrustGate: 20,
    resolveAttesterScore: async () => ({ raw: 1.0, display: 10 }) // trust 10 < gate 20
  });
  assert(rGated.gatedCount === 1, 'Low-trust dispute is gated');
  assert(rGated.negativeCount === 0, 'Low-trust dispute not counted');

  // High-trust attester's dispute should work
  const ungatedDispute = [mockAttestation('a'.padEnd(64, '0'), 'dispute', now, 'ungated1', 'Scam DVM')];
  const rUngated = await calculateTrustScore(ungatedDispute, zapEmpty, {
    now,
    negativeTrustGate: 20,
    resolveAttesterScore: async () => ({ raw: 5.0, display: 50 }) // trust 50 > gate 20
  });
  assert(rUngated.negativeCount === 1, 'High-trust dispute is not gated');
  assert(rUngated.gatedCount === 0, 'High-trust dispute passes gate');

  // Positive attestation from low-trust attester still works (gating only affects negatives)
  const posFromLow = [mockAttestation('a'.padEnd(64, '0'), 'service-quality', now, 'lowpos1')];
  const rPosLow = await calculateTrustScore(posFromLow, zapEmpty, {
    now,
    negativeTrustGate: 20,
    resolveAttesterScore: async () => ({ raw: 0.5, display: 5 })
  });
  assert(rPosLow.positiveCount === 1, 'Positive attestation from low-trust attester still works');
  assert(rPosLow.gatedCount === 0, 'Positive attestation not gated by trust threshold');

  // ─── Diversity Tests ────────────────────────────────────────

  console.log('\n🌐 Diversity Scoring');

  // Single attester → low diversity
  const singleAttester = [
    { attester: 'a'.padEnd(64, '0'), contribution: 1.5 },
    { attester: 'a'.padEnd(64, '0'), contribution: 0.8 }
  ];
  const d1 = calculateDiversity(singleAttester);
  assert(d1.uniqueAttesters === 1, 'Single attester detected');
  assert(d1.maxAttesterShare === 1.0, 'Single attester = 100% share');
  assert(d1.diversity === 0, 'Single attester → diversity = 0');

  // Two equal attesters → moderate diversity
  const twoEqual = [
    { attester: 'a'.padEnd(64, '0'), contribution: 1.5 },
    { attester: 'b'.padEnd(64, '0'), contribution: 1.5 }
  ];
  const d2 = calculateDiversity(twoEqual);
  assert(d2.uniqueAttesters === 2, 'Two attesters detected');
  assert(d2.maxAttesterShare === 0.5, 'Equal attesters → 50% max share');
  assert(d2.diversity === 0.5, 'Two equal attesters → diversity = 0.5');

  // Many diverse attesters → high diversity
  const manyDiverse = [];
  for (let i = 0; i < 10; i++) {
    manyDiverse.push({ attester: String(i).padStart(64, '0'), contribution: 1.0 });
  }
  const d3 = calculateDiversity(manyDiverse);
  assert(d3.uniqueAttesters === 10, 'Ten attesters detected');
  assert(d3.diversity > 0.8, 'Many equal attesters → high diversity');

  // Dominated by one attester → low diversity
  const dominated = [
    { attester: 'a'.padEnd(64, '0'), contribution: 10.0 },
    { attester: 'b'.padEnd(64, '0'), contribution: 0.5 },
    { attester: 'c'.padEnd(64, '0'), contribution: 0.5 }
  ];
  const d4 = calculateDiversity(dominated);
  assert(d4.maxAttesterShare > 0.8, 'Dominated: top attester has > 80%');
  assert(d4.diversity < 0.3, 'Dominated set → low diversity');

  // Empty breakdown → zero diversity
  const d5 = calculateDiversity([]);
  assert(d5.diversity === 0, 'Empty → diversity = 0');
  assert(d5.uniqueAttesters === 0, 'Empty → 0 attesters');

  // Negative-only contributions → zero diversity (only positives count)
  const negOnly = [
    { attester: 'a'.padEnd(64, '0'), contribution: -1.5 },
    { attester: 'b'.padEnd(64, '0'), contribution: -0.8 }
  ];
  const d6 = calculateDiversity(negOnly);
  assert(d6.diversity === 0, 'Negative-only → diversity = 0');

  // ─── Score includes diversity ───────────────────────────────

  console.log('\n📊 Score includes diversity');

  const diverseAtt = [
    mockAttestation('a'.padEnd(64, '0'), 'service-quality', now, 'div1'),
    mockAttestation('b'.padEnd(64, '0'), 'general-trust', now, 'div2'),
    mockAttestation('c'.padEnd(64, '0'), 'identity-continuity', now, 'div3')
  ];
  const rDiv = await calculateTrustScore(diverseAtt, zapEmpty, { now });
  assert(rDiv.diversity !== undefined, 'Score result includes diversity object');
  assert(rDiv.diversity.uniqueAttesters === 3, 'Diversity in score: 3 unique attesters');
  assert(rDiv.diversity.diversity > 0, 'Diversity score > 0 for diverse attesters');

  // ─── Raw score floor ───────────────────────────────────────

  // ─── Lenient Tag Parsing ─────────────────────────────────────

  console.log('\n🏷️  Lenient Tag Parsing');

  // Malformed attestation: ["l", "service-quality"] and ["l", "ai.wot"] as separate tags
  // instead of ["l", "service-quality", "ai.wot"]
  const malformedAtt = [{
    id: 'malformed_1',
    pubkey: 'a'.padEnd(64, '0'),
    created_at: now,
    content: 'Malformed but valid intent',
    tags: [
      ['L', 'ai.wot'],
      ['l', 'service-quality'],  // missing namespace in third position
      ['l', 'ai.wot'],          // namespace as separate tag
      ['p', 'target_pubkey']
    ]
  }];
  const rMalformed = await calculateTrustScore(malformedAtt, zapEmpty, { now });
  assert(rMalformed.positiveCount === 1, 'Malformed tags → still counted (lenient parsing)');
  assert(rMalformed.raw === 1.5, 'Malformed service-quality → raw = 1.5');

  // Well-formed attestation still works
  const wellFormedAtt = [mockAttestation('b'.padEnd(64, '0'), 'service-quality', now)];
  const rWellFormed = await calculateTrustScore(wellFormedAtt, zapEmpty, { now });
  assert(rWellFormed.positiveCount === 1, 'Well-formed tags → counted normally');
  assert(rWellFormed.raw === rMalformed.raw, 'Both formats produce same score');

  // Completely wrong tags (no namespace at all) should NOT be counted
  const wrongAtt = [{
    id: 'wrong_1',
    pubkey: 'c'.padEnd(64, '0'),
    created_at: now,
    content: 'No namespace at all',
    tags: [
      ['l', 'service-quality'],
      ['p', 'target_pubkey']
    ]
  }];
  const rWrong = await calculateTrustScore(wrongAtt, zapEmpty, { now });
  assert(rWrong.positiveCount === 0, 'No namespace tag at all → not counted');

  console.log('\n📉 Score Floor');

  const allNeg = [
    mockAttestation('a'.padEnd(64, '0'), 'dispute', now, 'neg_only_1', 'Scam'),
    mockAttestation('b'.padEnd(64, '0'), 'warning', now, 'neg_only_2', 'Spam')
  ];
  const rFloor = await calculateTrustScore(allNeg, zapEmpty, { now, negativeTrustGate: 0 });
  assert(rFloor.raw === 0, 'All-negative → raw floored at 0');
  assert(rFloor.display === 0, 'All-negative → display = 0');

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

  // ─── Diversity Badge SVG Tests ────────────────────────────────

  console.log('\n🌐 Diversity Badge SVG');

  const greenDiv = generateDiversityBadgeSvg(0.75);
  assert(greenDiv.includes('#4caf50'), 'Diversity 0.75 → green badge');

  const yellowDiv = generateDiversityBadgeSvg(0.4);
  assert(yellowDiv.includes('#ff9800'), 'Diversity 0.4 → yellow badge');

  const redDiv = generateDiversityBadgeSvg(0.1);
  assert(redDiv.includes('#f44336'), 'Diversity 0.1 → red badge');

  const grayDiv = generateDiversityBadgeSvg(null);
  assert(grayDiv.includes('#9e9e9e'), 'Unknown diversity → gray badge');

  // ─── Summary ──────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(50));
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(50) + '\n');

  process.exit(failed > 0 ? 1 : 0);

})().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
