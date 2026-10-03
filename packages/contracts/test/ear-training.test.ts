import { describe, expect, it } from "vitest";
import {
  EAR_TRAINING_RULE_VERSION,
  clampLevel,
  createRng,
  deriveNextLevel,
  generateEarTrainingQuestion,
  gradeIntervalAnswer,
  gradeRhythmAnswer,
  summarizeEarTrainingHistory,
  type EarTrainingHistoryItem,
  type IntervalQuestionPayload,
  type RhythmQuestionPayload,
} from "../src/ear-training.js";

function history(
  type: "INTERVAL" | "RHYTHM",
  results: Array<[number, boolean]>,
  ruleVersion = EAR_TRAINING_RULE_VERSION,
): EarTrainingHistoryItem[] {
  return results.map(([level, correct], index) => ({
    type,
    level: clampLevel(level),
    ruleVersion,
    correct,
    answeredAt: new Date(Date.UTC(2026, 9, 1, 0, index, 0)),
  }));
}

describe("deterministic RNG", () => {
  it("produces the same sequence for the same seed and namespace", () => {
    const a = createRng("seed-42", "interval");
    const b = createRng("seed-42", "interval");
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    expect(createRng("seed-43", "interval")()).not.toBe(seqA[0]);
    expect(createRng("seed-42", "rhythm")()).not.toBe(seqA[0]);
  });
});

describe("interval question generation", () => {
  it("reproduces an identical question from the same seed and level", () => {
    const q1 = generateEarTrainingQuestion("INTERVAL", 3, "abc") as IntervalQuestionPayload;
    const q2 = generateEarTrainingQuestion("INTERVAL", 3, "abc") as IntervalQuestionPayload;
    expect(q1).toEqual(q2);
    expect(q1.kind).toBe("interval");
    expect(q1.options).toContain(q1.answerSemitones);
    expect(q1.answerSemitones).toBeGreaterThanOrEqual(0);
    expect(q1.answerSemitones).toBeLessThanOrEqual(12);
  });

  it("keeps level 1 within the easy option set and never harmonic", () => {
    for (let i = 0; i < 50; i += 1) {
      const q = generateEarTrainingQuestion("INTERVAL", 1, `s${i}`) as IntervalQuestionPayload;
      expect([0, 2, 4, 5, 7]).toContain(q.answerSemitones);
      expect(q.direction).not.toBe(0);
    }
  });
});

describe("rhythm question generation", () => {
  it("fills every bar exactly and only notes contribute onsets", () => {
    const q = generateEarTrainingQuestion("RHYTHM", 3, "beat-9") as RhythmQuestionPayload;
    expect(q.kind).toBe("rhythm");
    for (const bar of q.bars) {
      const total = bar.reduce((sum, event) => sum + event.durationBeats, 0);
      expect(total).toBeCloseTo(q.beatsPerBar, 10);
      expect(bar[0]!.isRest).toBe(false);
      for (let i = 1; i < bar.length; i += 1) expect(bar[i]!.isRest && bar[i - 1]!.isRest).toBe(false);
    }
    const noteCount = q.bars.flat().filter((event) => !event.isRest).length;
    expect(q.noteOnsetBeats).toHaveLength(noteCount);
  });

  it("is seed reproducible", () => {
    const q1 = generateEarTrainingQuestion("RHYTHM", 4, "fixed") as RhythmQuestionPayload;
    const q2 = generateEarTrainingQuestion("RHYTHM", 4, "fixed") as RhythmQuestionPayload;
    expect(q1).toEqual(q2);
  });

  it("grades taps aligned with onsets as correct and rejects extra or missing taps", () => {
    const q = generateEarTrainingQuestion("RHYTHM", 1, "grade") as RhythmQuestionPayload;
    const beatMs = 60_000 / q.bpm;
    const exact = q.noteOnsetBeats.map((beat) => beat * beatMs + 30);
    expect(gradeRhythmAnswer(q, exact).correct).toBe(true);
    expect(gradeRhythmAnswer(q, exact.slice(0, -1)).correct).toBe(false);
    expect(gradeRhythmAnswer(q, [...exact, exact.at(-1)! + 250]).extra).toBe(1);
  });
});

describe("interval grading", () => {
  it("matches on semitone distance", () => {
    const q: IntervalQuestionPayload = {
      kind: "interval",
      rootMidi: 60,
      answerSemitones: 7,
      direction: 1,
      options: [0, 5, 7],
    };
    expect(gradeIntervalAnswer(q, 7).correct).toBe(true);
    expect(gradeIntervalAnswer(q, 5).correct).toBe(false);
  });
});

describe("level progression", () => {
  it("promotes after three consecutive correct answers", () => {
    expect(deriveNextLevel("INTERVAL", history("INTERVAL", [[1, true], [1, true], [1, true]]))).toBe(2);
  });

  it("demotes after two consecutive wrong answers", () => {
    expect(
      deriveNextLevel("INTERVAL", history("INTERVAL", [[1, true], [1, true], [1, true], [2, false], [2, false]])),
    ).toBe(1);
  });

  it("does not change level on a mixed streak and clamps at boundaries", () => {
    expect(deriveNextLevel("INTERVAL", history("INTERVAL", [[1, true], [1, false]]))).toBe(1);
    const fiveCorrect = Array.from({ length: 9 }, () => [5, true] as [number, boolean]);
    expect(deriveNextLevel("INTERVAL", history("INTERVAL", fiveCorrect))).toBe(5);
    expect(deriveNextLevel("RHYTHM", history("RHYTHM", []))).toBe(1);
  });

  it("ignores history produced under an older rule version (rules never rewrite the past)", () => {
    const old = history("INTERVAL", [[3, true], [3, true], [3, true]], EAR_TRAINING_RULE_VERSION - 1);
    expect(deriveNextLevel("INTERVAL", old)).toBe(1);
  });

  it("isolates progression by training type", () => {
    const mixed: EarTrainingHistoryItem[] = [
      ...history("INTERVAL", [[1, true], [1, true], [1, true]]),
      ...history("RHYTHM", [[4, false], [4, false]]),
    ];
    expect(deriveNextLevel("INTERVAL", mixed)).toBe(2);
    expect(deriveNextLevel("RHYTHM", mixed)).toBe(3);
  });
});

describe("history summary", () => {
  it("reports accuracy, current streak and best level from snapshots", () => {
    const stats = summarizeEarTrainingHistory(
      history("INTERVAL", [[1, true], [1, false], [2, true], [2, true]]),
      "INTERVAL",
    );
    expect(stats.attempted).toBe(4);
    expect(stats.accuracy).toBe(0.75);
    expect(stats.currentStreak).toBe(2);
    expect(stats.bestLevel).toBe(2);
    // 连续正确只到 2 次，未达到 3 次晋级阈值，维持当前等级。
    expect(stats.nextLevel).toBe(1);
  });
});
