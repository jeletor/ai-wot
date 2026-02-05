#!/usr/bin/env node
// ai-wot — Test Suite v0.8.0
// Tests: temporal decay, type multipliers, zap weights, normalization,
//        negative attestations, trust gating, diversity scoring, revocations, badges,
//        DVM receipts, batch attestations, category scoring, trust path discovery

const {
  temporalDecay, zapWeight, calculateTrustScore, calculateDiversity,
  deduplicateAttestations, filterByCategory, calculateCategoryScore,
  calculateAllCategoryScores,
  TYPE_MULTIPLIERS, DEFAULT_HALF_LIFE_DAYS,
  VALID_TYPES, POSITIVE_TYPES, NEGATIVE_TYPES,
  CATEGORIES, ALL_CATEGORY_NAMES,
  NEGATIVE_ATTESTATION_TRUST_GATE
} = require('./lib/scoring');
const { generateBadgeSvg, generateDiversityBadgeSvg } = require('./lib/server');
const {
  parseDVMResult, parseDVMFeedback, generateReceiptCandidate,
  DVM_KIND_NAMES, DVM_RESULT_KIND_MIN, DVM_RESULT_KIND_MAX, DVM_FEEDBACK_KIND
} = require('./lib/receipts');

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
assert(TYPE_MULTIPLIERS['work-completed'] === 1.2, 'work-completed = 1.2x');
assert(TYPE_MULTIPLIERS['identity-continuity'] === 1.0, 'identity-continuity = 1.0x');
assert(TYPE_MULTIPLIERS['general-trust'] === 0.8, 'general-trust = 0.8x');
assert(TYPE_MULTIPLIERS['dispute'] === -1.5, 'dispute = -1.5x');
assert(TYPE_MULTIPLIERS['warning'] === -0.8, 'warning = -0.8x');

// ─── Type Classification ────────────────────────────────────────

console.log('\n📋 Type Classification');

assert(VALID_TYPES.length === 6, '6 valid attestation types');
assert(POSITIVE_TYPES.length === 4, '4 positive types');
assert(NEGATIVE_TYPES.length === 2, '2 negative types');
assert(POSITIVE_TYPES.includes('service-quality'), 'service-quality is positive');
assert(POSITIVE_TYPES.includes('work-completed'), 'work-completed is positive');
assert(NEGATIVE_TYPES.includes('dispute'), 'dispute is negative');
assert(NEGATIVE_TYPES.includes('warning'), 'warning is negative');
assert(!NEGATIVE_TYPES.includes('general-trust'), 'general-trust is NOT negative');
assert(!NEGATIVE_TYPES.includes('work-completed'), 'work-completed is NOT negative');
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

  // Single fresh positive attestation (novelty bonus 1.3x applied to first edge)
  const att1 = [mockAttestation('a'.padEnd(64, '0'), 'service-quality', now)];
  const r1 = await calculateTrustScore(att1, zapEmpty, { now });
  assert(approxEqual(r1.raw, 1.95), 'Single fresh service-quality → raw = 1.95 (1.5 × 1.3 novelty)');
  assert(r1.display === Math.min(100, Math.round(1.95 * 10)), 'Display score correct');
  assert(r1.attestationCount === 1, 'Attestation count = 1');
  assert(r1.positiveCount === 1, 'Positive count = 1');
  assert(r1.negativeCount === 0, 'Negative count = 0');

  // Single attestation with decay (novelty 1.3x still applies)
  const att2 = [mockAttestation('a'.padEnd(64, '0'), 'service-quality', now - 90 * 86400)];
  const r2 = await calculateTrustScore(att2, zapEmpty, { now });
  assert(approxEqual(r2.raw, 0.98, 0.02), '90-day-old service-quality → raw ≈ 0.98 (0.75 × 1.3)');

  // Multiple positive attestations (all novel edges → 1.3x each)
  const att3 = [
    mockAttestation('a'.padEnd(64, '0'), 'service-quality', now, 'evt1'),
    mockAttestation('b'.padEnd(64, '0'), 'general-trust', now, 'evt2'),
    mockAttestation('c'.padEnd(64, '0'), 'identity-continuity', now - 90 * 86400, 'evt3')
  ];
  const r3 = await calculateTrustScore(att3, zapEmpty, { now });
  assert(approxEqual(r3.raw, 3.64), 'Mixed types and ages → raw = 3.64 (2.8 × 1.3 novelty)');
  assert(r3.attestationCount === 3, '3 attestations counted');

  // Work-completed attestation (novel → 1.3x)
  const attWc = [mockAttestation('a'.padEnd(64, '0'), 'work-completed', now)];
  const rWc = await calculateTrustScore(attWc, zapEmpty, { now });
  assert(approxEqual(rWc.raw, 1.56), 'Single fresh work-completed → raw = 1.56 (1.2 × 1.3)');
  assert(rWc.positiveCount === 1, 'work-completed counts as positive');

  // Work-completed with service-quality (both about same provider, both novel from same attester)
  const attWcSq = [
    mockAttestation('a'.padEnd(64, '0'), 'work-completed', now, 'wc1'),
    mockAttestation('a'.padEnd(64, '0'), 'service-quality', now, 'sq1')
  ];
  const rWcSq = await calculateTrustScore(attWcSq, zapEmpty, { now });
  assert(approxEqual(rWcSq.raw, 3.51), 'work-completed + service-quality → raw = 3.51 ((1.2 + 1.5) × 1.3)');

  // Work-completed with decay (novel → 1.3x)
  const attWcOld = [mockAttestation('a'.padEnd(64, '0'), 'work-completed', now - 90 * 86400)];
  const rWcOld = await calculateTrustScore(attWcOld, zapEmpty, { now });
  assert(approxEqual(rWcOld.raw, 0.78), '90-day-old work-completed → raw = 0.78 (1.2 × 0.5 × 1.3)');

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

  // Positive outweighs negative (all novel → 1.3x each)
  const morePositive = [
    mockAttestation('a'.padEnd(64, '0'), 'service-quality', now, 'p1'),   // +1.5 × 1.3
    mockAttestation('b'.padEnd(64, '0'), 'service-quality', now, 'p2'),   // +1.5 × 1.3
    mockAttestation('c'.padEnd(64, '0'), 'warning', now, 'w1', 'Sketchy') // -0.8 × 1.3
  ];
  const rMorePos = await calculateTrustScore(morePositive, zapEmpty, { now, negativeTrustGate: 0 });
  assert(approxEqual(rMorePos.raw, 2.86), '2 service-quality + 1 warning → raw = 2.86 (2.2 × 1.3)');

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
  assert(approxEqual(rMalformed.raw, 1.95), 'Malformed service-quality → raw = 1.95 (1.5 × 1.3 novelty)');

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

  // ─── DVM Result Parsing Tests ─────────────────────────────────

  console.log('\n🔧 DVM Result Parsing');

  // Valid DVM result (kind 6050 = text generation response)
  const dvmResult1 = parseDVMResult({
    id: 'result_event_1'.padEnd(64, '0'),
    kind: 6050,
    pubkey: 'dvm_pubkey'.padEnd(64, 'a'),
    created_at: now,
    content: 'Here is your translation',
    tags: [
      ['e', 'request_event_1'.padEnd(64, '0')],
      ['p', 'requester_pubkey'.padEnd(64, 'b')],
      ['amount', '21000'] // 21000 millisats = 21 sats
    ]
  });
  assert(dvmResult1 !== null, 'Valid DVM result parsed');
  assert(dvmResult1.resultKind === 6050, 'Result kind = 6050');
  assert(dvmResult1.requestKind === 5050, 'Request kind = 5050');
  assert(dvmResult1.requestKindName === 'text-generation', 'Kind name = text-generation');
  assert(dvmResult1.dvmPubkey === 'dvm_pubkey'.padEnd(64, 'a'), 'DVM pubkey extracted');
  assert(dvmResult1.requestEventId === 'request_event_1'.padEnd(64, '0'), 'Request event ID extracted');
  assert(dvmResult1.requesterPubkey === 'requester_pubkey'.padEnd(64, 'b'), 'Requester pubkey extracted');
  assert(dvmResult1.amountMillisats === 21000, 'Amount millisats = 21000');
  assert(dvmResult1.amountSats === 21, 'Amount sats = 21');
  assert(dvmResult1.content === 'Here is your translation', 'Content preserved');

  // Non-DVM event (kind 1 = regular note)
  const nonDVM = parseDVMResult({
    id: 'note'.padEnd(64, '0'),
    kind: 1,
    pubkey: 'someone'.padEnd(64, '0'),
    created_at: now,
    content: 'Just a note',
    tags: []
  });
  assert(nonDVM === null, 'Non-DVM event → null');

  // Kind at boundary (5999 request → 6999 result — still valid)
  const edgeResult = parseDVMResult({
    id: 'edge'.padEnd(64, '0'),
    kind: 6999,
    pubkey: 'dvm'.padEnd(64, '0'),
    created_at: now,
    content: '',
    tags: []
  });
  assert(edgeResult !== null, 'Kind 6999 (edge case) → valid');
  assert(edgeResult.requestKind === 5999, 'Kind 6999 → request kind 5999');

  // Kind out of range
  assert(parseDVMResult({ id: 'x'.padEnd(64, '0'), kind: 5050, pubkey: 'y'.padEnd(64, '0'), created_at: now, content: '', tags: [] }) === null, 'Kind 5050 (request, not result) → null');
  assert(parseDVMResult({ id: 'x'.padEnd(64, '0'), kind: 7001, pubkey: 'y'.padEnd(64, '0'), created_at: now, content: '', tags: [] }) === null, 'Kind 7001 → null');

  // Null/undefined input
  assert(parseDVMResult(null) === null, 'null → null');
  assert(parseDVMResult(undefined) === null, 'undefined → null');
  assert(parseDVMResult({}) === null, 'empty object → null');

  // No amount tag
  const noAmount = parseDVMResult({
    id: 'na'.padEnd(64, '0'),
    kind: 6050,
    pubkey: 'dvm'.padEnd(64, '0'),
    created_at: now,
    content: 'result',
    tags: [['e', 'req'.padEnd(64, '0')]]
  });
  assert(noAmount !== null, 'No amount tag → still valid');
  assert(noAmount.amountSats === null, 'No amount → amountSats = null');
  assert(noAmount.amountMillisats === null, 'No amount → amountMillisats = null');

  // All known DVM kind names
  assert(DVM_KIND_NAMES[5050] === 'text-generation', 'Kind 5050 name');
  assert(DVM_KIND_NAMES[5100] === 'image-generation', 'Kind 5100 name');
  assert(DVM_KIND_NAMES[5200] === 'text-to-speech', 'Kind 5200 name');
  assert(DVM_KIND_NAMES[5300] === 'content-discovery', 'Kind 5300 name');
  assert(DVM_KIND_NAMES[5500] === 'translation', 'Kind 5500 name');

  // ─── DVM Feedback Parsing Tests ─────────────────────────────

  console.log('\n📡 DVM Feedback Parsing');

  const feedback1 = parseDVMFeedback({
    id: 'fb1'.padEnd(64, '0'),
    kind: 7000,
    pubkey: 'dvm'.padEnd(64, '0'),
    created_at: now,
    content: JSON.stringify({ bolt11: 'lnbc210n1pjtest' }),
    tags: [
      ['e', 'req'.padEnd(64, '0')],
      ['status', 'payment-required'],
      ['amount', '21000']
    ]
  });
  assert(feedback1 !== null, 'Valid feedback parsed');
  assert(feedback1.status === 'payment-required', 'Status = payment-required');
  assert(feedback1.amountSats === 21, 'Feedback amount = 21 sats');
  assert(feedback1.bolt11 === 'lnbc210n1pjtest', 'Bolt11 extracted from JSON content');

  // Feedback with bare bolt11 in content
  const feedback2 = parseDVMFeedback({
    id: 'fb2'.padEnd(64, '0'),
    kind: 7000,
    pubkey: 'dvm'.padEnd(64, '0'),
    created_at: now,
    content: 'lnbc210n1pjbare',
    tags: [
      ['e', 'req'.padEnd(64, '0')],
      ['status', 'payment-required']
    ]
  });
  assert(feedback2.bolt11 === 'lnbc210n1pjbare', 'Bare bolt11 in content detected');

  // Non-feedback event
  assert(parseDVMFeedback({ id: 'x'.padEnd(64, '0'), kind: 6050, pubkey: 'y'.padEnd(64, '0'), created_at: now, content: '', tags: [] }) === null, 'Non-feedback kind → null');
  assert(parseDVMFeedback(null) === null, 'null → null');

  // Processing status feedback
  const feedback3 = parseDVMFeedback({
    id: 'fb3'.padEnd(64, '0'),
    kind: 7000,
    pubkey: 'dvm'.padEnd(64, '0'),
    created_at: now,
    content: 'Working on it...',
    tags: [
      ['e', 'req'.padEnd(64, '0')],
      ['status', 'processing']
    ]
  });
  assert(feedback3.status === 'processing', 'Processing status parsed');
  assert(feedback3.bolt11 === null, 'No bolt11 in processing feedback');

  // ─── DVM Constants Tests ────────────────────────────────────

  console.log('\n📋 DVM Constants');

  assert(DVM_RESULT_KIND_MIN === 6000, 'DVM result kind min = 6000');
  assert(DVM_RESULT_KIND_MAX === 6999, 'DVM result kind max = 6999');
  assert(DVM_FEEDBACK_KIND === 7000, 'DVM feedback kind = 7000');

  // ─── Receipt Content Format Tests ───────────────────────────

  console.log('\n🧾 Receipt Content Format');

  // Verify the structured comment format by simulating what publishReceipt would build
  function buildReceiptComment(result, opts = {}) {
    const parts = ['DVM receipt'];
    parts.push(`kind:${result.requestKind} (${result.requestKindName})`);
    if (opts.amountSats || result.amountSats) parts.push(`${opts.amountSats || result.amountSats} sats`);
    if (opts.rating) parts.push(`rating:${opts.rating}/5`);
    if (opts.comment) parts.push(opts.comment);
    return parts.join(' | ');
  }

  const comment1 = buildReceiptComment(dvmResult1, { amountSats: 21, rating: 5, comment: 'Fast translation' });
  assert(comment1 === 'DVM receipt | kind:5050 (text-generation) | 21 sats | rating:5/5 | Fast translation', 'Full receipt comment format');

  const comment2 = buildReceiptComment(dvmResult1);
  assert(comment2 === 'DVM receipt | kind:5050 (text-generation) | 21 sats', 'Minimal receipt comment (amount from result)');

  const commentNoAmount = buildReceiptComment({ ...dvmResult1, amountSats: null });
  assert(commentNoAmount === 'DVM receipt | kind:5050 (text-generation)', 'Receipt comment without amount');

  // ─── Deduplication Tests (v0.6.0) ──────────────────────────────

  console.log('\n🔄 Deduplication');

  // deduplicateAttestations keeps most recent from same (attester, subject, type)
  const dedupAtts = [
    mockAttestation('a'.padEnd(64, '0'), 'service-quality', now - 100, 'old1'),
    mockAttestation('a'.padEnd(64, '0'), 'service-quality', now - 50, 'mid1'),
    mockAttestation('a'.padEnd(64, '0'), 'service-quality', now, 'new1'),
  ];
  const deduped = deduplicateAttestations(dedupAtts);
  assert(deduped.length === 1, 'Dedup: 3 same-attester attestations → 1');
  assert(deduped[0].id === 'new1', 'Dedup: keeps most recent (new1)');

  // Different attesters are kept
  const dedupDiff = [
    mockAttestation('a'.padEnd(64, '0'), 'service-quality', now, 'da1'),
    mockAttestation('b'.padEnd(64, '0'), 'service-quality', now, 'db1'),
  ];
  const dedupedDiff = deduplicateAttestations(dedupDiff);
  assert(dedupedDiff.length === 2, 'Dedup: different attesters → both kept');

  // Different types from same attester are kept
  const dedupTypes = [
    mockAttestation('a'.padEnd(64, '0'), 'service-quality', now, 'dt1'),
    mockAttestation('a'.padEnd(64, '0'), 'general-trust', now, 'dt2'),
  ];
  const dedupedTypes = deduplicateAttestations(dedupTypes);
  assert(dedupedTypes.length === 2, 'Dedup: different types from same attester → both kept');

  // Empty input
  const dedupEmpty = deduplicateAttestations([]);
  assert(dedupEmpty.length === 0, 'Dedup: empty input → empty output');

  // calculateTrustScore with deduplication keeps most recent
  const dedupScoreAtts = [
    mockAttestation('a'.padEnd(64, '0'), 'service-quality', now - 200, 'ds_old'),  // old, will be deduped
    mockAttestation('a'.padEnd(64, '0'), 'service-quality', now, 'ds_new'),         // most recent, kept
  ];
  const rDedupScore = await calculateTrustScore(dedupScoreAtts, zapEmpty, { now, deduplicate: true });
  // After dedup, only 1 attestation remains. It's "novel" because it IS the earliest (since old one is removed).
  // service-quality × 1.0 decay × 1.3 novelty = 1.5 × 1.3 = 1.95
  assert(rDedupScore.breakdown.length === 1, 'Dedup score: only 1 breakdown entry after dedup');
  assert(rDedupScore.breakdown[0].eventId === 'ds_new', 'Dedup score: most recent kept');

  // With dedup disabled, both are scored
  const rNoDedupScore = await calculateTrustScore(dedupScoreAtts, zapEmpty, { now, deduplicate: false, noveltyMultiplier: 1.0 });
  assert(rNoDedupScore.breakdown.length === 2, 'No dedup: both attestations scored');

  // ─── Novelty Bonus Tests (v0.6.0) ────────────────────────────

  console.log('\n✨ Novelty Bonus');

  // First-time edge gets novelty bonus
  const novelAtt = [mockAttestation('a'.padEnd(64, '0'), 'service-quality', now, 'novel1')];
  const rNovel = await calculateTrustScore(novelAtt, zapEmpty, { now, deduplicate: false });
  // service-quality = 1.5, novelty = 1.3x → 1.95
  assert(approxEqual(rNovel.raw, 1.95), 'Novel edge: service-quality × 1.3 = 1.95');
  assert(rNovel.breakdown[0].noveltyBonus === true, 'Novel edge: noveltyBonus = true');

  // Re-attestation does NOT get novelty bonus (has earlier attestation from same attester to same subject)
  const reattestAtts = [
    mockAttestation('a'.padEnd(64, '0'), 'service-quality', now - 100, 'first1'),
    mockAttestation('a'.padEnd(64, '0'), 'service-quality', now, 'second1'),
  ];
  // With dedup OFF so both are scored; only the first one is novel
  const rReattest = await calculateTrustScore(reattestAtts, zapEmpty, { now, deduplicate: false });
  const firstEntry = rReattest.breakdown.find(b => b.eventId === 'first1');
  const secondEntry = rReattest.breakdown.find(b => b.eventId === 'second1');
  assert(firstEntry.noveltyBonus === true, 'First attestation in pair: noveltyBonus = true');
  assert(secondEntry.noveltyBonus === false, 'Re-attestation: noveltyBonus = false');

  // Verify contribution difference: first has 1.3x, second does not
  // first1: service-quality(1.5) × decay × 1.3 (novel)
  // second1: service-quality(1.5) × 1.0 decay × 1.0 (not novel)
  assert(approxEqual(secondEntry.contribution, 1.5), 'Re-attestation: contribution = 1.5 (no novelty)');
  assert(firstEntry.contribution > secondEntry.contribution * 0.5, 'First attestation has novelty boost (despite decay)');

  // Custom novelty multiplier
  const rCustomNovelty = await calculateTrustScore(novelAtt, zapEmpty, { now, deduplicate: false, noveltyMultiplier: 2.0 });
  assert(approxEqual(rCustomNovelty.raw, 3.0), 'Custom novelty multiplier 2.0: 1.5 × 2.0 = 3.0');

  // Novelty multiplier 1.0 disables bonus
  const rNoNovelty = await calculateTrustScore(novelAtt, zapEmpty, { now, deduplicate: false, noveltyMultiplier: 1.0 });
  assert(approxEqual(rNoNovelty.raw, 1.5), 'Novelty multiplier 1.0: no bonus applied');

  // Different attesters to same subject both get novelty
  const twoNovelAtts = [
    mockAttestation('a'.padEnd(64, '0'), 'service-quality', now, 'tn1'),
    mockAttestation('b'.padEnd(64, '0'), 'service-quality', now, 'tn2'),
  ];
  const rTwoNovel = await calculateTrustScore(twoNovelAtts, zapEmpty, { now, deduplicate: false });
  assert(rTwoNovel.breakdown[0].noveltyBonus === true, 'Two novel attesters: first is novel');
  assert(rTwoNovel.breakdown[1].noveltyBonus === true, 'Two novel attesters: second is novel');

  // ─── Receipt Candidate Tests (v0.6.0) ─────────────────────────

  console.log('\n📋 Receipt Candidate');

  const candidateDvmResult = {
    resultEventId: 'result_candidate'.padEnd(64, '0'),
    resultKind: 6050,
    requestKind: 5050,
    requestKindName: 'text-generation',
    requestEventId: 'request_candidate'.padEnd(64, '0'),
    dvmPubkey: 'dvm_candidate'.padEnd(64, 'a'),
    requesterPubkey: 'requester_candidate'.padEnd(64, 'b'),
    content: 'test result',
    createdAt: now,
    amountMillisats: 42000,
    amountSats: 42
  };

  const candidate = generateReceiptCandidate(candidateDvmResult, { comment: 'Great work', rating: 4 });
  assert(candidate.type === 'service-quality', 'Candidate: default type = service-quality');
  assert(candidate.targetPubkey === 'dvm_candidate'.padEnd(64, 'a'), 'Candidate: targetPubkey correct');
  assert(candidate.eventRef === 'result_candidate'.padEnd(64, '0'), 'Candidate: eventRef correct');
  assert(candidate.amountSats === 42, 'Candidate: amountSats = 42');
  assert(candidate.rating === 4, 'Candidate: rating = 4');
  assert(candidate.comment.includes('DVM receipt'), 'Candidate: comment has DVM receipt prefix');
  assert(candidate.comment.includes('42 sats'), 'Candidate: comment includes sats');
  assert(candidate.comment.includes('rating:4/5'), 'Candidate: comment includes rating');
  assert(candidate.comment.includes('Great work'), 'Candidate: comment includes user comment');
  assert(candidate.comment.includes('text-generation'), 'Candidate: comment includes kind name');
  assert(Array.isArray(candidate.tags), 'Candidate: tags is array');
  assert(candidate.tags.length === 4, 'Candidate: 4 tags (L, l, p, e)');
  assert(candidate.dvmResult.dvmPubkey === candidateDvmResult.dvmPubkey, 'Candidate: dvmResult.dvmPubkey preserved');
  assert(candidate.dvmResult.requestKind === 5050, 'Candidate: dvmResult.requestKind preserved');

  // Candidate without optional fields
  const minCandidate = generateReceiptCandidate(candidateDvmResult);
  assert(minCandidate.rating === null, 'Minimal candidate: rating = null');
  assert(minCandidate.type === 'service-quality', 'Minimal candidate: type = service-quality');
  assert(minCandidate.comment === 'DVM receipt | kind:5050 (text-generation) | 42 sats', 'Minimal candidate: auto-built comment');

  // Candidate with custom type
  const customTypeCandidate = generateReceiptCandidate(candidateDvmResult, { type: 'general-trust' });
  assert(customTypeCandidate.type === 'general-trust', 'Custom type candidate: type = general-trust');

  // Candidate rejects missing dvmPubkey
  let candidateError = false;
  try { generateReceiptCandidate({}); } catch (e) { candidateError = true; }
  assert(candidateError, 'Candidate: throws on missing dvmPubkey');

  // Candidate rejects missing resultEventId
  let candidateError2 = false;
  try { generateReceiptCandidate({ dvmPubkey: 'x'.padEnd(64, '0') }); } catch (e) { candidateError2 = true; }
  assert(candidateError2, 'Candidate: throws on missing resultEventId');

  // ─── CandidateStore Tests (v0.7.0) ─────────────────────────────

  console.log('\n📋 CandidateStore — CRUD');

  const { CandidateStore, filePersistence, generateCandidate, generateL402Candidate } = require('./lib/candidates');

  // Basic add + get
  const store = new CandidateStore();
  const c1 = store.add({
    type: 'service-quality',
    targetPubkey: 'target1'.padEnd(64, '0'),
    comment: 'Great DVM service',
    source: 'dvm',
  });
  assert(c1.id && c1.id.length === 16, 'Add: generates 16-char hex ID');
  assert(c1.status === 'pending', 'Add: status = pending');
  assert(c1.type === 'service-quality', 'Add: type preserved');
  assert(c1.targetPubkey === 'target1'.padEnd(64, '0'), 'Add: targetPubkey preserved');
  assert(c1.comment === 'Great DVM service', 'Add: comment preserved');
  assert(c1.source === 'dvm', 'Add: source preserved');
  assert(c1.createdAt > 0, 'Add: createdAt set');
  assert(c1.publishedEventId === null, 'Add: publishedEventId = null');

  const fetched = store.get(c1.id);
  assert(fetched && fetched.id === c1.id, 'Get: returns correct candidate');
  assert(store.get('nonexistent') === null, 'Get: returns null for unknown ID');

  // List with filters
  const c2 = store.add({
    type: 'work-completed',
    targetPubkey: 'target2'.padEnd(64, '0'),
    comment: 'Work done',
    source: 'l402',
  });

  const allPending = store.list({ status: 'pending' });
  assert(allPending.length === 2, 'List: 2 pending candidates');

  const dvmOnly = store.list({ source: 'dvm' });
  assert(dvmOnly.length === 1 && dvmOnly[0].source === 'dvm', 'List: filter by source');

  const limited = store.list({ limit: 1 });
  assert(limited.length === 1, 'List: limit works');

  // Confirm with edits
  const confirmed = store.confirm(c1.id, { comment: 'Edited comment', type: 'general-trust' });
  assert(confirmed.status === 'confirmed', 'Confirm: status = confirmed');
  assert(confirmed.comment === 'Edited comment', 'Confirm: comment edited');
  assert(confirmed.type === 'general-trust', 'Confirm: type edited');
  assert(confirmed.updatedAt >= confirmed.createdAt, 'Confirm: updatedAt updated');

  // Cannot confirm again
  assert(store.confirm(c1.id) === null, 'Confirm: cannot re-confirm');

  // Reject with reason
  const rejected = store.reject(c2.id, 'Not relevant');
  assert(rejected.status === 'rejected', 'Reject: status = rejected');
  assert(rejected.metadata.rejectReason === 'Not relevant', 'Reject: reason stored');
  assert(store.reject(c2.id) === null, 'Reject: cannot re-reject');

  // Stats
  const stats = store.stats();
  assert(stats.pending === 0, 'Stats: 0 pending');
  assert(stats.confirmed === 1, 'Stats: 1 confirmed');
  assert(stats.rejected === 1, 'Stats: 1 rejected');
  assert(stats.total === 2, 'Stats: total = 2');

  // Mark published
  const pub = store.markPublished(c1.id, 'event123'.padEnd(64, '0'));
  assert(pub.status === 'published', 'MarkPublished: status = published');
  assert(pub.publishedEventId === 'event123'.padEnd(64, '0'), 'MarkPublished: eventId stored');

  console.log('\n📋 CandidateStore — Auto-Expiry');

  const expiryStore = new CandidateStore({ maxAge: 100 }); // 100ms expiry
  const expC = expiryStore.add({
    type: 'service-quality',
    targetPubkey: 'exp'.padEnd(64, '0'),
    comment: 'Will expire',
  });
  // Force the createdAt to be old
  expiryStore._candidates.get(expC.id).createdAt = Date.now() - 200;
  const expList = expiryStore.list({ status: 'pending' });
  assert(expList.length === 0, 'Auto-expiry: old candidate not listed as pending');
  const expStats = expiryStore.stats();
  assert(expStats.expired === 1, 'Auto-expiry: shows as expired in stats');

  console.log('\n📋 CandidateStore — Max Candidates Eviction');

  const smallStore = new CandidateStore({ maxCandidates: 2 });
  smallStore.add({ type: 'service-quality', targetPubkey: 'a'.padEnd(64, '0'), comment: 'first' });
  smallStore.add({ type: 'service-quality', targetPubkey: 'b'.padEnd(64, '0'), comment: 'second' });
  smallStore.add({ type: 'service-quality', targetPubkey: 'c'.padEnd(64, '0'), comment: 'third' });
  assert(smallStore._candidates.size <= 2, 'Eviction: store stays within maxCandidates');

  console.log('\n📋 CandidateStore — File Persistence Round-Trip');

  const tmpFile = '/tmp/ai-wot-test-candidates-' + Date.now() + '.json';
  const persistence1 = filePersistence(tmpFile);
  const storeA = new CandidateStore({ onPersist: (c) => persistence1.save(c) });
  storeA.add({ type: 'service-quality', targetPubkey: 'persist1'.padEnd(64, '0'), comment: 'Persist test' });
  storeA.add({ type: 'work-completed', targetPubkey: 'persist2'.padEnd(64, '0'), comment: 'Persist test 2' });

  // Load into a new store
  const storeB = new CandidateStore();
  storeB.load(persistence1.load());
  const storeB_list = storeB.list({});
  assert(storeB_list.length === 2, 'File persistence: round-trip preserves 2 candidates');
  assert(storeB_list.some(c => c.comment === 'Persist test'), 'File persistence: comment preserved');
  assert(storeB_list.some(c => c.type === 'work-completed'), 'File persistence: type preserved');

  // Clean up
  try { require('fs').unlinkSync(tmpFile); } catch (_) {}

  // Load from non-existent file
  const emptyLoad = filePersistence('/tmp/ai-wot-nonexistent-' + Date.now() + '.json');
  assert(emptyLoad.load().length === 0, 'File persistence: non-existent file returns empty array');

  console.log('\n📋 CandidateStore — Validation');

  let addError = false;
  try { store.add({ type: 'service-quality', targetPubkey: 'x'.padEnd(64, '0') }); } catch (e) { addError = true; }
  assert(addError, 'Add: throws on missing comment');

  let addError2 = false;
  try { store.add({ targetPubkey: 'x'.padEnd(64, '0'), comment: 'test' }); } catch (e) { addError2 = true; }
  assert(addError2, 'Add: throws on missing type');

  console.log('\n📋 CandidateStore — generateCandidate helper');

  const helperStore = new CandidateStore();
  const hc = generateCandidate(helperStore, {
    targetPubkey: 'helper'.padEnd(64, '0'),
    type: 'work-completed',
    comment: 'Helper test',
    source: 'dvm',
    metadata: { task: 'generate' },
  });
  assert(hc.type === 'work-completed', 'generateCandidate: type correct');
  assert(hc.source === 'dvm', 'generateCandidate: source correct');
  assert(hc.metadata.task === 'generate', 'generateCandidate: metadata preserved');

  console.log('\n📋 CandidateStore — generateL402Candidate helper');

  const l402Store = new CandidateStore();
  const l402c = generateL402Candidate(l402Store, {
    providerPubkey: 'l402prov'.padEnd(64, '0'),
    endpoint: '/api/v1/generate',
    amountSats: 42,
    paymentHash: 'hash123',
    description: 'Text generation',
  });
  assert(l402c.type === 'work-completed', 'generateL402Candidate: type = work-completed');
  assert(l402c.source === 'l402', 'generateL402Candidate: source = l402');
  assert(l402c.comment.includes('L402 payment'), 'generateL402Candidate: comment starts with L402');
  assert(l402c.comment.includes('42 sats'), 'generateL402Candidate: comment includes sats');
  assert(l402c.comment.includes('/api/v1/generate'), 'generateL402Candidate: comment includes endpoint');
  assert(l402c.metadata.amountSats === 42, 'generateL402Candidate: metadata.amountSats');

  console.log('\n📋 CandidateStore — onCandidate callback');

  let callbackCalled = false;
  const cbStore = new CandidateStore({
    onCandidate: (c) => { callbackCalled = true; },
  });
  cbStore.add({ type: 'service-quality', targetPubkey: 'cb'.padEnd(64, '0'), comment: 'Callback test' });
  assert(callbackCalled, 'onCandidate callback fires on add');

  // ─── Category Filtering Tests (v0.8.0) ─────────────────────────

  console.log('\n🏷️  Category Definitions');

  assert(ALL_CATEGORY_NAMES.length === 4, '4 named categories');
  assert(ALL_CATEGORY_NAMES.includes('commerce'), 'commerce category exists');
  assert(ALL_CATEGORY_NAMES.includes('identity'), 'identity category exists');
  assert(ALL_CATEGORY_NAMES.includes('code'), 'code category exists');
  assert(ALL_CATEGORY_NAMES.includes('general'), 'general category exists');
  assert(CATEGORIES.commerce.includes('work-completed'), 'commerce includes work-completed');
  assert(CATEGORIES.commerce.includes('service-quality'), 'commerce includes service-quality');
  assert(CATEGORIES.identity.includes('identity-continuity'), 'identity includes identity-continuity');
  assert(CATEGORIES.code.includes('service-quality'), 'code includes service-quality');
  assert(CATEGORIES.general === null, 'general category = null (all types)');

  console.log('\n🔍 filterByCategory');

  const catAtts = [
    mockAttestation('a'.padEnd(64, '0'), 'service-quality', now, 'cat1', 'Great code review'),
    mockAttestation('b'.padEnd(64, '0'), 'work-completed', now, 'cat2', 'Translation delivered'),
    mockAttestation('c'.padEnd(64, '0'), 'identity-continuity', now, 'cat3', 'Still active'),
    mockAttestation('d'.padEnd(64, '0'), 'general-trust', now, 'cat4', 'Good agent'),
    mockAttestation('e'.padEnd(64, '0'), 'service-quality', now, 'cat5', 'Great DVM output'),
    mockAttestation('f'.padEnd(64, '0'), 'dispute', now, 'cat6', 'Scam detected'),
  ];

  // General category → all attestations
  const genFiltered = filterByCategory(catAtts, 'general');
  assert(genFiltered.length === 6, 'general: returns all 6 attestations');

  // Commerce category → work-completed + service-quality
  const comFiltered = filterByCategory(catAtts, 'commerce');
  assert(comFiltered.length === 3, 'commerce: 3 attestations (2 service-quality + 1 work-completed)');
  assert(comFiltered.every(a => {
    const lt = a.tags.find(t => t[0] === 'l' && t[2] === 'ai.wot');
    return lt && (lt[1] === 'service-quality' || lt[1] === 'work-completed');
  }), 'commerce: only commerce types');

  // Identity category → identity-continuity
  const idFiltered = filterByCategory(catAtts, 'identity');
  assert(idFiltered.length === 1, 'identity: 1 attestation');
  assert(idFiltered[0].id === 'cat3', 'identity: correct attestation');

  // Code category → service-quality with "code" in content
  const codeFiltered = filterByCategory(catAtts, 'code');
  assert(codeFiltered.length === 1, 'code: 1 attestation (only one with "code" in content)');
  assert(codeFiltered[0].id === 'cat1', 'code: correct attestation');

  // Direct attestation type as category
  const sqFiltered = filterByCategory(catAtts, 'service-quality');
  assert(sqFiltered.length === 2, 'service-quality type filter: 2 attestations');

  const wcFiltered = filterByCategory(catAtts, 'work-completed');
  assert(wcFiltered.length === 1, 'work-completed type filter: 1 attestation');

  const dispFiltered = filterByCategory(catAtts, 'dispute');
  assert(dispFiltered.length === 1, 'dispute type filter: 1 attestation');

  // Empty input
  const emptyFiltered = filterByCategory([], 'commerce');
  assert(emptyFiltered.length === 0, 'filterByCategory: empty input → empty output');

  // Null category → no filter (same as general)
  const nullFiltered = filterByCategory(catAtts, null);
  assert(nullFiltered.length === 6, 'null category → all attestations');

  // Unknown category → no filter
  const unkFiltered = filterByCategory(catAtts, 'unknown_cat');
  assert(unkFiltered.length === 6, 'unknown category → all attestations (no filter)');

  console.log('\n📊 calculateCategoryScore');

  // Commerce category score
  const comScore = await calculateCategoryScore(catAtts, zapEmpty, 'commerce', { now });
  assert(comScore.category === 'commerce', 'Category score: category field = commerce');
  assert(comScore.attestationCount === 3, 'Commerce: 3 attestations scored');
  assert(comScore.raw > 0, 'Commerce: positive raw score');

  // Identity category score
  const idScore = await calculateCategoryScore(catAtts, zapEmpty, 'identity', { now });
  assert(idScore.category === 'identity', 'Category score: category field = identity');
  assert(idScore.attestationCount === 1, 'Identity: 1 attestation scored');

  // Code category score
  const codeScore = await calculateCategoryScore(catAtts, zapEmpty, 'code', { now });
  assert(codeScore.category === 'code', 'Category score: category field = code');
  assert(codeScore.attestationCount === 1, 'Code: 1 attestation scored');

  // General category = same as calculateTrustScore (minus dispute which has negative contrib)
  const genScore = await calculateCategoryScore(catAtts, zapEmpty, 'general', { now, negativeTrustGate: 0 });
  assert(genScore.category === 'general', 'Category score: category field = general');
  assert(genScore.attestationCount === 6, 'General: all 6 attestations');

  // Empty category for no matching attestations
  const noMatchAtts = [mockAttestation('a'.padEnd(64, '0'), 'dispute', now, 'nm1', 'Bad')];
  const noMatchScore = await calculateCategoryScore(noMatchAtts, zapEmpty, 'identity', { now });
  assert(noMatchScore.attestationCount === 0, 'No matches: 0 attestations');
  assert(noMatchScore.raw === 0, 'No matches: raw = 0');
  assert(noMatchScore.category === 'identity', 'No matches: category preserved');

  console.log('\n📊 calculateAllCategoryScores');

  const allScores = await calculateAllCategoryScores(catAtts, zapEmpty, { now, negativeTrustGate: 0 });
  assert(allScores.commerce !== undefined, 'All scores: commerce present');
  assert(allScores.identity !== undefined, 'All scores: identity present');
  assert(allScores.code !== undefined, 'All scores: code present');
  assert(allScores.general !== undefined, 'All scores: general present');
  assert(allScores.commerce.category === 'commerce', 'All scores: commerce category field');
  assert(allScores.identity.category === 'identity', 'All scores: identity category field');
  assert(allScores.general.attestationCount === 6, 'All scores: general has all attestations');
  assert(allScores.commerce.attestationCount === 3, 'All scores: commerce has 3');
  assert(allScores.identity.attestationCount === 1, 'All scores: identity has 1');
  assert(allScores.code.attestationCount === 1, 'All scores: code has 1');

  // All categories with empty input
  const emptyAllScores = await calculateAllCategoryScores([], zapEmpty, { now });
  assert(emptyAllScores.commerce.raw === 0, 'Empty all scores: commerce = 0');
  assert(emptyAllScores.general.raw === 0, 'Empty all scores: general = 0');
  assert(emptyAllScores.commerce.category === 'commerce', 'Empty all scores: category preserved');

  // ─── Trust Path Discovery Tests (v0.8.0) ──────────────────────

  console.log('\n🔗 findTrustPath (unit — via wot module)');

  const wotModule = require('./lib/wot');
  assert(typeof wotModule.findTrustPath === 'function', 'findTrustPath is exported');
  assert(typeof wotModule.queryOutgoingAttestations === 'function', 'queryOutgoingAttestations is exported');
  assert(typeof wotModule.calculateCategoryScore === 'function', 'calculateCategoryScore is exported from wot');
  assert(typeof wotModule.getAllCategoryScores === 'function', 'getAllCategoryScores is exported from wot');
  assert(typeof wotModule.filterByCategory === 'function', 'filterByCategory is exported from wot');

  // Same pubkey → found immediately
  const selfPath = { found: true, path: [{ pubkey: 'a'.padEnd(64, '0'), type: null, score: null }], hops: 0 };
  // We can't easily call findTrustPath without relays, so test the export and constants
  assert(wotModule.CATEGORIES.commerce.includes('work-completed'), 'CATEGORIES.commerce exported from wot');
  assert(wotModule.ALL_CATEGORY_NAMES.length === 4, 'ALL_CATEGORY_NAMES exported from wot');

  // Verify VERSION updated
  assert(wotModule.VERSION === '0.8.0', 'VERSION = 0.8.0');

  // ─── reaffirmAttestation Structure Tests (v0.6.0) ─────────────

  console.log('\n🔁 reaffirmAttestation Structure');

  // We can't call reaffirmAttestation directly (it publishes to relays),
  // but we can verify the module exports it and test the logic indirectly
  // (wotModule already required above in trust path tests)
  assert(typeof wotModule.reaffirmAttestation === 'function', 'reaffirmAttestation is exported');
  assert(typeof wotModule.queryLatestAttestations === 'function', 'queryLatestAttestations is exported');
  assert(typeof wotModule.generateReceiptCandidate === 'function', 'generateReceiptCandidate is exported from wot');

  // ─── Summary ──────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(50));
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(50) + '\n');

  process.exit(failed > 0 ? 1 : 0);

})().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
