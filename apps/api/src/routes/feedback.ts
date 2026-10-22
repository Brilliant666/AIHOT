import type { FastifyInstance, FastifyRequest } from "fastify";
import { FeedbackRejected, submitFeedback, type FeedbackInput } from "@aihot/backend/operations/feedback";
import { clientIp, sendProblem } from "../http/respond.ts";

type FeedbackBody = Pick<FeedbackInput, "content" | "email" | "pageUrl" | "screenshot">;
// Includes reading/parsing multipart bodies, not just native image decoding. No waiting queue.
const MAX_FEEDBACK_REQUESTS = 2;
const UPLOAD_TIMEOUT_MS = 30_000;
let activeFeedbackRequests = 0;

/** The feedback form as the site posts it: multipart, with at most one screenshot file. */
async function readForm(raw: unknown, contentType: string): Promise<FeedbackBody> {
  let form: FormData;
  try {
    form = await new Response(raw as Buffer<ArrayBuffer>, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new FeedbackRejected(400, "invalid_request", "截图上传格式不正确，请重新提交。");
  }
  const text = (key: string) => {
    const value = form.get(key);
    if (value !== null && typeof value !== "string") throw new FeedbackRejected(400, "invalid_request", "反馈文字格式不正确。");
    return value;
  };
  const file = form.get("screenshot");
  if (file !== null && !(file instanceof File)) throw new FeedbackRejected(400, "invalid_request", "截图上传格式不正确。");
  return {
    content: text("content") ?? "", email: text("email"), pageUrl: text("pageUrl"),
    screenshot: file ? { mime: file.type, data: Buffer.from(await file.arrayBuffer()) } : null,
  };
}

export function registerFeedback(app: FastifyInstance) {
  const admissions = new WeakMap<FastifyRequest, { handling: boolean; timer: ReturnType<typeof setTimeout>; release: () => void }>();
  const release = async (req: FastifyRequest) => admissions.get(req)?.release();
  // Bounded by the same request limit as JSON; native multipart parsing avoids base64 on the wire.
  app.addContentTypeParser("multipart/form-data", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  app.post("/api/site/feedback", {
    bodyLimit: 12 * 1024 * 1024,
    onRequest: async (req, reply) => {
      if (activeFeedbackRequests >= MAX_FEEDBACK_REQUESTS) {
        reply.header("Connection", "close");
        return sendProblem(req, reply, { status: 429, code: "rate_limited", detail: "反馈提交繁忙，请稍后重试，草稿会保留。", retryAfter: 2 });
      }
      activeFeedbackRequests++;
      const state = {
        handling: false,
        timer: setTimeout(() => req.raw.destroy(), UPLOAD_TIMEOUT_MS),
        release() {
          // Disconnecting cannot free a slot while its parsed body is still in use by the handler.
          if (state.handling || !admissions.delete(req)) return;
          clearTimeout(state.timer);
          req.raw.off("aborted", state.release);
          reply.raw.off("close", state.release);
          activeFeedbackRequests--;
        },
      };
      state.timer.unref();
      admissions.set(req, state);
      req.raw.once("aborted", state.release);
      reply.raw.once("close", state.release);
    },
    onError: release,
    onResponse: release,
    onTimeout: release,
    onRequestAbort: release,
  }, async (req, reply) => {
    const state = admissions.get(req);
    if (!state) return reply.code(408).send();
    state.handling = true;
    clearTimeout(state.timer);
    try {
      const body = await readForm(req.body, String(req.headers["content-type"] ?? ""));
      const result = await submitFeedback({ ...body, ip: clientIp(req), userAgent: String(req.headers["user-agent"] ?? "") });
      return reply.header("Cache-Control", "no-store").code(201).send(result);
    } catch (error) {
      if (error instanceof FeedbackRejected) return sendProblem(req, reply, { status: error.status, code: error.code, detail: error.message, retryAfter: error.retryAfter });
      req.log.error({ err: error }, "feedback failed");
      return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "暂时无法提交，请稍后再试。", retryAfter: 30 });
    } finally {
      state.handling = false;
      state.release();
    }
  });
}
