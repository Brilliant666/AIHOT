import "./standalone.ts";
import assert from "node:assert/strict";
import { createServer, request, type ClientRequest } from "node:http";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { registerFeedback } from "../apps/api/src/routes/feedback.ts";

const pause = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check()) { assert.ok(Date.now() < end, "request reached its expected lifecycle phase"); await pause(); }
}

async function fixture(connectionTimeout = 0, throughProxy = false, setup?: (app: FastifyInstance) => void) {
  const app = Fastify({ connectionTimeout });
  let parsing = 0;
  let aborted = 0;
  app.addHook("preParsing", async req => {
    if (req.url === "/api/site/feedback") {
      parsing++;
      req.raw.once("aborted", () => aborted++);
    }
  });
  app.get("/unrelated", async (_req, reply) => reply.code(204).send());
  registerFeedback(app);
  setup?.(app);
  let base = await app.listen({ host: "127.0.0.1", port: 0 });
  let proxy: ReturnType<typeof createServer> | undefined;
  if (throughProxy) {
    const previous = process.env.API_BASE_URL;
    process.env.API_BASE_URL = base;
    try {
      const { proxyToApi } = await import("../apps/web/app/lib/api-proxy.server.ts");
      proxy = createServer((req, res) => proxyToApi(req, res));
      await new Promise<void>(resolve => proxy!.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${(proxy.address() as import("node:net").AddressInfo).port}`;
    } finally {
      if (previous === undefined) delete process.env.API_BASE_URL;
      else process.env.API_BASE_URL = previous;
    }
  }
  const clients = new Set<ClientRequest>();
  function upload(body?: string, contentType = "multipart/form-data; boundary=gate") {
    let client!: ClientRequest;
    const response = new Promise<{ status: number; retry: string | undefined }>((resolve, reject) => {
      client = request(`${base}/api/site/feedback`, { method: "POST", headers: {
        "content-type": contentType, "content-length": body === undefined ? 1000000 : Buffer.byteLength(body),
      } }, res => {
        res.resume();
        resolve({ status: res.statusCode!, retry: res.headers["retry-after"] });
      });
      client.on("error", reject);
    });
    // Held uploads are deliberately disconnected; avoid unhandled client-side rejections.
    void response.catch(() => {});
    clients.add(client);
    client.once("close", () => clients.delete(client));
    if (body === undefined) {
      // The web proxy starts streaming when the first upload bytes arrive.
      if (throughProxy) client.write("--gate\r\n");
      else client.flushHeaders();
    } else client.end(body);
    return { client, response };
  }
  return { app, base, upload, parsing: () => parsing, aborted: () => aborted, async close() {
    for (const client of clients) client.destroy();
    if (proxy) {
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) => proxy!.close(error => error ? reject(error) : resolve()));
    }
    await app.close();
  } };
}

test("feedback admission refuses before reading a body, recovers from aborts/errors, and leaves other routes available", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const first = f.upload();
    const second = f.upload();
    await until(() => f.parsing() === 2);
    // Send headers only: a rejection that waited for body parsing would never answer.
    assert.deepEqual(await f.upload().response, { status: 429, retry: "2" });
    assert.equal(f.parsing(), 2);
    assert.equal((await fetch(`${f.base}/unrelated`)).status, 204);
    first.client.destroy(); second.client.destroy();
    await pause();
    for (let i = 0; i < 4; i++) assert.equal((await f.upload("{", "application/json").response).status, 400);
    // Normal handler rejection (empty feedback) releases too, without ever touching a database.
    assert.equal((await f.upload("--gate--\r\n").response).status, 400);
    const before = f.parsing();
    f.upload(); f.upload();
    await until(() => f.parsing() === before + 2);
    assert.equal((await f.upload().response).status, 429, "overlapping error/close hooks cannot release a slot twice");
  } finally { await f.close(); }
});

test("the web proxy releases abandoned uploads and handles complete and interrupted responses", { timeout: 10000 }, async t => {
  const streams: { body: PassThrough; closed: boolean }[] = [];
  const f = await fixture(0, true, app => {
    app.get("/stream", async (_req, reply) => {
      const stream = { body: new PassThrough(), closed: false };
      streams.push(stream);
      reply.raw.once("close", () => { stream.closed = true; });
      stream.body.write("first chunk\n");
      return reply.type("text/plain").send(stream.body);
    });
  });
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const original = Response.prototype.formData;
  t.mock.method(Response.prototype, "formData", async function (this: Response) {
    entered.resolve();
    await finish.promise;
    return original.call(this);
  });
  try {
    const first = f.upload();
    const second = f.upload();
    await until(() => f.parsing() === 2);
    assert.equal((await f.upload().response).status, 429);
    first.client.destroy(); second.client.destroy();
    await until(() => f.aborted() === 2);
    // The slots are free immediately, without waiting for the API's 30-second upload timeout.
    const complete = f.upload("--gate--\r\n");
    await entered.promise;
    await pause();
    assert.equal(f.aborted(), 2, "finishing the request body must not cancel the pending response");
    finish.resolve();
    assert.equal((await complete.response).status, 400);
    const unrelated = await fetch(`${f.base}/unrelated`);
    assert.equal(unrelated.status, 204);
    assert.equal(await unrelated.text(), "");
    // MCP and other streamed responses outlive their fully received request body.
    const normal = await fetch(`${f.base}/stream`);
    streams[0]!.body.end("last chunk\n");
    assert.equal(await normal.text(), "first chunk\nlast chunk\n");
    const controller = new AbortController();
    const interrupted = await fetch(`${f.base}/stream`, { signal: controller.signal });
    const reader = interrupted.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "first chunk\n");
    controller.abort();
    await until(() => streams[1]!.closed);
    await reader.cancel().catch(() => {});
    const broken = await fetch(`${f.base}/stream`, { signal: AbortSignal.timeout(2000) });
    const brokenBody = broken.text();
    streams[2]!.body.destroy(new Error("synthetic upstream interruption"));
    await assert.rejects(brokenBody, TypeError, "upstream truncation closes the response before the client timeout");
  } finally {
    finish.resolve();
    for (const stream of streams) stream.body.destroy();
    await f.close();
  }
});

test("timed-out uploads release their slots", { timeout: 10000 }, async () => {
  const f = await fixture(100);
  try {
    const first = f.upload();
    const second = f.upload();
    await until(() => f.parsing() === 2);
    await until(() => first.client.destroyed && second.client.destroyed);
    await pause();
    f.upload(); f.upload();
    await until(() => f.parsing() === 4);
    assert.equal((await f.upload().response).status, 429);
  } finally { await f.close(); }
});

test("disconnecting after parsing does not admit more buffered handlers until their work finishes", { timeout: 10000 }, async t => {
  const f = await fixture();
  let handling = 0;
  const release = Promise.withResolvers<void>();
  t.mock.method(Response.prototype, "formData", async () => {
    handling++;
    await release.promise;
    return new FormData();
  });
  try {
    const first = f.upload("--gate--\r\n");
    const second = f.upload("--gate--\r\n");
    await until(() => handling === 2);
    first.client.destroy(); second.client.destroy();
    await pause();
    assert.equal((await f.upload().response).status, 429);
    release.resolve();
    await pause();
    assert.equal((await f.upload("--gate--\r\n").response).status, 400);
  } finally { release.resolve(); await f.close(); }
});
