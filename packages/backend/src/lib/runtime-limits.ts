/** Startup-only resource limits. Counts are not currency or token spending limits. */
export function runtimeLimits(env: NodeJS.ProcessEnv = process.env) {
  const integer = (name: string, fallback: number, max: number) => {
    const value = env[name];
    if (value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
      throw new Error(`${name} must be an integer between 1 and ${max}`);
    }
    return parsed;
  };
  const paidRequestLimits = {
    minute: integer("PAID_REQUESTS_PER_MINUTE", 10, 1_000_000),
    hour: integer("PAID_REQUESTS_PER_HOUR", 100, 1_000_000),
    day: integer("PAID_REQUESTS_PER_DAY", 1000, 1_000_000),
  };
  if (paidRequestLimits.minute > paidRequestLimits.hour || paidRequestLimits.hour > paidRequestLimits.day) {
    throw new Error("PAID_REQUESTS limits must satisfy minute <= hour <= day");
  }
  return {
    paidRequestLimits,
    workerConcurrency: {
      analyze: integer("WORKER_CONCURRENCY_ANALYZE", 1, 32),
      fetch: integer("WORKER_CONCURRENCY_FETCH", 2, 32),
      extract: integer("WORKER_CONCURRENCY_EXTRACT", 1, 32),
      digest: integer("WORKER_CONCURRENCY_DIGEST", 1, 32),
    },
  };
}
