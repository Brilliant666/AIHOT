// Collection picks up where it stopped: an X search longer than one run continues in later runs until
// it meets the old watermark (no post in between is skipped, no page is bought twice). The watermark
// alone bounds it: posts made weeks before the account was added are kept too.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { adaptIntervals, collectSource } from "@aihot/backend/sources/collect";
import { refreshSourceIcons } from "@aihot/backend/sources/icons";

const T = tag();
const X_SOURCE = `test-x-${T}`;

// SocialData: 45 posts newer than the watermark, newest first half a day apart, 2 a page; `cursor` is the page number.
const BASE = BigInt(Date.now()) * 1000n;
const WATERMARK = BASE + 100n;
const POSTS = Array.from({ length: 45 }, (_, i) => BASE + 145n - BigInt(i));
const tweet = (id: bigint) => ({
  id_str: String(id), tweet_created_at: new Date(Date.now() - Number(BASE + 145n - id) * 12 * 3_600_000).toISOString(),
  full_text: `Post ${id} ${T}`, lang: "en", user: { name: "Test account", screen_name: `acct${T}` },
});
const socialdata = await stub((_hit, req) => {
  const u = new URL(req.url, "http://stub");
  const since = BigInt(/since_id:(\d+)/.exec(u.searchParams.get("query") ?? "")?.[1] ?? "0");
  const page = Number(u.searchParams.get("cursor") ?? 0);
  const ids = POSTS.filter((id) => id > since);
  return { tweets: ids.slice(page * 2, page * 2 + 2).map(tweet), next_cursor: (page + 1) * 2 < ids.length ? String(page + 1) : null };
});

process.env.SOCIALDATA_BASE_URL = socialdata.url;
process.env.SOCIALDATA_API_KEY = "test-key";
config.allowPrivateNetworkFetch = true;

before(async () => {
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 10000, per_day = 100000 WHERE service = 'socialdata'`;
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
            VALUES (${X_SOURCE}, 'Test X', 'x_search', ${sql.json({ query: `from:acct${T}` })}, 'T1', 'editorial',
                    ${sql.json({ initializedAt: new Date().toISOString(), lastTweetId: String(WATERMARK) })}, '2100-01-01')`;
});
after(async () => {
  await socialdata.close();
  await stopBoss();
  await closeDb();
});

test("an X search longer than one run is read to the old watermark over the next runs", async () => {
  const stored = async () => Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE source_id = ${X_SOURCE}`)[0]!.n);
  const cursor = async () => (await sql<{ cursor: { lastTweetId: string; xBacklog?: unknown[] } }[]>`SELECT cursor FROM sources WHERE id = ${X_SOURCE}`)[0]!.cursor;

  const first = await collectSource(X_SOURCE, { force: true });
  assert.equal(first.status, "ok");
  assert.equal(await stored(), 40, "a run reads its own pages and ten more of the stretch left over");
  assert.equal((await cursor()).lastTweetId, String(BASE + 145n), "the watermark moves to the newest post");
  assert.equal((await cursor()).xBacklog?.length, 1, "the unread stretch is kept for the next run");
  const [run] = await sql<{ detail: { truncated: boolean; backlog: number } }[]>`SELECT detail FROM fetch_runs WHERE source_id = ${X_SOURCE} ORDER BY id DESC LIMIT 1`;
  assert.deepEqual([run!.detail.truncated, run!.detail.backlog], [true, 1], "the admin sees the stretch still to read");

  const receipts = await sql`SELECT status FROM receipts WHERE service = 'socialdata' AND subject = ${`source:${X_SOURCE}`}`;
  assert.equal(receipts.length, 20);
  assert.ok(receipts.every((r) => r.status === "completed"), "stored pages complete with the saved coverage, including backlog pages");

  const second = await collectSource(X_SOURCE, { force: true });
  assert.equal(second.status, "ok");
  assert.equal(await stored(), 45, "every post between the old watermark and the newest is stored");
  assert.equal((await cursor()).xBacklog, undefined, "nothing is left to read");
  assert.equal(socialdata.hits(), 20 + 1 + 3, "no page is requested twice");
});

test("daily adaptation preserves manual intervals and changes only explicitly opted-in, enabled sources", async () => {
  const ids: string[] = [];
  const expected = new Map<string, number>();
  try {
    for (const kind of ["rss", "web_list", "json_list", "x_search"] as const) {
      for (const mode of ["default", "false", "true", "paused", "invalid"] as const) {
        const id = `${T}-interval-${kind}-${mode}`;
        ids.push(id);
        const settings = mode === "default" ? {} : { _aihot: { adaptiveInterval: mode === "false" ? false : mode === "invalid" ? "true" : true } };
        const config = kind === "x_search" ? { ...settings, query: `from:manual${T}` } : settings;
        await sql`INSERT INTO sources(id,name,kind,config,enabled,interval_minutes,cursor,next_fetch_at)
          VALUES(${id},${id},${kind},${sql.json(config)},${mode !== "paused"},180,
            ${sql.json({ initializedAt: new Date().toISOString(), lastTweetId: "100" })},'2100-01-01')`;
        expected.set(id, mode === "true" ? kind === "x_search" ? 30 : 60 : 180);
      }
    }
    await adaptIntervals();
    const rows = await sql<{ id: string; interval_minutes: number }[]>`SELECT id,interval_minutes FROM sources WHERE id IN ${sql(ids)}`;
    for (const row of rows) assert.equal(row.interval_minutes, expected.get(row.id), row.id);
    assert.equal(rows.length, ids.length);
  } finally {
    await sql`DELETE FROM sources WHERE id IN ${sql(ids)}`;
  }
});

test("icon refresh makes no requests for paused sources, including one paused while the batch is running", async () => {
  const activeId = `${T}-icon-a`, pendingId = `${T}-icon-b`, pausedId = `${T}-icon-c`;
  const active = await stub(async () => {
    await sql`UPDATE sources SET enabled = false WHERE id = ${pendingId}`;
    return {};
  });
  const pending = await stub(() => ({}));
  const paused = await stub(() => ({}));
  const sources = [
    { id: activeId, server: active, enabled: true },
    { id: pendingId, server: pending, enabled: true },
    { id: pausedId, server: paused, enabled: false },
  ];
  try {
    for (const source of sources) {
      await sql`INSERT INTO sources(id,name,kind,config,enabled,next_fetch_at)
        VALUES(${source.id},${source.id},'rss',${sql.json({ feedUrl: `${source.server.url}/feed.xml` })},${source.enabled},'2100-01-01')`;
    }
    const result = await refreshSourceIcons();
    assert.equal(result.checked, 1);
    assert.ok(active.hits() > 0, "an enabled source's homepage was checked");
    assert.equal(pending.hits(), 0, "pausing after selection still prevents starting the source's requests");
    assert.equal(paused.hits(), 0, "a paused source is not contacted");
    const rows = await sql<{ icon_checked_at: Date | null }[]>`SELECT icon_checked_at FROM sources WHERE id IN ${sql([pendingId, pausedId])}`;
    assert.ok(rows.every(row => row.icon_checked_at === null), "skipped sources are not falsely marked checked");
  } finally {
    await sql`DELETE FROM sources WHERE id IN ${sql(sources.map(s => s.id))}`;
    await Promise.all(sources.map(source => source.server.close()));
  }
});

test("source icons never derive from unpublished or withdrawn article URLs, even after models resume", async () => {
  const id = `${T}-private-mp-icon`;
  const page = await stub(() => ({ round_head_img: "https://example.org/PRIVATE-account-avatar.png" }));
  await sql`INSERT INTO sources(id,name,kind,config,next_fetch_at)
    VALUES(${id},${id},'mp_account','{}','2100-01-01')`;
  for (const suffix of ['unpublished', 'withdrawn']) {
    const articleId = `${id}-${suffix}`;
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)
      VALUES(${articleId},${id},${articleId},${`${page.url}/${suffix}`},'Private material',now(),now())`;
  }
  const withdrawnId = `${id}-withdrawn`;
  await sql`INSERT INTO publications(article_id,source_id,title,url,timeline_at,discovered_at,sort_at,body_mode,visibility,channel)
    VALUES(${withdrawnId},${id},'Private material',${`${page.url}/withdrawn`},now(),now(),now(),'summary','withdrawn','news')`;
  try {
    for (const enabled of [false, true]) {
      config.modelCallsEnabled = enabled;
      await sql`UPDATE sources SET icon_checked_at=NULL WHERE id=${id}`;
      await refreshSourceIcons();
      assert.equal(page.hits(), 0, `models ${enabled}: private article pages must not be used for public source icons`);
      assert.equal((await sql`SELECT icon_url FROM sources WHERE id=${id}`)[0]!.icon_url, null);
    }
    await sql`UPDATE publications SET visibility='public' WHERE article_id=${withdrawnId}`;
    await sql`UPDATE sources SET icon_checked_at=NULL WHERE id=${id}`;
    await refreshSourceIcons();
    assert.equal(page.hits(), 1, "a published article remains a usable icon discovery page");
  } finally {
    config.modelCallsEnabled = true;
    await sql`DELETE FROM articles WHERE source_id=${id}`;
    await sql`DELETE FROM sources WHERE id=${id}`;
    await page.close();
  }
});
