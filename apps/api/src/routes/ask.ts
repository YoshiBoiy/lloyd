import { AskPersistence } from "../../../../packages/ask/src/persistence.js";
import { authorizeCase } from "../../../../packages/ask/src/planner.js";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  DomainError,
  assertSanitizedText,
} from "../../../../packages/contracts/src/index.js";
import {
  AskRequest,
  type Scope,
} from "../../../../packages/ask/src/contracts.js";
import {
  AskService,
  type AskResult,
} from "../../../../packages/ask/src/service.js";
export const AskPolicy = z
  .object({
    tenantId: z.string().min(1),
    userId: z.string().min(1),
    caseIds: z.array(z.string()).min(1),
    precedentAccess: z.boolean(),
    portfolioAccess: z.boolean(),
    retentionDays: z.number().int().min(1).max(90).default(7),
  })
  .strict();
export type AskPolicy = z.infer<typeof AskPolicy>;
interface Session {
  sessionId: string;
  scope: Scope;
  createdAt: string;
  expiresAt: string;
  messages: Array<{
    messageId: string;
    role: "user" | "assistant";
    text: string;
    createdAt: string;
    answerId?: string;
  }>;
  activeAnswerId?: string;
  answerIds: string[];
}
interface Saved {
  sessionId: string;
  scope: Scope;
  expiresAt: string;
  result: AskResult;
}
export function registerAsk(
  app: FastifyInstance,
  service: AskService,
  policy?: AskPolicy,
) {
  const history = new AskPersistence(service.cases);
  const retentionTimer = setInterval(() => {
    void history.maintain().catch(() => {});
  }, 60_000);
  retentionTimer.unref();
  app.addHook("onClose", async () => {
    clearInterval(retentionTimer);
  });
  const requirePolicy = () => {
    if (!policy)
      throw new DomainError(
        "ASK_DISABLED",
        "Ask Lloyd requires a server-side authorization policy",
        403,
      );
    return AskPolicy.parse(policy);
  };
  const scope = (caseId?: string): Scope => ({ ...requirePolicy(), caseId });
  const own = (s: Scope) => {
    const p = requirePolicy();
    if (
      s.userId !== p.userId ||
      s.tenantId !== p.tenantId ||
      (s.precedentAccess && !p.precedentAccess) ||
      (s.portfolioAccess && !p.portfolioAccess) ||
      s.caseIds.some(
        (id) => !p.caseIds.includes("*") && !p.caseIds.includes(id),
      )
    )
      throw new DomainError(
        "FORBIDDEN",
        "Resource outside authorized scope",
        403,
      );
  };
  async function purge(s: Session) {
    for (const id of s.answerIds) {
      const saved = await history.get<Saved>("ask_answers", id);
      if (saved) await history.delete("ask_traces", saved.result.trace.id);
      await history.delete("ask_answers", id);
    }
    await history.delete("ask_sessions", s.sessionId);
  }
  async function session(id: string) {
    const s = await history.get<Session>("ask_sessions", id);
    if (!s) throw new DomainError("NOT_FOUND", "Session not found", 404);
    own(s.scope);
    if (Date.parse(s.expiresAt) <= Date.now()) {
      await purge(s);
      throw new DomainError("NOT_FOUND", "Session expired", 404);
    }
    return s;
  }
  async function saved(id: string) {
    const s = await history.get<Saved>("ask_answers", id);
    if (!s) throw new DomainError("NOT_FOUND", "Answer not found", 404);
    own(s.scope);
    await session(s.sessionId);
    return s;
  }
  app.post("/api/ask/sessions", async (req) => {
    const input = z
      .object({ caseId: z.string().max(200).optional() })
      .strict()
      .parse(req.body ?? {});
    const sc = scope(input.caseId);
    if (input.caseId) {
      authorizeCase(sc, input.caseId);
      try {
        await service.current(sc);
      } catch (error) {
        if (error instanceof DomainError) throw error;
        history.markUnavailable();
      }
    } else if (!sc.portfolioAccess)
      throw new DomainError("FORBIDDEN", "Portfolio access required", 403);
    const now = new Date();
    const s: Session = {
      sessionId: randomUUID(),
      scope: sc,
      createdAt: now.toISOString(),
      expiresAt: new Date(
        +now + requirePolicy().retentionDays * 86400000,
      ).toISOString(),
      messages: [],
      answerIds: [],
    };
    await history.save("ask_sessions", s.sessionId, s);
    return s;
  });
  app.get<{ Params: { sessionId: string } }>(
    "/api/ask/sessions/:sessionId",
    async (req) => session(req.params.sessionId),
  );
  app.delete<{ Params: { sessionId: string } }>(
    "/api/ask/sessions/:sessionId",
    async (req, reply) => {
      if (busy.has(req.params.sessionId))
        throw new DomainError(
          "BUSY",
          "Wait for the active question before deleting the session",
          409,
        );
      await purge(await session(req.params.sessionId));
      return reply.code(204).send();
    },
  );
  const busy = new Set<string>();
  app.post<{ Params: { sessionId: string } }>(
    "/api/ask/sessions/:sessionId/messages",
    async (req, reply) => {
      const s = await session(req.params.sessionId),
        input = AskRequest.parse(req.body);
      assertSanitizedText(input.question);
      if (input.caseId !== undefined && input.caseId !== s.scope.caseId)
        throw new DomainError("FORBIDDEN", "Session scope cannot change", 403);
      if (busy.has(s.sessionId))
        throw new DomainError("BUSY", "A question is already running", 409);
      if (s.messages.length >= 100)
        throw new DomainError("SESSION_LIMIT", "Start a new session", 400);
      busy.add(s.sessionId);
      const stream = req.headers.accept?.includes("text/event-stream");
      if (stream) {
        reply.hijack();
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          "x-accel-buffering": "no",
        });
      }
      const emit = (event: string, data: unknown) => {
        if (stream && !reply.raw.destroyed)
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      try {
        const result = await service.ask(
          { ...input, caseId: s.scope.caseId },
          s.scope,
          emit,
        );
        if (
          result.trace.warnings.some((w) =>
            /GET_CASE_UNAVAILABLE|FIND_PRECEDENTS_UNAVAILABLE|COMPARE_CASES_UNAVAILABLE/.test(
              w,
            ),
          )
        )
          history.markUnavailable();
        if (history.degraded) {
          result.trace.warnings.push(
            "CHAT_HISTORY_TEMPORARY: Atlas unavailable",
          );
          if (result.answer.status === "ANSWERED")
            result.answer.status = "PARTIAL";
        }
        const record: Saved = {
          sessionId: s.sessionId,
          scope: s.scope,
          expiresAt: s.expiresAt,
          result,
        };
        await history.save("ask_answers", result.answer.answerId, record);
        await history.save("ask_traces", result.trace.id, {
          answerId: result.answer.answerId,
          expiresAt: s.expiresAt,
        });
        const now = new Date().toISOString();
        s.messages.push(
          {
            messageId: randomUUID(),
            role: "user",
            text: input.question,
            createdAt: now,
          },
          {
            messageId: randomUUID(),
            role: "assistant",
            text: result.answer.answerMarkdown.slice(0, 1200),
            answerId: result.answer.answerId,
            createdAt: now,
          },
        );
        s.answerIds.push(result.answer.answerId);
        s.activeAnswerId = result.answer.answerId;
        await history.save("ask_sessions", s.sessionId, s);
        const response = {
          ...result.answer,
          graphs: result.graphs,
          trace: result.trace,
          sources: result.packet.evidence,
          precedents: result.packet.precedents.map(({ vector, ...p }) => {
            void vector;
            return p;
          }),
        };
        emit("completed", response);
        if (stream) reply.raw.end();
        else return response;
      } catch (e) {
        if (stream) {
          emit("error", {
            code: "ASK_FAILED",
            message:
              "Question could not be completed. Narrow the question or retry.",
          });
          reply.raw.end();
        } else throw e;
      } finally {
        busy.delete(s.sessionId);
      }
    },
  );
  app.get<{ Params: { answerId: string } }>(
    "/api/ask/answers/:answerId",
    async (req) => {
      const s = await saved(req.params.answerId);
      return { ...s.result.answer, graphs: s.result.graphs };
    },
  );
  app.get<{ Params: { traceId: string } }>(
    "/api/ask/traces/:traceId",
    async (req) => {
      const r = await history.get<{ answerId: string }>(
        "ask_traces",
        req.params.traceId,
      );
      if (!r) throw new DomainError("NOT_FOUND", "Trace not found", 404);
      return (await saved(r.answerId)).result.trace;
    },
  );
  for (const mode of ["evidence", "precedents"] as const) {
    app.post(`/api/explore/${mode}/query`, async (req) => {
      const input = AskRequest.parse(req.body),
        sc = scope(input.caseId);
      if (mode === "precedents" && (!sc.precedentAccess || !sc.caseId))
        throw new DomainError(
          "FORBIDDEN",
          "Select an authorized source case",
          403,
        );
      const result = await service.ask(input, sc);
      return result.graphs[mode];
    });
    app.get<{ Params: { nodeId: string }; Querystring: { answerId?: string } }>(
      `/api/explore/${mode}/nodes/:nodeId`,
      async (req) => {
        const query = z
          .object({ answerId: z.string() })
          .strict()
          .parse(req.query);
        const s = await saved(query.answerId);
        if (mode === "precedents" && !requirePolicy().precedentAccess)
          throw new DomainError(
            "FORBIDDEN",
            "Precedent permission required",
            403,
          );
        const node =
          mode === "evidence"
            ? s.result.documents.find((d) => d.id === req.params.nodeId)
            : s.result.packet.precedents.find(
                (p) => p.caseId === req.params.nodeId,
              );
        if (!node)
          throw new DomainError("NOT_FOUND", "Node not present in answer", 404);
        const { vector, ...detail } = node;
        void vector;
        return detail;
      },
    );
    app.get<{ Params: { version: string }; Querystring: { caseId?: string } }>(
      `/api/explore/${mode}/projections/:version`,
      async (req) => {
        const query = z
          .object({ caseId: z.string().optional() })
          .strict()
          .parse(req.query);
        const sc = scope(query.caseId);
        if (query.caseId) await service.current(sc);
        else if (!sc.portfolioAccess)
          throw new DomainError(
            "FORBIDDEN",
            "Portfolio permission required",
            403,
          );
        if (mode === "precedents" && !sc.precedentAccess)
          throw new DomainError(
            "FORBIDDEN",
            "Precedent permission required",
            403,
          );
        const p = await service.getProjection(sc, mode, req.params.version);
        if (!p) throw new DomainError("NOT_FOUND", "Projection not found", 404);
        return p;
      },
    );
  }
}
