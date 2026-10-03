import { beforeEach, describe, expect, it, vi } from "vitest";

// 用内存假实现替换 Prisma，专注验证服务层的事务语义。
vi.mock("../src/lib/prisma.js", () => {
  type AnswerRecord = {
    id: string;
    questionId: string;
    userId: string;
    type: "INTERVAL" | "RHYTHM";
    level: number;
    ruleVersion: number;
    response: unknown;
    grade: unknown;
    correct: boolean;
    answeredAt: Date;
  };
  type QuestionRecord = {
    id: string;
    userId: string;
    type: "INTERVAL" | "RHYTHM";
    level: number;
    seed: string;
    ruleVersion: number;
    payload: unknown;
    canonicalAnswer: unknown;
    createdAt: Date;
  };

  const questions = new Map<string, QuestionRecord>();
  const answers = new Map<string, AnswerRecord>();

  return {
    prisma: {
      earTrainingAnswer: {
        findMany: vi.fn(async ({ where }: { where: { userId: string; type?: string } }) =>
          [...answers.values()]
            .filter(
              (answer) =>
                answer.userId === where.userId && (where.type === undefined || answer.type === where.type),
            )
            .map(({ type, level, ruleVersion, correct, answeredAt }) => ({
              type,
              level,
              ruleVersion,
              correct,
              answeredAt,
            })),
        ),
        findUnique: vi.fn(async ({ where }: { where: { questionId: string } }) =>
          [...answers.values()].find((answer) => answer.questionId === where.questionId) ?? null,
        ),
        create: vi.fn(async ({ data }: { data: AnswerRecord }) => {
          const record: AnswerRecord = { id: `ans-${answers.size + 1}`, answeredAt: new Date(), ...data };
          answers.set(record.id, record);
          return record;
        }),
      },
      earTrainingQuestion: {
        create: vi.fn(async ({ data }: { data: Omit<QuestionRecord, "id" | "createdAt"> }) => {
          const record: QuestionRecord = { id: `q-${questions.size + 1}`, createdAt: new Date(), ...data };
          questions.set(record.id, record);
          return record;
        }),
        findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
          const record = questions.get(where.id);
          if (!record || record.userId !== where.userId) return null;
          return { ...record, answer: [...answers.values()].find((answer) => answer.questionId === record.id) ?? null };
        }),
      },
      __reset: () => {
        questions.clear();
        answers.clear();
      },
    },
  };
});

import { AppError } from "../src/lib/errors.js";
import { prisma } from "../src/lib/prisma.js";
import { createQuestion, getQuestion, submitAnswer } from "../src/services/ear-training-service.js";
import type { IntervalQuestionPayload } from "@practice/contracts";

const prismaMock = prisma as unknown as { __reset: () => void };
const USER = "11111111-1111-1111-1111-111111111111";

async function answerInterval(correct: boolean): Promise<{ questionId: string; correct: boolean }> {
  const created = await createQuestion(USER, { type: "INTERVAL" });
  const questionId = created.question.id;
  const detail = await getQuestion(USER, questionId);
  const payload = detail.question.payload as IntervalQuestionPayload;
  const result = await submitAnswer(USER, questionId, {
    answerSemitones: correct ? payload.answerSemitones : ((payload.answerSemitones + 1) % 13),
  });
  return { questionId, correct: result.answer.correct };
}

describe("ear-training service", () => {
  beforeEach(() => prismaMock.__reset());

  it("creates a reproducible question snapshot from a caller-supplied seed", async () => {
    const a = await createQuestion(USER, { type: "INTERVAL", seed: "repro" });
    const b = await createQuestion(USER, { type: "INTERVAL", seed: "repro" });
    expect(a.question.payload).toEqual(b.question.payload);
    expect(a.question.level).toBe(1);
  });

  it("counts a repeated submission only once and returns the first recorded result", async () => {
    const { questionId } = await answerInterval(true);
    await expect(submitAnswer(USER, questionId, { answerSemitones: 0 })).rejects.toMatchObject({
      code: "ALREADY_ANSWERED",
      statusCode: 409,
    });
    const detail = await getQuestion(USER, questionId);
    expect(detail.question.answer?.correct).toBe(true);
  });

  it("promotes the level after three consecutive correct answers", async () => {
    await answerInterval(true);
    await answerInterval(true);
    await answerInterval(true);
    const afterThird = await createQuestion(USER, { type: "INTERVAL" });
    expect(afterThird.question.level).toBe(2);
  });

  it("denies access to another user's question", async () => {
    const created = await createQuestion(USER, { type: "INTERVAL", seed: "owned" });
    await expect(
      getQuestion("22222222-2222-2222-2222-222222222222", created.question.id),
    ).rejects.toBeInstanceOf(AppError);
  });
});
