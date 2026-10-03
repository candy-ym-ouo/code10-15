import type { FastifyPluginAsync } from "fastify";
import {
  earTrainingHistoryQuerySchema,
  earTrainingQuerySchema,
  intervalAnswerSchema,
  rhythmAnswerSchema,
} from "@practice/contracts";
import { parseOrThrow } from "../lib/validation.js";
import {
  createQuestion,
  getProfile,
  getQuestion,
  listHistory,
  submitAnswer,
} from "../services/ear-training-service.js";

const earTrainingRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  // 当前用户的等级概览（下一题等级、正确率、连胜、历史最高等级）
  app.get("/profile", async (request) => {
    return getProfile(request.authUser!.id);
  });

  // 出题：等级由服务端按历史推导；可传 seed 复现题面
  app.post("/questions", async (request, reply) => {
    const input = parseOrThrow(earTrainingQuerySchema, request.body);
    const result = await createQuestion(request.authUser!.id, input);
    return reply.status(201).send(result);
  });

  app.get("/questions/:id", async (request) => {
    const { id } = request.params as { id: string };
    return getQuestion(request.authUser!.id, id);
  });

  // 提交判分；重复提交返回 409 ALREADY_ANSWERED，不重复计数、不覆盖轨迹
  app.post("/questions/:id/answer", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const input =
      "tapTimesMs" in body
        ? parseOrThrow(rhythmAnswerSchema, body)
        : parseOrThrow(intervalAnswerSchema, body);
    const result = await submitAnswer(request.authUser!.id, id, input);
    return reply.status(201).send(result);
  });

  // 答题轨迹（只追加的历史）
  app.get("/answers", async (request) => {
    const query = parseOrThrow(earTrainingHistoryQuerySchema, request.query);
    return listHistory(request.authUser!.id, query);
  });
};

export default earTrainingRoutes;
