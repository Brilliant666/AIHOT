import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPublicDeployment } from "../scripts/check-public-deployment.ts";

const valid = {
  SITE_URL: "https://news.operator.org", SITE_DOMAIN: "news.operator.org", PORT: "127.0.0.1:3000", TRUST_PROXY: "true",
  ADMIN_PASSWORD: "fixture-password-123", SESSION_SECRET: "s".repeat(64), IMG_PROXY_SIGN_SECRET: "i".repeat(64), POSTGRES_PASSWORD: "p".repeat(36),
  COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false", IMGPROXY_UPSTREAM_MB_PER_MINUTE: "30", IMGPROXY_UPSTREAM_GB_PER_DAY: "1",
  WORKER_CONCURRENCY_ANALYZE: "1", WORKER_CONCURRENCY_FETCH: "2", WORKER_CONCURRENCY_EXTRACT: "1", WORKER_CONCURRENCY_DIGEST: "1",
  IMGPROXY_MAX_CONCURRENCY: "2", PAID_REQUESTS_PER_MINUTE: "10", PAID_REQUESTS_PER_HOUR: "100", PAID_REQUESTS_PER_DAY: "1000",
};

test("public preflight distinguishes safe configuration from operational acceptance", () => {
  const result = checkPublicDeployment(valid);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some(s => s.includes("backup")));
  assert.ok(result.warnings.some(s => s.includes("ARM64")));
});

test("public preflight rejects exposed or inconsistent ingress and development bypass", () => {
  for (const change of [
    { SITE_URL: "http://news.operator.org" }, { SITE_DOMAIN: "other.operator.org" }, { SITE_DOMAIN: "example.com", SITE_URL: "https://example.com" },
    { PORT: "3000" }, { PORT: "0.0.0.0:3000" }, { PORT: "127.0.0.1:70000" }, { TRUST_PROXY: "false" },
    { DEV_AUTH_ROLE: "admin" }, { ALLOW_PRIVATE_NETWORK_FETCH: "true" },
  ]) assert.ok(checkPublicDeployment({ ...valid, ...change }).errors.length > 0, JSON.stringify(change));
});

test("public preflight refuses implicit paid activation and missing limits without exposing secret values", () => {
  const sentinel = "secret-value-must-not-be-printed";
  const live = { ...valid, COLLECT_ENABLED: "true", MODEL_CALLS_ENABLED: "true", LLM_API_KEY: sentinel };
  assert.ok(checkPublicDeployment(live).errors.length > 0);
  assert.deepEqual(checkPublicDeployment(live, true).errors, []);
  assert.ok(checkPublicDeployment({ ...live, LLM_API_KEY: "" }, true).errors.length > 0);
  assert.ok(checkPublicDeployment({ ...valid, IMGPROXY_UPSTREAM_GB_PER_DAY: "0" }).errors.length > 0);
  assert.ok(checkPublicDeployment({ ...valid, PAID_REQUESTS_PER_MINUTE: "1001" }).errors.length > 0);
  assert.ok(checkPublicDeployment({ ...valid, WORKER_CONCURRENCY_ANALYZE: "0" }).errors.length > 0);
  for (const change of [{ PAID_REQUESTS_PER_DAY: "1000001" }, { PAID_REQUESTS_PER_DAY: "1e3" }, { WORKER_CONCURRENCY_FETCH: "2.0" }]) {
    assert.ok(checkPublicDeployment({ ...valid, ...change }).errors.length > 0);
  }
  const result = checkPublicDeployment({ ...valid, SITE_URL: `https://user:${sentinel}@news.operator.org`, POSTGRES_PASSWORD: sentinel + "@" });
  assert.ok(result.errors.length > 0);
  assert.ok(!JSON.stringify(result).includes(sentinel));
});
