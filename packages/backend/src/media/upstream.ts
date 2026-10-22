// Shared response-body budget for uncached images (API and worker). Reserve before fetching;
// completed responses refund unused capacity. Failed/interrupted downloads retain their reservation
// until each window expires, since their partial body length is unknown. This is not wire billing:
// HTTP/TLS overhead, redirects and a final transport chunk are not measured here.
import { beijingDate } from "@aihot/contracts/time";
import { DEPLOYMENT } from "@aihot/site";
import { sql, type Tx } from "../db.ts";
import type { Finding } from "../notify/feishu.ts";

const USAGE_KEY = "egress.imgproxy.usage";
interface Usage { minute: number; minuteBytes: number; day: string; dayBytes: number }
export type UpstreamReservation = { ok: false; reason: string } | {
  ok: true;
  maxBytes: number;
  /** Call once after receiving a complete response, even for an HTTP error status. */
  complete(bytes: number): Promise<void>;
};

function budget(name: string, site: number | undefined, unit: number): number {
  const value = process.env[name] ?? site;
  if (value === undefined) return Infinity;
  const bytes = Number(value) * unit;
  if (String(value).trim() === "" || !Number.isFinite(bytes) || bytes < 0 || bytes > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
  return Math.floor(bytes);
}

async function readUsage(tx: Tx): Promise<Usage | undefined> {
  const [row] = await tx<{ value: Usage }[]>`SELECT value FROM settings WHERE key = ${USAGE_KEY}`;
  return row?.value;
}

async function writeUsage(tx: Tx, usage: Usage): Promise<void> {
  await tx`INSERT INTO settings (key, value, updated_by) VALUES (${USAGE_KEY}, ${tx.json({ ...usage })}, 'imgproxy')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
}

/** Atomically admits at most the remaining body bytes; every process shares the same ledger. */
export async function reserveUpstream(maxBytes: number, now?: number): Promise<UpstreamReservation> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Image response limit must be a positive integer");
  const minuteLimit = budget("IMGPROXY_UPSTREAM_MB_PER_MINUTE", DEPLOYMENT.imageUpstreamBudget?.mbPerMinute, 1e6);
  const dayLimit = budget("IMGPROXY_UPSTREAM_GB_PER_DAY", DEPLOYMENT.imageUpstreamBudget?.gbPerDay, 1e9);
  if (minuteLimit === Infinity && dayLimit === Infinity) return { ok: true, maxBytes, complete: async () => {} };
  const admission = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${USAGE_KEY}))`;
    // Evaluate the production clock after admission to the lock: a queued request must not reset
    // the ledger to an older window after another process has already advanced it.
    const admittedAt = now ?? Date.now();
    const minute = Math.floor(admittedAt / 60_000);
    const day = beijingDate(admittedAt);
    const previous = await readUsage(tx);
    const usage: Usage = {
      minute, minuteBytes: previous?.minute === minute ? previous.minuteBytes : 0,
      day, dayBytes: previous?.day === day ? previous.dayBytes : 0,
    };
    const reserved = Math.min(maxBytes, minuteLimit - usage.minuteBytes, dayLimit - usage.dayBytes);
    if (reserved <= 0) {
      const window = usage.dayBytes >= dayLimit ? "day" : "minute";
      const reason = window === "day" ? `图片代理上游响应额度达到每日 ${dayLimit / 1e9} GB` : `图片代理上游响应额度达到每分钟 ${minuteLimit / 1e6} MB`;
      await tx`INSERT INTO settings (key, value, updated_by) VALUES ('egress.imgproxy', ${tx.json({ window, reason, day, at: new Date(admittedAt).toISOString(), dayBytes: usage.dayBytes })}, 'imgproxy')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
      return { ok: false as const, reason };
    }
    usage.minuteBytes += reserved;
    usage.dayBytes += reserved;
    await writeUsage(tx, usage);
    return { ok: true as const, maxBytes: reserved, minute, day };
  });
  if (!admission.ok) return admission;
  let completed = false;
  return {
    ...admission,
    async complete(bytes: number) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > admission.maxBytes) throw new Error("Invalid image response byte count");
      if (completed) return;
      completed = true;
      const refund = admission.maxBytes - bytes;
      if (refund === 0) return;
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${USAGE_KEY}))`;
        const usage = await readUsage(tx);
        if (!usage) return;
        // A response spanning a rollover must never refund a newer minute or day's requests.
        if (usage.minute === admission.minute) usage.minuteBytes = Math.max(0, usage.minuteBytes - refund);
        if (usage.day === admission.day) usage.dayBytes = Math.max(0, usage.dayBytes - refund);
        await writeUsage(tx, usage);
      });
    },
  };
}

/** Only the current Beijing day's exhaustion is actionable; midnight clears yesterday's warning. */
export async function upstreamFindings(now = Date.now()): Promise<Finding[]> {
  const [img] = await sql<{ value: { window: string; reason: string; day?: string }; updated_at: Date }[]>`SELECT value, updated_at FROM settings WHERE key = 'egress.imgproxy'`;
  if (!img || img.value.window !== "day" || (img.value.day ?? beijingDate(img.updated_at.getTime())) !== beijingDate(now)) return [];
  const [usage] = await sql<{ value: Usage }[]>`SELECT value FROM settings WHERE key = ${USAGE_KEY}`;
  const limit = budget("IMGPROXY_UPSTREAM_GB_PER_DAY", DEPLOYMENT.imageUpstreamBudget?.gbPerDay, 1e9);
  if (usage?.value.day !== beijingDate(now) || usage.value.dayBytes < limit) return [];
  return [{ key: "egress.imgproxy", level: "later", title: "图片代理今天的响应额度用完了，未缓存的图片到零点前显示不出来", detail: String(img.value.reason) }];
}
