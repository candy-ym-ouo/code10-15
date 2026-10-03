import { describe, expect, it } from "vitest";
import {
  computeEarLevel,
  CURRENT_EAR_RULE_VERSION,
  EAR_GENERATOR_VERSION,
  EAR_LEVEL_RULESETS,
  generateEarDrillPayload,
  getEarRuleSet,
  gradeEarAttempt,
  hashSeedToUint32,
  mulberry32,
  patternToLabel,
  scoreEarAttempt,
  toPublicEarDrillPayload,
  type EarAttemptScoreInput,
  type IntervalDrillPayload,
  type RhythmDrillPayload,
} from "../src/index.js";

describe("seeded generator", () => {
  it("reproduces identical payloads for identical seed and index", () => {
    const a = generateEarDrillPayload({ seed: "recital-2026", questionIndex: 3, kind: "INTERVAL", difficulty: 2 });
    const b = generateEarDrillPayload({ seed: "recital-2026", questionIndex: 3, kind: "INTERVAL", difficulty: 2 });
    expect(a).toEqual(b);
  });

  it("produces different payloads for different seeds or indexes", () => {
    const base = generateEarDrillPayload({ seed: "recital-2026", questionIndex: 0, kind: "RHYTHM", difficulty: 1 });
    const otherSeed = generateEarDrillPayload({ seed: "recital-2027", questionIndex: 0, kind: "RHYTHM", difficulty: 1 });
    const otherIndex = generateEarDrillPayload({ seed: "recital-2026", questionIndex: 1, kind: "RHYTHM", difficulty: 1 });
    expect(base).not.toEqual(otherSeed);
    expect(base).not.toEqual(otherIndex);
  });

  it("rejects unknown generator versions instead of silently changing output", () => {
    expect(() =>
      generateEarDrillPayload({ seed: "s", questionIndex: 0, kind: "INTERVAL", difficulty: 1, generatorVersion: 999 }),
    ).toThrow("Unsupported ear drill generator version");
    expect(EAR_GENERATOR_VERSION).toBe(1);
  });

  it("keeps interval choices unique, sorted and containing the answer", () => {
    for (let index = 0; index < 30; index += 1) {
      const payload = generateEarDrillPayload({ seed: "loop", questionIndex: index, kind: "INTERVAL", difficulty: 3 }) as IntervalDrillPayload;
      expect(payload.choices).toHaveLength(4);
      expect(new Set(payload.choices).size).toBe(4);
      expect(payload.choices).toContain(payload.semitones);
      expect([...payload.choices].sort((a, b) => a - b)).toEqual(payload.choices);
    }
  });

  it("keeps rhythm choices unique and 16 steps long", () => {
    for (let index = 0; index < 30; index += 1) {
      const payload = generateEarDrillPayload({ seed: "loop", questionIndex: index, kind: "RHYTHM", difficulty: 2 }) as RhythmDrillPayload;
      expect(payload.pattern).toHaveLength(16);
      expect(payload.choices).toHaveLength(4);
      expect(new Set(payload.choices).size).toBe(4);
      expect(payload.choices).toContain(patternToLabel(payload.pattern));
    }
  });

  it("strips answers from the public payload", () => {
    const interval = generateEarDrillPayload({ seed: "pub", questionIndex: 0, kind: "INTERVAL", difficulty: 1 });
    const rhythm = generateEarDrillPayload({ seed: "pub", questionIndex: 0, kind: "RHYTHM", difficulty: 1 });
    expect(toPublicEarDrillPayload(interval)).not.toHaveProperty("semitones");
    expect(toPublicEarDrillPayload(rhythm)).not.toHaveProperty("pattern");
  });
});

describe("grading", () => {
  it("grades interval answers by semitone count", () => {
    const payload = generateEarDrillPayload({ seed: "grade", questionIndex: 0, kind: "INTERVAL", difficulty: 1 }) as IntervalDrillPayload;
    expect(gradeEarAttempt(payload, { semitones: payload.semitones })).toBe(true);
    const wrong = payload.choices.find((choice) => choice !== payload.semitones)!;
    expect(gradeEarAttempt(payload, { semitones: wrong })).toBe(false);
  });

  it("grades rhythm answers by the 16-step label", () => {
    const payload = generateEarDrillPayload({ seed: "grade", questionIndex: 1, kind: "RHYTHM", difficulty: 1 }) as RhythmDrillPayload;
    expect(gradeEarAttempt(payload, { pattern: patternToLabel(payload.pattern) })).toBe(true);
    const wrong = payload.choices.find((choice) => choice !== patternToLabel(payload.pattern))!;
    expect(gradeEarAttempt(payload, { pattern: wrong })).toBe(false);
    expect(gradeEarAttempt(payload, null)).toBe(false);
  });
});

describe("level rules", () => {
  const rulesV1 = getEarRuleSet(1);
  const rulesCurrent = getEarRuleSet(CURRENT_EAR_RULE_VERSION);

  it("awards base score plus speed bonus only for counted correct attempts", () => {
    expect(scoreEarAttempt({ correct: true, counted: true, responseMs: 1000 }, rulesV1)).toBe(12);
    expect(scoreEarAttempt({ correct: true, counted: true, responseMs: 9000 }, rulesV1)).toBe(10);
    expect(scoreEarAttempt({ correct: true, counted: true, responseMs: null }, rulesV1)).toBe(10);
    expect(scoreEarAttempt({ correct: false, counted: true, responseMs: 1000 }, rulesV1)).toBe(0);
    expect(scoreEarAttempt({ correct: true, counted: false, responseMs: 1000 }, rulesV1)).toBe(0);
  });

  it("keeps historical snapshots intact when rules are upgraded", () => {
    // 一条按 v1 判分的历史轨迹：窗口内答对得 12 分并快照在 scoreAwarded 上
    const history: EarAttemptScoreInput[] = [
      { correct: true, counted: true, responseMs: 3000, ruleVersion: 1, scoreAwarded: 12 },
    ];
    const snapshot = computeEarLevel(history, "snapshot");
    const current = computeEarLevel(history, "current");
    // snapshot 口径永远等于当时快照的 12 分，不受规则升级影响
    expect(snapshot.totalScore).toBe(12);
    // current 口径用现行规则重放：v2 窗口 2500ms，3000ms 不再拿速度奖励
    expect(current.totalScore).toBe(rulesCurrent.baseScore);
    expect(current.ruleVersion).toBe(CURRENT_EAR_RULE_VERSION);
  });

  it("derives levels from thresholds and reports accuracy over counted attempts only", () => {
    const attempts: EarAttemptScoreInput[] = Array.from({ length: 6 }, () => ({
      correct: true,
      counted: true,
      responseMs: null,
      ruleVersion: CURRENT_EAR_RULE_VERSION,
      scoreAwarded: 10,
    }));
    attempts.push({ correct: true, counted: false, responseMs: 100, ruleVersion: CURRENT_EAR_RULE_VERSION, scoreAwarded: 0 });
    const result = computeEarLevel(attempts, "snapshot");
    expect(result.totalScore).toBe(60);
    expect(result.level).toBe(2);
    expect(result.countedAttempts).toBe(6);
    expect(result.accuracy).toBe(1);
    expect(result.nextLevelScore).toBe(150);
  });

  it("never mutates rule sets in place", () => {
    expect(Object.isFrozen(EAR_LEVEL_RULESETS)).toBe(false); // 数组可追加新版本
    const before = structuredClone(EAR_LEVEL_RULESETS);
    computeEarLevel([], "current");
    expect(EAR_LEVEL_RULESETS).toEqual(before);
  });
});

describe("prng primitives", () => {
  it("hashes seeds deterministically and stays in uint32 range", () => {
    expect(hashSeedToUint32("abc")).toBe(hashSeedToUint32("abc"));
    expect(hashSeedToUint32("abc")).not.toBe(hashSeedToUint32("abd"));
    expect(hashSeedToUint32("abc")).toBeGreaterThanOrEqual(0);
    expect(hashSeedToUint32("abc")).toBeLessThanOrEqual(0xffffffff);
  });

  it("mulberry32 produces a deterministic [0,1) sequence", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 10; i += 1) {
      const value = a();
      expect(value).toBe(b());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
