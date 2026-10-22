// Configuration validation only: no network, database, container or paid service is contacted.
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { runtimeLimits } from "../packages/backend/src/lib/runtime-limits.ts";

export function checkPublicDeployment(env: Record<string, string | undefined>, live = false): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const require = (ok: boolean, message: string) => { if (!ok) errors.push(message); };
  let url: URL | null = null;
  try { url = new URL(env.SITE_URL ?? ""); } catch { /* Report the field, never its potentially secret value. */ }
  require(!!url && url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/" && !url.port,
    "SITE_URL must be the public HTTPS origin, with no credentials, path or nonstandard port.");
  const domain = env.SITE_DOMAIN ?? "";
  require(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain) && !isIP(domain)
    && !/(?:^|\.)(?:localhost|example\.(?:com|org|net)|invalid|test)$/i.test(domain), "SITE_DOMAIN must be your real public DNS name.");
  require(!!url && url.hostname.toLowerCase() === domain.toLowerCase(), "SITE_URL and SITE_DOMAIN must name the same host.");
  const port = env.PORT || "127.0.0.1:3000";
  const match = /^127\.0\.0\.1:(\d+)$/.exec(port);
  require(!!match && Number(match[1]) >= 1024 && Number(match[1]) <= 65535, "PORT must bind an unprivileged port on 127.0.0.1 only.");
  require(env.TRUST_PROXY === "true", "TRUST_PROXY must be true for the bundled Caddy HTTPS ingress.");
  for (const [key, minimum] of [["ADMIN_PASSWORD", 12], ["SESSION_SECRET", 32], ["IMG_PROXY_SIGN_SECRET", 32]] as const) {
    const value = env[key] ?? "";
    require(value.trim().length >= minimum && !/^(?:change.?me|replace|example|test|your[-_])/i.test(value), `${key} needs a generated secret of at least ${minimum} characters.`);
  }
  require(/^[A-Za-z0-9_-]{24,}$/.test(env.POSTGRES_PASSWORD ?? ""), "POSTGRES_PASSWORD needs at least 24 URL-safe characters (init-env generates this).");
  require(!env.DEV_AUTH_ROLE && !env.DEV_AUTH_DISPLAY_NAME, "Remove development authentication variables before public use.");
  require(env.ALLOW_PRIVATE_NETWORK_FETCH !== "true", "ALLOW_PRIVATE_NETWORK_FETCH must not be enabled.");
  for (const key of ["COLLECT_ENABLED", "MODEL_CALLS_ENABLED"] as const) {
    require(env[key] === "false" || (live && env[key] === "true"), `${key} must be false for trial validation; use --live only after configuring sources and paid-call budgets.`);
  }
  if (live && env.MODEL_CALLS_ENABLED === "true") {
    require(!!env.LLM_API_KEY?.trim(), "LLM_API_KEY must be configured before enabling model calls.");
    warnings.push("Live model calls are enabled. Application request limits are not a currency spending cap; verify the provider's spending limit separately.");
  }
  for (const key of ["IMGPROXY_UPSTREAM_MB_PER_MINUTE", "IMGPROXY_UPSTREAM_GB_PER_DAY"]) {
    const value = Number(env[key]);
    require(Number.isFinite(value) && value > 0, `${key} must set a positive finite image upstream limit.`);
  }
  for (const key of ["WORKER_CONCURRENCY_ANALYZE", "WORKER_CONCURRENCY_FETCH", "WORKER_CONCURRENCY_EXTRACT", "WORKER_CONCURRENCY_DIGEST"]) {
    const value = Number(env[key]);
    require(Number.isInteger(value) && value >= 1 && value <= 32, `${key} must be an integer from 1 to 32.`);
  }
  const imageConcurrency = Number(env.IMGPROXY_MAX_CONCURRENCY);
  require(Number.isInteger(imageConcurrency) && imageConcurrency >= 1 && imageConcurrency <= 8, "IMGPROXY_MAX_CONCURRENCY must be an integer from 1 to 8.");
  const paid = ["PAID_REQUESTS_PER_MINUTE", "PAID_REQUESTS_PER_HOUR", "PAID_REQUESTS_PER_DAY"].map(key => Number(env[key]));
  require(paid.every(n => Number.isSafeInteger(n) && n > 0) && paid[0]! <= paid[1]! && paid[1]! <= paid[2]!,
    "PAID_REQUESTS_PER_MINUTE/HOUR/DAY need positive integer limits ordered minute <= hour <= day.");
  // Keep the preflight aligned with the startup parser, including strict decimal syntax and caps.
  try { runtimeLimits(env); } catch (error) { errors.push((error as Error).message); }
  const restart = env.RESTART_POLICY || "no";
  require(["no", "unless-stopped"].includes(restart), "RESTART_POLICY must be no (manual trial) or unless-stopped (intentional persistent operation).");
  if (restart !== "no") warnings.push("Container restart is enabled; this is a persistent-operation choice, not a manual trial.");
  if (!["DB_BACKUP_STORE_SECRET_ID", "DB_BACKUP_STORE_SECRET_KEY", "DB_BACKUP_STORE_BUCKET", "DB_BACKUP_STORE_REGION"].every(k => !!env[k]?.trim())) {
    warnings.push("Automatic off-site backup is not fully configured. Complete and test the paired database/files backup in docs/public-deployment.md before public operation.");
  }
  warnings.push("Configuration checks do not verify DNS, certificates, ARM64 startup, restore success, resource headroom or existing proxy/SSH connectivity.");
  warnings.push("Only the env file was checked. Shell variables can override Compose interpolation; privately verify the rendered Compose settings without publishing secrets.");
  return { errors, warnings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const envAt = args.indexOf("--env");
  if (args.some((a, i) => a !== "--live" && a !== "--env" && !(envAt >= 0 && i === envAt + 1)) || (envAt >= 0 && (!args[envAt + 1] || args[envAt + 1]!.startsWith("--")))) {
    console.error("Usage: node scripts/check-public-deployment.ts [--env path] [--live]");
    process.exit(1);
  }
  let env: Record<string, string | undefined>;
  try { env = parseEnv(readFileSync(envAt >= 0 ? args[envAt + 1]! : ".env", "utf8")); }
  catch { console.error("Cannot read or parse the deployment env file. No configuration values were printed."); process.exit(1); }
  const result = checkPublicDeployment(env, args.includes("--live"));
  for (const line of result.errors) console.error(`ERROR: ${line}`);
  for (const line of result.warnings) console.warn(`NOTE: ${line}`);
  if (result.errors.length) process.exitCode = 1;
  else console.log("Public deployment configuration passed; complete the runtime acceptance checklist before launch.");
}
