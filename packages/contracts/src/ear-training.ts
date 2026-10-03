import { z } from "zod";

// ---------------------------------------------------------------------------
// 听辨训练：音程与节奏题的纯领域逻辑
// 所有出题、判分、升级规则都是无副作用纯函数，服务端与前端共享同一口径。
// 规则升级时新增 EAR_TRAINING_RULE_VERSION，旧快照永不被重算（升级规则不篡改历史）。
// ---------------------------------------------------------------------------

export const EAR_TRAINING_TYPES = ["INTERVAL", "RHYTHM"] as const;
export type EarTrainingType = (typeof EAR_TRAINING_TYPES)[number];

export const EAR_TRAINING_LEVELS = [1, 2, 3, 4, 5] as const;
export type EarTrainingLevel = (typeof EAR_TRAINING_LEVELS)[number];
export const MIN_LEVEL = 1;
export const MAX_LEVEL = 5;

/**
 * 规则版本会写入每道题快照（question.ruleVersion）与每条答题轨迹。
 * 规则演进时只新增版本号，deriveLevel 只读取与当前版本一致的历史，
 * 旧版本产生的题目/作答保留原样，绝不被新规则回溯改写。
 */
export const EAR_TRAINING_RULE_VERSION = 1;

export function clampLevel(level: number): EarTrainingLevel {
  if (!Number.isFinite(level)) return MIN_LEVEL;
  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.round(level))) as EarTrainingLevel;
}

// --- 可复现随机源：mulberry32，种子相同则题目序列完全一致 ---------------------

export function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** 基于 (种子, 命名空间) 创建确定性随机数生成器。 */
export function createRng(seed: string, namespace: string): () => number {
  let state = hashSeed(`${namespace}:${seed}`) >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

// --- 音程 -------------------------------------------------------------------

/** 半音数 -> 通用音程名称（单声部听辨使用旋律音程，按半音距离判定）。 */
export const INTERVAL_NAMES: Record<number, string> = {
  0: "纯一度",
  1: "小二度",
  2: "大二度",
  3: "小三度",
  4: "大三度",
  5: "纯四度",
  6: "三全音",
  7: "纯五度",
  8: "小六度",
  9: "大六度",
  10: "小七度",
  11: "大七度",

  12: "纯八度",
};

export interface IntervalQuestionPayload {
  kind: "interval";
  /** 根音 MIDI 音高（如 60 = C4）。 */
  rootMidi: number;
  /** 与根音的半音距离（0-12），即标准答案。 */
  answerSemitones: number;
  /** 0 = 和声音程同时发声，1 = 上行旋律，-1 = 下行旋律。 */
  direction: -1 | 0 | 1;
  /** 该级别允许的全部候选答案，前端直接渲染选项（乱序由前端决定）。 */
  options: number[];
}

interface IntervalLevelSpec {
  maxSemitones: number;
  options: readonly number[];
  qualities: readonly IntervalQuality[];
  rootRange: readonly [number, number];
  allowHarmonic: boolean;
}

type IntervalQuality = "perfect" | "major" | "minor" | "tritone" | "unison";

const INTERVAL_LEVEL_SPECS: Record<EarTrainingLevel, IntervalLevelSpec> = {
  1: { maxSemitones: 7, options: [0, 5, 7, 4, 2], qualities: ["unison", "perfect", "major"], rootRange: [55, 67], allowHarmonic: false },
  2: { maxSemitones: 12, options: [0, 3, 4, 5, 7, 9, 12], qualities: ["unison", "perfect", "major", "minor"], rootRange: [53, 69], allowHarmonic: true },
  3: { maxSemitones: 12, options: [2, 3, 4, 5, 7, 8, 9, 12], qualities: ["major", "minor", "perfect"], rootRange: [50, 72], allowHarmonic: true },
  4: { maxSemitones: 12, options: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], qualities: ["major", "minor", "perfect", "tritone"], rootRange: [48, 74], allowHarmonic: true },
  5: { maxSemitones: 12, options: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], qualities: ["major", "minor", "perfect", "tritone", "unison"], rootRange: [46, 76], allowHarmonic: true },
};

const INTERVAL_QUALITY_SEMITONES: Record<IntervalQuality, readonly number[]> = {
  unison: [0],
  perfect: [5, 7, 12],
  major: [2, 4, 9, 11],
  minor: [1, 3, 8, 10],
  tritone: [6],
};

function generateIntervalQuestion(seed: string, level: EarTrainingLevel): IntervalQuestionPayload {
  const spec = INTERVAL_LEVEL_SPECS[level];
  const rng = createRng(seed, "interval");
  const allowed = new Set<number>();
  for (const quality of spec.qualities) {
    for (const semitones of INTERVAL_QUALITY_SEMITONES[quality]) {
      if (semitones <= spec.maxSemitones && spec.options.includes(semitones)) allowed.add(semitones);
    }
  }
  // 选项含一度时必须始终可抽中，避免出现“无此音程”的歧义。
  if (spec.options.includes(0)) allowed.add(0);
  const answerSemitones = pick(rng, [...allowed]);
  const [lowRoot, highRoot] = spec.rootRange;
  const rootMidi = lowRoot + Math.floor(rng() * (highRoot - lowRoot + 1));
  const direction: -1 | 0 | 1 =
    answerSemitones === 0 || !spec.allowHarmonic ? (rng() < 0.5 ? 1 : -1) : pick(rng, [-1, 0, 1] as const);
  return {
    kind: "interval",
    rootMidi,
    answerSemitones,
    direction,
    options: [...spec.options].sort((a, b) => a - b),
  };
}

// --- 节奏 -------------------------------------------------------------------

export interface RhythmEvent {
  /** 事件在小节内的起始拍（以四分音符为 1 拍，可含 0.25）。 */
  startBeat: number;
  /** 时值（拍）。 */
  durationBeats: number;
  isRest: boolean;
}

export interface RhythmQuestionPayload {
  kind: "rhythm";
  /** 每小节拍数（四分音符为一拍）。 */
  beatsPerBar: number;
  /** 每分钟四分音符数。 */
  bpm: number;
  barCount: number;
  /** 允许的音符时值（拍）：1=四分，0.5=八分，0.25=十六分。 */
  allowedDurations: number[];
  /** 是否允许休止符。 */
  allowRests: boolean;
  bars: RhythmEvent[][];
  /** 每个音符相对题面起点的发声时刻（拍），休止符不产生 onset，判分以此为准。 */
  noteOnsetBeats: number[];
}

interface RhythmLevelSpec {
  divisions: number[];
  beatsPerBar: number[];
  bpmRange: readonly [number, number];
  barCount: number;
  allowRests: boolean;
}

const RHYTHM_LEVEL_SPECS: Record<EarTrainingLevel, RhythmLevelSpec> = {
  1: { divisions: [1, 2], beatsPerBar: [4], bpmRange: [70, 88], barCount: 2, allowRests: false },
  2: { divisions: [1, 2], beatsPerBar: [4], bpmRange: [76, 96], barCount: 4, allowRests: true },
  3: { divisions: [1, 2, 4], beatsPerBar: [3, 4], bpmRange: [80, 104], barCount: 4, allowRests: true },
  4: { divisions: [2, 4], beatsPerBar: [3, 4], bpmRange: [88, 112], barCount: 4, allowRests: true },
  5: { divisions: [2, 4], beatsPerBar: [4, 5, 7], bpmRange: [92, 120], barCount: 4, allowRests: true },
};

/** 一拍拆成 4 个最小单位（1 = 十六分音符）。 */
const UNITS_PER_BEAT = 4;

function buildRhythmBar(rng: () => number, spec: RhythmLevelSpec, beatsPerBar: number): RhythmEvent[] {
  const totalUnits = beatsPerBar * UNITS_PER_BEAT;
  // 允许时长（单位）：四分=4，八分=2，十六分=1。
  const allowedUnits = [...new Set(spec.divisions.map((division) => UNITS_PER_BEAT / division))].sort((a, b) => b - a);

  const events: RhythmEvent[] = [];
  let cursor = 0;
  while (cursor < totalUnits) {
    const remaining = totalUnits - cursor;
    const fitting = allowedUnits.filter((units) => units <= remaining);
    // 休止符：不打头、前后不相邻休止，且留出至少一个八分音符收尾，保证可拍击。
    const canRest =
      spec.allowRests &&
      events.length > 0 &&
      !events.at(-1)!.isRest &&
      remaining >= 4;
    const restCandidates = fitting.filter((units) => units <= remaining - 2);
    const isRest = canRest && restCandidates.length > 0 && rng() < 0.22;
    const units = pick(rng, isRest ? restCandidates : fitting);
    events.push({
      startBeat: cursor / UNITS_PER_BEAT,
      durationBeats: units / UNITS_PER_BEAT,
      isRest,
    });
    cursor += units;
  }
  return events;
}

function generateRhythmQuestion(seed: string, level: EarTrainingLevel): RhythmQuestionPayload {
  const spec = RHYTHM_LEVEL_SPECS[level];
  const rng = createRng(seed, "rhythm");
  const beatsPerBar = pick(rng, spec.beatsPerBar);
  const [lowBpm, highBpm] = spec.bpmRange;
  const bpm = lowBpm + Math.floor(rng() * (highBpm - lowBpm + 1));
  const bars = Array.from({ length: spec.barCount }, () => buildRhythmBar(rng, spec, beatsPerBar));
  const noteOnsetBeats: number[] = [];
  bars.forEach((bar, barIndex) => {
    for (const event of bar) {
      if (!event.isRest) noteOnsetBeats.push(barIndex * beatsPerBar + event.startBeat);
    }
  });
  return {
    kind: "rhythm",
    beatsPerBar,
    bpm,
    barCount: spec.barCount,
    allowedDurations: [...new Set(spec.divisions.map((division) => 1 / division))].sort((a, b) => b - a),
    allowRests: spec.allowRests,
    bars,
    noteOnsetBeats,
  };
}

// --- 出题入口 ---------------------------------------------------------------

export type EarTrainingQuestionPayload = IntervalQuestionPayload | RhythmQuestionPayload;

export function generateEarTrainingQuestion(
  type: EarTrainingType,
  level: EarTrainingLevel,
  seed: string,
): EarTrainingQuestionPayload {
  return type === "INTERVAL" ? generateIntervalQuestion(seed, level) : generateRhythmQuestion(seed, level);
}

/** MIDI 音高转等律频率（A4 = 440Hz）。 */
export function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

// --- 判分 -------------------------------------------------------------------

export interface IntervalGrade {
  correct: boolean;
  expectedSemitones: number;
  answeredSemitones: number;
}

export function gradeIntervalAnswer(payload: IntervalQuestionPayload, answeredSemitones: number): IntervalGrade {
  return {
    correct: answeredSemitones === payload.answerSemitones,
    expectedSemitones: payload.answerSemitones,
    answeredSemitones,
  };
}

export interface RhythmGrade {
  correct: boolean;
  expectedOnsets: number[];
  actualOnsets: number[];
  matched: number;
  missing: number;
  extra: number;
  /** 允许偏差（毫秒）。 */
  toleranceMs: number;
}

export const RHYTHM_TOLERANCE_MS: Record<EarTrainingLevel, number> = {
  1: 170,
  2: 160,
  3: 145,
  4: 120,
  5: 105,
};

/**
 * 节奏判分：以题面音符 onset 为期望，用户点击时间为实际。
 * 允许整体平移（按下播放/准备延迟），按最近邻贪心匹配，落在容差窗口内才算命中。
 * 全部期望音符被命中且没有多余点击才算正确。
 */
export function gradeRhythmAnswer(
  payload: RhythmQuestionPayload,
  tapTimesMs: number[],
  toleranceMs: number = RHYTHM_TOLERANCE_MS[1],
): RhythmGrade {
  const beatMs = 60_000 / payload.bpm;
  const expected = payload.noteOnsetBeats.map((beat) => beat * beatMs);
  const actual = tapTimesMs
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.round(value))
    .sort((a, b) => a - b);

  const matchedExpected = new Array(expected.length).fill(false);
  const matchedActual = new Array(actual.length).fill(false);

  // 搜索最优整体偏移后再固定窗口贪心，吸收“开始得早/晚”的固定延迟。
  let bestOffset = 0;
  let bestMatched = 0;
  for (const offset of [-toleranceMs, 0, toleranceMs]) {
    const used = new Array(actual.length).fill(false);
    let count = 0;
    for (const expectedAt of expected) {
      let candidate = -1;
      let bestDistance = toleranceMs + 1;
      for (let i = 0; i < actual.length; i += 1) {
        if (used[i]) continue;
        const distance = Math.abs(actual[i]! - expectedAt - offset);
        if (distance <= toleranceMs && distance < bestDistance) {
          bestDistance = distance;
          candidate = i;
        }
      }
      if (candidate >= 0) {
        used[candidate] = true;
        count += 1;
      }
    }
    if (count > bestMatched) {
      bestMatched = count;
      bestOffset = offset;
    }
  }

  for (let i = 0; i < expected.length; i += 1) {
    let candidate = -1;
    let bestDistance = toleranceMs + 1;
    for (let j = 0; j < actual.length; j += 1) {
      if (matchedActual[j]) continue;
      const distance = Math.abs(actual[j]! - expected[i]! - bestOffset);
      if (distance <= toleranceMs && distance < bestDistance) {
        bestDistance = distance;
        candidate = j;
      }
    }
    if (candidate >= 0) {
      matchedActual[candidate] = true;
      matchedExpected[i] = true;
    }
  }

  const matched = matchedExpected.filter(Boolean).length;
  const missing = expected.length - matched;
  const extra = actual.length - matchedActual.filter(Boolean).length;
  return {
    correct: missing === 0 && extra === 0 && expected.length > 0,
    expectedOnsets: expected.map((value) => Math.round(value)),
    actualOnsets: actual,
    matched,
    missing,
    extra,
    toleranceMs,
  };
}

// --- 升级规则（快照化、不回溯） ---------------------------------------------

export interface EarTrainingHistoryItem {
  type: EarTrainingType;
  level: EarTrainingLevel;
  /** 规则版本；旧版本的作答不参与新版本晋级计算。 */
  ruleVersion: number;
  correct: boolean;
  answeredAt: Date | string;
}

export const PROMOTE_STREAK = 3;
export const DEMOTE_STREAK = 2;

/**
 * 依据当前规则版本下、按时间正序排列的同题型历史，推导“下一题应处等级”。
 * 连续 3 次正确升一级，连续 2 次错误降一级，其余保持。结果始终夹在 1-5。
 * 该函数只读取历史快照、不写任何状态；规则升级通过新版本隔离旧数据。
 */
export function deriveNextLevel(type: EarTrainingType, history: EarTrainingHistoryItem[]): EarTrainingLevel {
  const sequence = history
    .filter((item) => item.type === type && item.ruleVersion === EAR_TRAINING_RULE_VERSION)
    .sort((a, b) => new Date(a.answeredAt).getTime() - new Date(b.answeredAt).getTime());
  if (sequence.length === 0) return MIN_LEVEL;

  let level: EarTrainingLevel = sequence[0]!.level;
  let correctStreak = 0;
  let wrongStreak = 0;
  for (const item of sequence) {
    if (item.correct) {
      correctStreak += 1;
      wrongStreak = 0;
      if (correctStreak >= PROMOTE_STREAK && level < MAX_LEVEL) {
        level = clampLevel(level + 1);
        correctStreak = 0;
      }
    } else {
      wrongStreak += 1;
      correctStreak = 0;
      if (wrongStreak >= DEMOTE_STREAK && level > MIN_LEVEL) {
        level = clampLevel(level - 1);
        wrongStreak = 0;
      }
    }
  }
  return clampLevel(level);
}

export interface EarTrainingTypeStats {
  attempted: number;
  correct: number;
  accuracy: number;
  currentStreak: number;
  bestLevel: EarTrainingLevel;
  nextLevel: EarTrainingLevel;
}

export function summarizeEarTrainingHistory(history: EarTrainingHistoryItem[], type: EarTrainingType): EarTrainingTypeStats {
  const items = history
    .filter((item) => item.type === type)
    .sort((a, b) => new Date(a.answeredAt).getTime() - new Date(b.answeredAt).getTime());
  const attempted = items.length;
  const correct = items.filter((item) => item.correct).length;
  let currentStreak = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (!items[i]!.correct) break;
    currentStreak += 1;
  }
  const bestLevel = items.reduce<EarTrainingLevel>((best, item) => (item.level > best ? item.level : best), MIN_LEVEL);
  return {
    attempted,
    correct,
    accuracy: attempted === 0 ? 0 : Number((correct / attempted).toFixed(4)),
    currentStreak: Math.max(0, currentStreak),
    bestLevel,
    nextLevel: deriveNextLevel(type, history),
  };
}

// --- 请求约束 ---------------------------------------------------------------

export const earTrainingQuerySchema = z.object({
  type: z.enum(EAR_TRAINING_TYPES),
  /** 可选：提供种子可复现题面；不传由服务端生成随机种子。 */
  seed: z.string().trim().min(1, "种子不能为空").max(200, "种子不能超过 200 个字符").optional(),
});

export const intervalAnswerSchema = z.object({
  answerSemitones: z.coerce.number().int().min(0).max(12),
});

export const rhythmAnswerSchema = z.object({
  tapTimesMs: z.array(z.coerce.number().finite().min(0).max(600_000)).min(1, "至少记录一次点击").max(512, "点击次数过多"),
});

export const earTrainingHistoryQuerySchema = z.object({
  type: z.enum(EAR_TRAINING_TYPES).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
