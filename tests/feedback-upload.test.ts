import "./setup.ts";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import sharp from "sharp";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { buildApp } from "../apps/api/src/app.ts";
import { eraseFeedback } from "@aihot/backend/admin/feedback";

process.env.FEISHU_INTERNAL_ENABLED = "false";
config.dataDir = await mkdtemp(path.join(tmpdir(), "aihot-upload-"));
const app = await buildApp();
after(async () => { await app.close(); await closeDb(); await rm(config.dataDir, { recursive: true }); });

/** A real PNG of noise, about `bytes` long (noise does not compress). */
const png = (bytes: number) => {
  const side = Math.ceil(Math.sqrt(bytes / 3));
  const pixels = Buffer.alloc(side * side * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 2654435761) >>> 24;
  return sharp(pixels, { raw: { width: side, height: side, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
};
/** Bytes that start like a PNG and are none. */
const fakePng = (size: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size - 8, 137)]);

async function upload(file: Buffer, ip: string, type = "image/png", userAgent = "Firefox") {
  const form = new FormData();
  form.set("content", "手机截图反馈，文字保持不变");
  form.set("email", "reader@example.com");
  form.set("pageUrl", "/daily");
  form.set("screenshot", new File([new Uint8Array(file)], "screenshot.png", { type }));
  const request = new Request("http://local/api/site/feedback", { method: "POST", body: form });
  const payload = Buffer.from(await request.arrayBuffer());
  return app.inject({ method: "POST", url: "/api/site/feedback", headers: { "content-type": request.headers.get("content-type")!, "x-real-ip": ip, "user-agent": userAgent }, payload });
}

test("a 5 MiB multipart screenshot waits intact for forwarding", async () => {
  const file = await png(5 * 1024 * 1024);
  assert.ok(file.length > 5 * 1024 * 1024);
  const result = await upload(file, "203.0.113.211");
  assert.equal(result.statusCode, 201, result.body);
  assert.equal(result.headers["cache-control"], "no-store");
  const [row] = await sql`SELECT content,email,page_url,screenshot_key,forward_error FROM feedback WHERE id = ${result.json().id}`;
  assert.equal(row!.content, "手机截图反馈，文字保持不变");
  assert.equal(row!.email, "reader@example.com");
  assert.equal(row!.page_url, "/daily");
  assert.equal(row!.forward_error, "pending");
  assert.deepEqual(await readFile(path.join(config.dataDir, "feedback-screenshots", row!.screenshot_key.slice(6))), file);
});

test("malformed multipart and screenshots above the existing backend limit are rejected", async () => {
  const bad = await app.inject({ method: "POST", url: "/api/site/feedback", headers: { "content-type": "multipart/form-data; boundary=missing" }, payload: Buffer.from("bad") });
  assert.equal(bad.statusCode, 400);
  const result = await upload(fakePng(8 * 1024 * 1024 + 1), "203.0.113.212");
  assert.equal(result.statusCode, 400);
  assert.match(result.json().detail, /8MB/);
  // Not a picture, whatever the browser says it is.
  const text = await upload(Buffer.from("not a picture at all"), "203.0.113.214");
  assert.equal(text.statusCode, 400);
  // A PNG signature before noise would be stored and offered to Feishu again and again: the whole
  // picture has to decode.
  const files = async () => (await readdir(path.join(config.dataDir, "feedback-screenshots")).catch(() => [])).length;
  const before = await files();
  const noise = await upload(fakePng(6 * 1024 * 1024), "203.0.113.216");
  assert.equal(noise.statusCode, 400);
  assert.match(noise.json().detail, /无法识别/);
  assert.equal(await files(), before, "nothing is stored");
});

test("a picture sent without a type (some phones do) is taken by its bytes", async () => {
  const file = await png(2048);
  const result = await upload(file, "203.0.113.215", "");
  assert.equal(result.statusCode, 201, result.body);
  const [row] = await sql`SELECT screenshot_key FROM feedback WHERE id = ${result.json().id}`;
  assert.match(row!.screenshot_key, /\.png$/);
});

// Each feedback owns its temporary screenshot: identical uploads must survive another feedback's
// erasure or forwarding cleanup, including when both submissions are waiting to be forwarded.
test("erasing one feedback preserves an identical screenshot on another feedback", async () => {
  const file = await png(4096);
  const first = await upload(file, "203.0.113.217");
  const second = await upload(file, "203.0.113.218");
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 201);
  await eraseFeedback(first.json().id, "reader requested erasure", "test");
  const [row] = await sql`SELECT screenshot_key FROM feedback WHERE id = ${second.json().id}`;
  assert.deepEqual(await readFile(path.join(config.dataDir, "feedback-screenshots", row!.screenshot_key.slice(6))), file);
});

test("multipart retries reuse one screenshot and ID across both Host headers without decoding again", async t => {
  const stats = t.mock.method(sharp.prototype, "stats");
  const file = await png(1024);
  const form = new FormData();
  form.set("content", "漏洞报告：<script>alert(1)</script>");
  form.set("screenshot", new File([new Uint8Array(file)], "report.png", { type: "image/png" }));
  const request = new Request("http://local/api/site/feedback", { method: "POST", body: form });
  const payload = Buffer.from(await request.arrayBuffer());
  const before = (await readdir(path.join(config.dataDir, "feedback-screenshots"))).length;
  const post = (host: string) => app.inject({ method: "POST", url: "/api/site/feedback", headers: {
    host, "content-type": request.headers.get("content-type")!, "x-real-ip": "203.0.113.219", "user-agent": "Firefox",
  }, payload });
  const first = await post("primary.example");
  const retry = await post("compatible.example");
  assert.equal(first.statusCode, 201);
  assert.equal(retry.statusCode, 201);
  assert.equal(first.json().id, retry.json().id);
  assert.equal(stats.mock.callCount(), 1);
  assert.equal((await readdir(path.join(config.dataDir, "feedback-screenshots"))).length, before + 1);
});

test("failed image decoding consumes the persistent attempt allowance", async t => {
  const { feedbackSourceHash } = await import("@aihot/backend/operations/feedback");
  const stats = t.mock.method(sharp.prototype, "stats");
  const ip = "203.0.113.220";
  for (let i = 0; i < 20; i++) assert.equal((await upload(fakePng(32), ip)).statusCode, 400);
  const source = feedbackSourceHash(ip, "Firefox");
  const [state] = await sql<{ attempts: number[] }[]>`SELECT attempts FROM feedback_submission_state WHERE source_hash=${source}`;
  assert.equal(state!.attempts.length, 20, "invalid images are admitted and counted before decoding");
  const limited = await upload(fakePng(32), ip);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers["retry-after"], "3600");
  assert.equal(stats.mock.callCount(), 20, "the refused request never reaches the decoder");
  assert.equal((await sql`SELECT 1 FROM feedback WHERE source_hash=${source}`).length, 0);
});

test("changing user-agent does not reset screenshot decoding allowance, and text remains available", async t => {
  const { submitFeedback } = await import("@aihot/backend/operations/feedback");
  const stats = t.mock.method(sharp.prototype, "stats");
  const ip = "203.0.113.221";
  const families = ["Firefox", "Chrome", "Safari", "Edg", "MicroMessenger"];
  for (let i = 0; i < 20; i++) assert.equal((await upload(fakePng(32), ip, "image/png", families[i % families.length]!)).statusCode, 400);
  const limited = await upload(fakePng(32), ip, "image/png", "Windows");
  assert.equal(limited.statusCode, 429);
  assert.ok(Number(limited.headers["retry-after"]) > 3500);
  assert.equal(stats.mock.callCount(), 20);
  assert.ok((await submitFeedback({ content: "共享网络仍可提交文字反馈", ip, userAgent: "Windows" })).id);
});

test("only one screenshot decodes at a time without holding a database transaction or queueing buffers", { timeout: 10_000 }, async t => {
  const { submitFeedback, feedbackSourceHash } = await import("@aihot/backend/operations/feedback");
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  type Image = ReturnType<typeof sharp>;
  const original = sharp.prototype.stats as (this: Image) => ReturnType<Image["stats"]>;
  const stats = t.mock.method(sharp.prototype, "stats", (async function (this: Image) {
    started.resolve();
    await release.promise;
    return original.call(this);
  }) as typeof sharp.prototype.stats);
  const file = await png(1024);
  const first = upload(file, "203.0.113.222");
  const promptly = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("submission waited for the occupied decoder")), 2000);
      })]);
    } finally { clearTimeout(timer!); }
  };
  try {
    await promptly(started.promise);
    const busy = await promptly(upload(file, "203.0.113.223"));
    assert.equal(busy.statusCode, 429);
    assert.equal(busy.headers["retry-after"], "1");
    assert.equal(stats.mock.callCount(), 1);
    // A report from the same source needs that row lock. It can finish while native decoding waits.
    assert.ok((await promptly(submitFeedback({ content: "截图处理时可先提交文字", ip: "203.0.113.222", userAgent: "Firefox" }))).id);
    const source = feedbackSourceHash("203.0.113.222", "Firefox");
    const [state] = await sql<{ attempts: number[] }[]>`SELECT attempts FROM feedback_submission_state WHERE source_hash=${source}`;
    assert.equal(state!.attempts.length, 2);
  } finally {
    release.resolve();
    await first;
  }
  assert.equal((await first).statusCode, 201);
  const retried = await upload(file, "203.0.113.223");
  assert.equal(retried.statusCode, 201, "the decoder slot is released after completion");
  assert.equal(stats.mock.callCount(), 2);
});
