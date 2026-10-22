import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeLimits } from "../packages/backend/src/lib/runtime-limits.ts";

test("startup limits default to a small worker and bounded paid requests", () => {
  const limits = runtimeLimits({});
  assert.deepEqual(limits.workerConcurrency, { analyze: 1, fetch: 2, extract: 1, digest: 1 });
  assert.deepEqual(limits.paidRequestLimits, { minute: 10, hour: 100, day: 1000 });
  assert.equal(runtimeLimits({ WORKER_CONCURRENCY_FETCH: "4" }).workerConcurrency.fetch, 4);
});

test("invalid resource limits fail instead of silently allowing unbounded work", () => {
  for (const value of ["0", "-1", "33", "2abc", "1.5", "Infinity"]) {
    assert.throws(() => runtimeLimits({ WORKER_CONCURRENCY_FETCH: value }), /WORKER_CONCURRENCY_FETCH/);
  }
  for (const value of ["0", "-1", "1000001", "1e3", "1.5"]) {
    assert.throws(() => runtimeLimits({ PAID_REQUESTS_PER_DAY: value }), /PAID_REQUESTS_PER_DAY/);
  }
  assert.throws(() => runtimeLimits({ PAID_REQUESTS_PER_MINUTE: "200" }), /minute <= hour <= day/);
});
