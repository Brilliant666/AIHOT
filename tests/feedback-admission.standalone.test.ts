import "./standalone.ts";
import assert from "node:assert/strict";
import { request, type ClientRequest } from "node:http";
import { test } from "node:test";
import Fastify from "fastify";
import { registerFeedback } from "../apps/api/src/routes/feedback.ts";

const pause = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check()) { assert.ok(Date.now() < end, "request reached its expected lifecycle phase"); await pause(); }
}

async function fixture(connectionTimeout = 0) {
  const app = Fastify({ connectionTimeout });
  let parsing = 0;
  app.addHook("preParsing", async req => { if (req.url === "/api/site/feedback") parsing++; });
  app.get("/unrelated", async (_req, reply) => reply.code(204).send());
  registerFeedback(app);
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
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
    if (body === undefined) client.flushHeaders(); else client.end(body);
    return { client, response };
  }
  return { app, base, upload, parsing: () => parsing, async close() {
    for (const client of clients) client.destroy();
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
