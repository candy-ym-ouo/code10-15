import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import {
  CURRENT_EAR_RULE_VERSION,
  EAR_GENERATOR_VERSION,
  computeEarLevel,
  currentEarRuleSet,
  earAttemptListQuerySchema,
  earDrillGenerateSchema,
  earDrillListQuerySchema,
  earAttemptSubmitSchema,
  generateEarDrillPayload,
  gradeEarAttempt,
  scoreEarAttempt,
  toPublicEarDrillPayload,
  type EarDrillPayload,
} from "@practice/contracts";
import { AppError, notFound } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { parseOrThrow } from "../lib/validation.js";
import { audit } from "../lib/audit.js";

function serializeDrill(
  drill: {
    id: string;
    kind: string;
    seed: string;
    questionIndex: number;
    generatorVersion: number;
    difficulty: number;
    payload: unknown;
    status: string;
    answeredAt: Date | null;
    createdAt: Date;
  },
  reveal: boolean,
) {
  const payload = drill.payload as EarDrillPayload;
  return {
    id: drill.id,
    kind: drill.kind,
    seed: drill.seed,
    questionIndex: drill.questionIndex,
    generatorVersion: drill.generatorVersion,
    difficulty: drill.difficulty,
    status: drill.status,
    answeredAt: drill.answeredAt,
    createdAt: drill.createdAt,
    // 列表接口剔除答案；详情/生成接口下发完整 payload 供客户端合成音频，
    // 已作答的题目在任何接口都附完整答案
    payload: reveal || drill.status === "ANSWERED" ? payload : toPublicEarDrillPayload(payload),
  };
}

const earRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  // 生成一组题目。同（用户, 种子, 题号）唯一，重复请求复用已生成的题目，保证种子可复现。
  app.post("/drills", async (request, reply) => {
    const input = parseOrThrow(earDrillGenerateSchema, request.body);
    const userId = request.authUser!.id;
    const seed = input.seed ?? randomBytes(8).toString("hex");
    const drills = [];
    for (let index = 0; index < input.count; index += 1) {
      const existing = await prisma.earDrill.findUnique({
        where: { userId_seed_questionIndex: { userId, seed, questionIndex: index } },
      });
      if (existing) {
        if (existing.kind !== input.kind || existing.difficulty !== input.difficulty) {
          throw new AppError(409, "SEED_CONFLICT", "该种子已用于其他题型或难度的题目组");
        }
        drills.push(existing);
        continue;
      }
      const payload = generateEarDrillPayload({
        seed,
        questionIndex: index,
        kind: input.kind,
        difficulty: input.difficulty,
      });
      try {
        drills.push(
          await prisma.earDrill.create({
            data: {
              userId,
              kind: input.kind,
              seed,
              questionIndex: index,
              generatorVersion: EAR_GENERATOR_VERSION,
              difficulty: input.difficulty,
              payload: payload as unknown as Prisma.InputJsonValue,
            },
          }),
        );
      } catch (error) {
        // 并发下同种子同题号：复用先写入的题目
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          const raced = await prisma.earDrill.findUniqueOrThrow({
            where: { userId_seed_questionIndex: { userId, seed, questionIndex: index } },
          });
          drills.push(raced);
          continue;
        }
        throw error;
      }
    }
    return reply.status(201).send({ seed, data: drills.map((drill) => serializeDrill(drill, true)) });
  });

  app.get("/drills", async (request) => {
    const query = parseOrThrow(earDrillListQuerySchema, request.query);
    const data = await prisma.earDrill.findMany({
      where: {
        userId: request.authUser!.id,
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    });
    const hasMore = data.length > query.limit;
    const items = hasMore ? data.slice(0, query.limit) : data;
    return { data: items.map((drill) => serializeDrill(drill, false)), nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
  });

  app.get("/drills/:id", async (request) => {
    const { id } = request.params as { id: string };
    const drill = await prisma.earDrill.findFirst({
      where: { id, userId: request.authUser!.id },
      include: { attempts: { orderBy: { createdAt: "asc" } } },
    });
    if (!drill) throw notFound();
    return { drill: serializeDrill(drill, true), attempts: drill.attempts };
  });

  // 提交答案。幂等：同（题目, clientAttemptId）只记一次；每题只有首次提交计分。
  app.post("/drills/:id/attempts", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.authUser!.id;
    const drill = await prisma.earDrill.findFirst({ where: { id, userId } });
    if (!drill) throw notFound();
    const input = parseOrThrow(earAttemptSubmitSchema, request.body);

    const duplicate = await prisma.earAttempt.findUnique({
      where: { drillId_clientAttemptId: { drillId: id, clientAttemptId: input.clientAttemptId } },
    });
    if (duplicate) return { attempt: duplicate, deduplicated: true };

    const rules = currentEarRuleSet();
    const correct = gradeEarAttempt(drill.payload as unknown as EarDrillPayload, input.answer);
    try {
      const attempt = await prisma.$transaction(async (tx) => {
        // CAS：只有首个提交能把题目从 OPEN 翻成 ANSWERED，只有它计入总分
        const flipped = await tx.earDrill.updateMany({
          where: { id, status: "OPEN" },
          data: { status: "ANSWERED", answeredAt: new Date() },
        });
        const counted = flipped.count === 1;
        return tx.earAttempt.create({
          data: {
            userId,
            drillId: id,
            clientAttemptId: input.clientAttemptId,
            answer: input.answer,
            correct,
            counted,
            responseMs: input.responseMs ?? null,
            ruleVersion: rules.version,
            scoreAwarded: counted ? scoreEarAttempt({ correct, counted, responseMs: input.responseMs ?? null }, rules) : 0,
          },
        });
      });
      await audit(request, "EAR_ATTEMPT_SUBMITTED", "EAR_DRILL", id, "SUCCESS", {
        correct,
        counted: attempt.counted,
        ruleVersion: CURRENT_EAR_RULE_VERSION,
      });
      return reply.status(201).send({ attempt, deduplicated: false });
    } catch (error) {
      // 并发重复提交同一 clientAttemptId：返回首个落库的结果，不重复计分
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await prisma.earAttempt.findUnique({
          where: { drillId_clientAttemptId: { drillId: id, clientAttemptId: input.clientAttemptId } },
        });
        if (existing) return { attempt: existing, deduplicated: true };
      }
      throw error;
    }
  });

  // 答题轨迹：append-only，按时间倒序
  app.get("/attempts", async (request) => {
    const query = parseOrThrow(earAttemptListQuerySchema, request.query);
    const data = await prisma.earAttempt.findMany({
      where: {
        userId: request.authUser!.id,
        ...(query.drillId ? { drillId: query.drillId } : {}),
      },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      include: { drill: { select: { id: true, kind: true, seed: true, questionIndex: true, difficulty: true } } },
    });
    const hasMore = data.length > query.limit;
    const items = hasMore ? data.slice(0, query.limit) : data;
    return { data: items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
  });

  // 等级：snapshot 用历史快照分（不可篡改口径），current 用现行规则重放全部轨迹
  app.get("/level", async (request) => {
    const attempts = await prisma.earAttempt.findMany({
      where: { userId: request.authUser!.id },
      select: { correct: true, counted: true, responseMs: true, ruleVersion: true, scoreAwarded: true },
    });
    return {
      snapshot: computeEarLevel(attempts, "snapshot"),
      current: computeEarLevel(attempts, "current"),
      generatorVersion: EAR_GENERATOR_VERSION,
    };
  });
};

export default earRoutes;
