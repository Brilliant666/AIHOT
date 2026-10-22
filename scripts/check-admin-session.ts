// Exercise a real password session through the web proxy on a disposable acceptance site.
// Requires an explicit target and ADMIN_PASSWORD. Never print passwords, cookies or response bodies.
import assert from "node:assert/strict";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { base: { type: "string" } } });
if (!values.base || !process.env.ADMIN_PASSWORD) throw new Error("--base and ADMIN_PASSWORD are required");
const base = new URL(values.base);
if (!/^https?:$/.test(base.protocol) || base.username || base.password) throw new Error("Invalid acceptance URL");
const request = (path: string, init: RequestInit = {}) => fetch(new URL(path, base), {
  ...init, redirect: "manual", signal: AbortSignal.timeout(15_000),
});
let session = "";
try {
  const login = await request("/api/auth/password", {
    method: "POST", body: new URLSearchParams({ password: process.env.ADMIN_PASSWORD, return: "/admin" }),
  });
  assert.equal(login.status, 303, "password form must redirect");
  assert.equal(login.headers.get("location"), "/admin", "password login must succeed");
  const setCookie = login.headers.getSetCookie().find(value => value.startsWith("aihot_admin="));
  assert.ok(setCookie, "login must issue a session cookie");
  session = setCookie.split(";")[0]!;
  assert.ok(/HttpOnly/i.test(setCookie), "session cookie must be HttpOnly");
  assert.ok(/SameSite=Lax/i.test(setCookie), "session cookie must use SameSite=Lax");
  if (base.protocol === "https:") assert.ok(/Secure/i.test(setCookie), "HTTPS session cookie must be Secure");
  assert.equal((await request("/api/auth/check", { headers: { cookie: session } })).status, 204);
  const logout = await request("/api/auth/logout", {
    method: "POST", headers: { cookie: session, "content-type": "application/x-www-form-urlencoded" }, body: "",
  });
  assert.equal(logout.status, 303, "empty HTML logout form must succeed");
  assert.equal(logout.headers.get("location"), "/");
  assert.equal(logout.headers.get("cache-control"), "no-store");
  assert.ok(logout.headers.getSetCookie().some(value => /^aihot_admin=;/.test(value) && /Max-Age=0/i.test(value)), "logout must clear the cookie");
  assert.equal((await request("/api/auth/check", { headers: { cookie: session } })).status, 401, "old session must be revoked in the database");
  session = "";
  console.log("Password login, empty-form logout and stored-session revocation passed.");
} finally {
  if (session) await request("/api/auth/logout", { method: "POST", headers: { cookie: session } }).catch(() => {});
}
