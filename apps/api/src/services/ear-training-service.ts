import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  EAR_TRAINING_RULE_VERSION,
  clampLevel,
  deriveNextLevel,
  generateEarTrainingQuestion,
  gradeIntervalAnswer,
  gradeRhythmAnswer,
  RHYTHM_TOLERANCE_MS,
  summarizeEarTrainingHistory,
  type EarTrainingHistoryItem,
  type EarTrainingLevel,
  type EarTrainingQuestionPayload,
  type EarTrainingType,
} from "@practice/contracts";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";

export interface CreateQuestionInput {
  type: EarTrainingType;
  seed?: string;
}

export interface SubmitAnswerInput {
  answerSemitones?: number;
  tapTimesMs?: number[];
}

const answerHistorySelect = {
  type: true,
  level: true,
  ruleVersion: true,
  correct: true,
  answeredAt: true,
} satisfies Prisma.EarTrainingAnswerSelect;

async function getHistoryForLevel(userId: string, type: EarTrainingType): Promise<EarTrainingHistoryItem[]> {
  const rows = await prisma.earTrainingAnswer.findMany({
    where: { userId, type },
    orderBy: { answeredAt: "asc" },
    select: answerHistorySelect,
  });
  return rows.map((row) => ({ ...row, level: clampLevel(row.level) }));
}

function asQuestionPayload(value: Prisma.JsonValue): EarTrainingQuestionPayload {
  return value as unknown as EarTrainingQuestionPayload;
}

/**
 * 下一题等级由历史轨迹纯函数推导（无单独可变“等级”字段），
 * 保证升级规则不会篡改任何已记录的题目与作答。
 */
export async function createQuestion(userId: string, input: CreateQuestionInput) {
  const history = await getHistoryForLevel(userId, input.type);
  const level: EarTrainingLevel = deriveNextLevel(input.type, history);
  const seed = input.seed ?? randomUUID();
  const payload = generateEarTrainingQuestion(input.type, level, seed);
  const canonicalAnswer =
    payload.kind === "interval"
      ? { answerSemitones: payload.answerSemitones }
      : { noteOnsetMs: payload.noteOnsetBeats.map((beat) => Math.round(beat * (60_000 / payload.bpm))) };

  const question = await prisma.earTrainingQuestion.create({
    data: {
      userId,
      type: input.type,
      level,
      seed,
      ruleVersion: EAR_TRAINING_RULE_VERSION,
      payload: payload as unknown as Prisma.InputJsonValue,
      canonicalAnswer: canonicalAnswer as unknown as Prisma.InputJsonValue,
    },
  });
  return { question: serializeQuestion(question.id, question.createdAt, question.level, question.seed, payload) };
}

export async function getQuestion(userId: string, id: string) {
  const question = await prisma.earTrainingQuestion.findFirst({
    where: { id, userId },
    include: { answer: true },
  });
  if (!question) throw new AppError(404, "RESOURCE_NOT_FOUND", "题目不存在或无权访问");
  const payload = asQuestionPayload(question.payload);
  return {
    question: {
      ...serializeQuestion(question.id, question.createdAt, question.level, question.seed, payload),
      ruleVersion: question.ruleVersion,
      answer: question.answer
        ? {
            id: question.answer.id,
            correct: question.answer.correct,
            grade: question.answer.grade,
            response: question.answer.response,
            answeredAt: question.answer.answeredAt,
          }
        : null,
    },
  };
}

/**
 * 提交判分。questionId 上的唯一约束保证同一题重复提交只计一次：
 * 已作答时直接 409 返回首次轨迹，不插入、不覆盖任何历史。
 */
export async function submitAnswer(userId: string, questionId: string, input: SubmitAnswerInput) {
  const question = await prisma.earTrainingQuestion.findFirst({ where: { id: questionId, userId } });
  if (!question) throw new AppError(404, "RESOURCE_NOT_FOUND", "题目不存在或无权访问");

  const existing = await prisma.earTrainingAnswer.findUnique({ where: { questionId } });
  if (existing) {
    throw new AppError(409, "ALREADY_ANSWERED", "该题已提交，重复提交只计一次", {
      answerId: existing.id,
      correct: existing.correct,
      answeredAt: existing.answeredAt,
    });
  }

  const payload = asQuestionPayload(question.payload);
  let response: Prisma.InputJsonValue;
  let grade: Prisma.InputJsonValue;
  let correct: boolean;

  if (payload.kind === "interval") {
    if (input.answerSemitones === undefined) {
      throw new AppError(400, "VALIDATION_ERROR", "音程题必须提交 answerSemitones");
    }
    const result = gradeIntervalAnswer(payload, input.answerSemitones);
    response = { answerSemitones: input.answerSemitones };
    grade = result as unknown as Prisma.InputJsonValue;
    correct = result.correct;
  } else {
    if (!input.tapTimesMs) {
      throw new AppError(400, "VALIDATION_ERROR", "节奏题必须提交 tapTimesMs");
    }
    const result = gradeRhythmAnswer(payload, input.tapTimesMs, RHYTHM_TOLERANCE_MS[clampLevel(question.level)]);
    response = { tapTimesMs: result.actualOnsets };
    grade = result as unknown as Prisma.InputJsonValue;
    correct = result.correct;
  }

  const answer = await prisma.earTrainingAnswer.create({
    data: {
      questionId: question.id,
      userId,
      type: question.type,
      level: question.level,
      ruleVersion: question.ruleVersion,
      response,
      grade,
      correct,
    },
  });

  const nextHistory = await getHistoryForLevel(userId, question.type);
  const nextLevel = deriveNextLevel(question.type, nextHistory);
  return {
    answer: {
      id: answer.id,
      correct: answer.correct,
      grade: answer.grade,
      response: answer.response,
      answeredAt: answer.answeredAt,
    },
    nextLevel,
  };
}

export async function listHistory(
  userId: string,
  query: { type?: EarTrainingType; cursor?: string; limit: number },
) {
  const data = await prisma.earTrainingAnswer.findMany({
    where: { userId, ...(query.type ? { type: query.type } : {}) },
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    orderBy: [{ answeredAt: "desc" }, { id: "desc" }],
    include: { question: { select: { id: true, seed: true } } },
  });
  const hasMore = data.length > query.limit;
  const items = (hasMore ? data.slice(0, query.limit) : data).map((answer) => ({
    id: answer.id,
    questionId: answer.questionId,
    type: answer.type,
    level: answer.level,
    ruleVersion: answer.ruleVersion,
    correct: answer.correct,
    response: answer.response,
    grade: answer.grade,
    seed: answer.question.seed,
    answeredAt: answer.answeredAt,
  }));
  return { data: items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
}

export async function getProfile(userId: string) {
  const rows = await prisma.earTrainingAnswer.findMany({
    where: { userId },
    orderBy: { answeredAt: "asc" },
    select: answerHistorySelect,
  });
  const history = rows.map((row) => ({ ...row, level: clampLevel(row.level) }));
  return {
    ruleVersion: EAR_TRAINING_RULE_VERSION,
    types: {
      INTERVAL: summarizeEarTrainingHistory(history, "INTERVAL"),
      RHYTHM: summarizeEarTrainingHistory(history, "RHYTHM"),
    },
    generatedAt: new Date(),
  };
}

function serializeQuestion(
  id: string,
  createdAt: Date,
  level: number,
  seed: string,
  payload: EarTrainingQuestionPayload,
) {
  return {
    id,
    type: payload.kind === "interval" ? ("INTERVAL" as const) : ("RHYTHM" as const),
    level: clampLevel(level),
    seed,
    createdAt,
    payload,
  };
}
