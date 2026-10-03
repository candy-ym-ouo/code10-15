import { z } from "zod";

/**
 * 听辨训练领域模块。
 *
 * 设计约束：
 * 1. 题目由（生成器版本, 种子, 题号, 题型, 难度）确定性生成，任何一方持相同输入即可复现。
 * 2. 判分规则按版本固化，历史答题轨迹只追加不修改；等级是从轨迹派生的只读视图。
 */

// ---------------------------------------------------------------------------
// 种子化随机数
// ---------------------------------------------------------------------------

/** FNV-1a 32 位哈希，把字符串种子折叠成 uint32。 */
export function hashSeedToUint32(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32：小巧、确定性的 32 位 PRNG，返回 [0, 1) 序列。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickInt(rng: () => number, min: number, maxInclusive: number): number {
  return min + Math.floor(rng() * (maxInclusive - min + 1));
}

function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const temp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = temp;
  }
  return copy;
}

// ---------------------------------------------------------------------------
// 题目生成
// ---------------------------------------------------------------------------

export const EAR_DRILL_KINDS = ["INTERVAL", "RHYTHM"] as const;
export type EarDrillKind = (typeof EAR_DRILL_KINDS)[number];

/** 生成器版本：生成逻辑发生不兼容变化时递增，历史题目凭版本号复现。 */
export const EAR_GENERATOR_VERSION = 1;

export const EAR_DIFFICULTY_MIN = 1;
export const EAR_DIFFICULTY_MAX = 3;

export const INTERVAL_NAMES: Record<number, string> = {
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

export type IntervalDirection = "ASC" | "DESC" | "HARMONIC";

export interface IntervalDrillPayload {
  kind: "INTERVAL";
  /** 根音 MIDI 音高（上行起点 / 下行高点 / 和声音程低音）。 */
  rootMidi: number;
  direction: IntervalDirection;
  /** 答案：音程半音数。 */
  semitones: number;
  /** 选项：半音数数组，升序。 */
  choices: number[];
}

export interface RhythmDrillPayload {
  kind: "RHYTHM";
  bpm: number;
  beatsPerBar: 4;
  /** 每小节十六分音符步数。 */
  steps: 16;
  /** 答案：16 步 0/1 数组，1 表示击奏。 */
  pattern: number[];
  /** 选项：patternToLabel 形式的 16 字符 x/- 串。 */
  choices: string[];
}

export type EarDrillPayload = IntervalDrillPayload | RhythmDrillPayload;

export function patternToLabel(pattern: number[]): string {
  return pattern.map((step) => (step ? "x" : "-")).join("");
}

/** 各难度可用的音程池（半音数）。 */
const INTERVAL_POOLS: Record<number, number[]> = {
  1: [2, 3, 4, 5, 7, 12],
  2: [1, 2, 3, 4, 5, 6, 7, 10, 11, 12],
  3: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
};

function clampDifficulty(difficulty: number): number {
  return Math.min(EAR_DIFFICULTY_MAX, Math.max(EAR_DIFFICULTY_MIN, Math.trunc(difficulty)));
}

function intervalPool(difficulty: number): number[] {
  return INTERVAL_POOLS[difficulty] ?? INTERVAL_POOLS[EAR_DIFFICULTY_MIN]!;
}

function generateIntervalDrill(rng: () => number, difficulty: number): IntervalDrillPayload {
  const pool = intervalPool(difficulty);
  const semitones = pool[pickInt(rng, 0, pool.length - 1)]!;
  const rootMidi = pickInt(rng, 48, 72); // C3–C5
  const directions: IntervalDirection[] =
    difficulty >= 3 ? ["ASC", "DESC", "HARMONIC"] : difficulty === 2 ? ["ASC", "DESC"] : ["ASC"];
  const direction = directions[pickInt(rng, 0, directions.length - 1)]!;
  const distractors = shuffled(
    pool.filter((value) => value !== semitones),
    rng,
  ).slice(0, 3);
  const choices = [...distractors, semitones].sort((a, b) => a - b);
  return { kind: "INTERVAL", rootMidi, direction, semitones, choices };
}

function generateRhythmDrill(rng: () => number, difficulty: number): RhythmDrillPayload {
  const steps = 16;
  const pattern = new Array<number>(steps).fill(0);
  pattern[0] = 1; // 小节第一拍恒定击奏，给考生参照
  const targetOnsets = difficulty === 1 ? 4 : difficulty === 2 ? 6 : 8;
  // 低难度只落在八分位，高难度放开全部十六分位
  const allowedSteps =
    difficulty === 1 ? [0, 2, 4, 6, 8, 10, 12, 14] : Array.from({ length: steps }, (_, i) => i);
  let onsets = 1;
  let guard = 0;
  while (onsets < targetOnsets && guard < 500) {
    guard += 1;
    const index = allowedSteps[pickInt(rng, 0, allowedSteps.length - 1)]!;
    if (!pattern[index]) {
      pattern[index] = 1;
      onsets += 1;
    }
  }
  const bpm = pickInt(rng, 60, 100);
  // 选项 = 正确节奏 + 3 个翻转 1-2 步的扰动版本
  const choiceSet = new Set<string>([patternToLabel(pattern)]);
  guard = 0;
  while (choiceSet.size < 4 && guard < 500) {
    guard += 1;
    const mutated = [...pattern];
    const flips = pickInt(rng, 1, 2);
    for (let i = 0; i < flips; i += 1) {
      const index = pickInt(rng, 0, steps - 1);
      mutated[index] = mutated[index] ? 0 : 1;
    }
    choiceSet.add(patternToLabel(mutated));
  }
  return { kind: "RHYTHM", bpm, beatsPerBar: 4, steps, pattern, choices: shuffled([...choiceSet], rng) };
}

/**
 * 由（生成器版本, 种子, 题号, 题型, 难度）确定性生成题目。
 * 相同输入永远得到相同 payload，这是"题目种子可复现"的唯一事实来源。
 */
export function generateEarDrillPayload(input: {
  seed: string;
  questionIndex: number;
  kind: EarDrillKind;
  difficulty: number;
  generatorVersion?: number;
}): EarDrillPayload {
  const version = input.generatorVersion ?? EAR_GENERATOR_VERSION;
  if (version !== EAR_GENERATOR_VERSION) {
    throw new Error(`Unsupported ear drill generator version: ${version}`);
  }
  const difficulty = clampDifficulty(input.difficulty);
  const rng = mulberry32(
    hashSeedToUint32(`${version}:${input.seed}:${input.questionIndex}:${input.kind}:${difficulty}`),
  );
  return input.kind === "INTERVAL" ? generateIntervalDrill(rng, difficulty) : generateRhythmDrill(rng, difficulty);
}

/** 剔除答案字段，返回给未作答的考生。 */
export function toPublicEarDrillPayload(payload: EarDrillPayload): Omit<EarDrillPayload, "semitones" | "pattern"> {
  if (payload.kind === "INTERVAL") {
    const { semitones: _semitones, ...rest } = payload;
    return rest;
  }
  const { pattern: _pattern, ...rest } = payload;
  return rest;
}

// ---------------------------------------------------------------------------
// 判分
// ---------------------------------------------------------------------------

export interface IntervalAnswer {
  semitones: number;
}
export interface RhythmAnswer {
  pattern: string;
}
export type EarAnswer = IntervalAnswer | RhythmAnswer;

export function gradeEarAttempt(payload: EarDrillPayload, answer: unknown): boolean {
  if (typeof answer !== "object" || answer === null) return false;
  if (payload.kind === "INTERVAL") {
    return (answer as IntervalAnswer).semitones === payload.semitones;
  }
  return (answer as RhythmAnswer).pattern === patternToLabel(payload.pattern);
}

// ---------------------------------------------------------------------------
// 等级规则（版本化，升级不篡改历史）
// ---------------------------------------------------------------------------

export interface EarLevelRuleSet {
  version: number;
  /** 答对一题的基础分。 */
  baseScore: number;
  /** 速度奖励窗口（毫秒）：窗口内答对额外加分。 */
  speedWindowMs: number;
  /** 速度奖励分。 */
  speedBonus: number;
  /** 等级分数线，升序；达到第 i 条线即为 i 级。 */
  levelThresholds: number[];
}

/**
 * 历史规则集全部保留。新规则只能追加新版本，不得修改既有版本，
 * 这样历史 attempt 上快照的 ruleVersion/scoreAwarded 永远可以按当时口径解释。
 */
export const EAR_LEVEL_RULESETS: readonly EarLevelRuleSet[] = [
  { version: 1, baseScore: 10, speedWindowMs: 4000, speedBonus: 2, levelThresholds: [0, 50, 120, 250, 450] },
  { version: 2, baseScore: 10, speedWindowMs: 2500, speedBonus: 5, levelThresholds: [0, 60, 150, 300, 520] },
];

export const CURRENT_EAR_RULE_VERSION = EAR_LEVEL_RULESETS[EAR_LEVEL_RULESETS.length - 1]!.version;

export function getEarRuleSet(version: number): EarLevelRuleSet {
  const rules = EAR_LEVEL_RULESETS.find((item) => item.version === version);
  if (!rules) throw new Error(`Unknown ear level rule version: ${version}`);
  return rules;
}

export function currentEarRuleSet(): EarLevelRuleSet {
  return getEarRuleSet(CURRENT_EAR_RULE_VERSION);
}

export const EAR_LEVEL_LABELS = ["入门", "进阶", "熟练", "精通", "大师"] as const;

/** 按指定规则为单次提交打分；不计分的提交（重复作答）恒为 0。 */
export function scoreEarAttempt(
  input: { correct: boolean; counted: boolean; responseMs: number | null },
  rules: EarLevelRuleSet,
): number {
  if (!input.counted || !input.correct) return 0;
  const bonus = input.responseMs != null && input.responseMs <= rules.speedWindowMs ? rules.speedBonus : 0;
  return rules.baseScore + bonus;
}

export interface EarAttemptScoreInput {
  correct: boolean;
  counted: boolean;
  responseMs: number | null;
  ruleVersion: number;
  scoreAwarded: number;
}

export interface EarLevelResult {
  /** snapshot = 历史快照分求和（不可篡改口径）；current = 用现行规则重放全部轨迹。 */
  mode: "snapshot" | "current";
  ruleVersion: number;
  totalScore: number;
  level: number;
  levelLabel: string;
  nextLevelScore: number | null;
  countedAttempts: number;
  correctAttempts: number;
  accuracy: number;
}

/**
 * 从 append-only 的答题轨迹派生等级。
 * 历史行从不更新：规则升级后 snapshot 口径不变，current 口径提供"按现行规则"的对比视图。
 */
export function computeEarLevel(attempts: EarAttemptScoreInput[], mode: "snapshot" | "current"): EarLevelResult {
  const rules = currentEarRuleSet();
  const counted = attempts.filter((attempt) => attempt.counted);
  const correctCount = counted.filter((attempt) => attempt.correct).length;
  const totalScore = counted.reduce(
    (sum, attempt) => sum + (mode === "snapshot" ? attempt.scoreAwarded : scoreEarAttempt(attempt, rules)),
    0,
  );
  const level = rules.levelThresholds.filter((threshold) => totalScore >= threshold).length;
  return {
    mode,
    ruleVersion: rules.version,
    totalScore,
    level,
    levelLabel: EAR_LEVEL_LABELS[Math.min(Math.max(level, 1), EAR_LEVEL_LABELS.length) - 1] ?? "入门",
    nextLevelScore: rules.levelThresholds[level] ?? null,
    countedAttempts: counted.length,
    correctAttempts: correctCount,
    accuracy: counted.length === 0 ? 0 : Number((correctCount / counted.length).toFixed(4)),
  };
}

// ---------------------------------------------------------------------------
// API 请求约束
// ---------------------------------------------------------------------------

export const earDrillGenerateSchema = z.object({
  kind: z.enum(EAR_DRILL_KINDS),
  count: z.coerce.number().int().min(1).max(20).default(5),
  difficulty: z.coerce.number().int().min(EAR_DIFFICULTY_MIN).max(EAR_DIFFICULTY_MAX).default(1),
  seed: z
    .string()
    .trim()
    .min(4, "种子至少 4 个字符")
    .max(64, "种子不能超过 64 个字符")
    .regex(/^[A-Za-z0-9_-]+$/, "种子只能包含字母、数字、连字符和下划线")
    .optional(),
});

export const earAttemptAnswerSchema = z.union([
  z.object({ semitones: z.coerce.number().int().min(1).max(12) }),
  z.object({ pattern: z.string().regex(/^[x-]{16}$/, "节奏答案必须是 16 位 x/- 串") }),
]);

export const earAttemptSubmitSchema = z.object({
  clientAttemptId: z.string().trim().min(8, "客户端提交标识至少 8 位").max(64),
  answer: earAttemptAnswerSchema,
  responseMs: z.coerce.number().int().nonnegative().max(600_000).optional().nullable(),
});

export const earDrillListQuerySchema = z.object({
  kind: z.enum(EAR_DRILL_KINDS).optional(),
  status: z.enum(["OPEN", "ANSWERED"]).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const earAttemptListQuerySchema = z.object({
  drillId: z.string().uuid().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
