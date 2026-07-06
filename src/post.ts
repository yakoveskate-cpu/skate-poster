// Skate poster: publishes the oldest clip from the iCloud "Skate Queue" folder
// to Instagram (@yakovterrell) via the official Graph API content publishing flow.
// Run: node src/post.ts        (DRY_RUN=1 to simulate)

import { readFileSync, writeFileSync, readdirSync, statSync, renameSync, appendFileSync, existsSync, utimesSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, basename, extname } from "node:path";
import { homedir } from "node:os";

const QUEUE = join(homedir(), "Library/Mobile Documents/com~apple~CloudDocs/Skate Queue");
const DONE = join(QUEUE, "done");
const LOG = join(homedir(), "Projects/skate-poster/posts.log");
const ENV_FILE = join(homedir(), ".config/skate-poster/env");
const LOW_QUEUE_THRESHOLD = 6;

const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v"]);
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png"]);

// Format copied from top-performing skate reels (254K-1.6M likes, checked 2026-07-05):
// 1-3 casual lowercase words + 4-5 hashtags (core skate tags + one vibe tag). Nothing else.
const CAPTIONS = [
  "lowkey fun",
  "one more try",
  "just cruising",
  "felt this one",
  "no thoughts just push",
  "late sesh hits different",
  "same spot every day",
  "",
];
const TAG_SETS = [
  "#skateboarding #sk8 #skatelife #relatable",
  "#skateboarding #skaters #skating #explorepage",
  "#skateboarding #sk8 #skatepark #alt",
  "#skateboarding #skating #skatelife #skaters",
  "#skateboarding #sk8 #skaters #relatable",
];

function defaultCaption(file: string): string {
  let seed = 0;
  for (const c of file) seed += c.charCodeAt(0);
  seed += new Date().getDate();
  const text = CAPTIONS[seed % CAPTIONS.length];
  const tags = TAG_SETS[seed % TAG_SETS.length];
  return text ? `${text}\n\n${tags}` : tags;
}

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  appendFileSync(LOG, line + "\n");
}

function notify(msg: string) {
  try {
    execSync(`osascript -e 'display notification ${JSON.stringify(msg)} with title "Skate Poster"'`);
  } catch {}
}

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (existsSync(ENV_FILE)) {
    for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  }
  return env;
}

// HARD RULE (Yakov, 2026-07-05): this account posts TRIAL reels only.
// Images can't be trials, so only videos are ever picked up.
function pickOldest(): string | null {
  const files = readdirSync(QUEUE)
    .filter((f) => VIDEO_EXT.has(extname(f).toLowerCase()))
    .filter((f) => !f.startsWith("."))
    .map((f) => ({ f, mtime: statSync(join(QUEUE, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);
  return files.length ? files[0].f : null;
}

// Queue lasts forever: when empty, move everything from done/ back in,
// preserving the original posting order via staggered mtimes.
function recycleQueue(): number {
  if (!existsSync(DONE)) return 0;
  const files = readdirSync(DONE)
    .filter((f) => VIDEO_EXT.has(extname(f).toLowerCase()) && !f.startsWith("."))
    .map((f) => ({ f, mtime: statSync(join(DONE, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);
  files.forEach(({ f }, i) => {
    renameSync(join(DONE, f), join(QUEUE, f));
    const stamp = new Date(Date.now() + i * 1000);
    utimesSync(join(QUEUE, f), stamp, stamp);
    const sidecar = basename(f, extname(f)) + ".txt";
    if (existsSync(join(DONE, sidecar))) renameSync(join(DONE, sidecar), join(QUEUE, sidecar));
  });
  return files.length;
}

function captionFor(file: string): string {
  const sidecar = join(QUEUE, basename(file, extname(file)) + ".txt");
  if (existsSync(sidecar)) return readFileSync(sidecar, "utf8").trim();
  return defaultCaption(file);
}

async function uploadToBlob(filePath: string, token: string): Promise<string> {
  const name = `skate/${Date.now()}-${basename(filePath).replace(/[^\w.\-]/g, "_")}`;
  const res = await fetch(`https://blob.vercel-storage.com/${name}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "x-api-version": "7", "x-content-type": "application/octet-stream" },
    body: readFileSync(filePath),
  });
  if (!res.ok) throw new Error(`blob upload failed ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { url: string };
  return json.url;
}

async function deleteBlob(url: string, token: string) {
  try {
    await fetch("https://blob.vercel-storage.com/delete", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-api-version": "7", "content-type": "application/json" },
      body: JSON.stringify({ urls: [url] }),
    });
  } catch {}
}

async function graph(path: string, params: Record<string, unknown>, token: string) {
  const res = await fetch(`https://graph.instagram.com/v21.0/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...params, access_token: token }),
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(`graph ${path}: ${JSON.stringify(json.error ?? json)}`);
  return json;
}

async function waitForContainer(creationId: string, token: string) {
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`https://graph.instagram.com/v21.0/${creationId}?fields=status_code&access_token=${token}`);
    const json = await res.json();
    if (json.status_code === "FINISHED") return;
    if (json.status_code === "ERROR") throw new Error(`container error: ${JSON.stringify(json)}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error("container never finished processing");
}

// IG login tokens expire after 60 days; refresh extends another 60.
// Fails harmlessly if the token is <24h old (Meta only refreshes older tokens).
async function refreshToken(env: Record<string, string>) {
  try {
    const res = await fetch(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${env.IG_ACCESS_TOKEN}`
    );
    const json = await res.json();
    if (res.ok && json.access_token && json.access_token !== env.IG_ACCESS_TOKEN) {
      env.IG_ACCESS_TOKEN = json.access_token;
      const lines = readFileSync(ENV_FILE, "utf8")
        .split("\n")
        .map((l) => (l.startsWith("IG_ACCESS_TOKEN=") ? `IG_ACCESS_TOKEN=${json.access_token}` : l));
      writeFileSync(ENV_FILE, lines.join("\n"));
      log("refreshed IG access token");
    }
  } catch {}
}

// A "fetch failed" on publish can mean the post actually went through and only
// the response was lost (caused a double post on 2026-07-05). Recovery check:
// if posts.log shows a failed attempt for THIS file, ask IG whether any media
// appeared within 25min of that attempt. Caption matching is not safe here —
// the small caption pool collides across clips (false-skipped IMG_8842 on 07-06).
function lastFailedAttempt(file: string): number | null {
  try {
    const lines = readFileSync(LOG, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes(`published ${file}`)) return null;
      if (lines[i].includes(`posting ${file}`)) {
        const failed = lines.slice(i + 1).some((l) => l.includes("ERROR"));
        if (!failed) return null;
        const m = lines[i].match(/^\[([^\]]+)\]/);
        return m ? new Date(m[1]).getTime() : null;
      }
    }
  } catch {}
  return null;
}

async function alreadyPublished(file: string, token: string): Promise<boolean> {
  const attempt = lastFailedAttempt(file);
  if (!attempt) return false;
  try {
    const res = await fetch(
      `https://graph.instagram.com/v21.0/me/media?fields=timestamp&limit=5&access_token=${token}`
    );
    const json = await res.json();
    if (!res.ok || !json.data) return false;
    return json.data.some((m: { timestamp: string }) => {
      const t = new Date(m.timestamp).getTime();
      return t >= attempt - 2 * 60_000 && t <= attempt + 25 * 60_000;
    });
  } catch {
    return false;
  }
}

async function main() {
  const env = loadEnv();
  if (env.IG_ACCESS_TOKEN) await refreshToken(env);
  const dryRun = process.env.DRY_RUN === "1" || env.DRY_RUN === "1";

  let file = pickOldest();
  if (!file) {
    const recycled = recycleQueue();
    if (recycled > 0) {
      log(`queue empty, recycled ${recycled} clips from done/`);
      file = pickOldest();
    }
  }
  if (!file) {
    log("queue empty, nothing to post");
    notify("Skate queue is EMPTY. No post went out. Drop clips into iCloud > Skate Queue.");
    return;
  }

  let filePath = join(QUEUE, file);
  let caption = captionFor(file);

  if (!dryRun && env.IG_ACCESS_TOKEN) {
    while (file && (await alreadyPublished(file, env.IG_ACCESS_TOKEN))) {
      log(`${file} was already published (recovered lost response), moving to done`);
      renameSync(filePath, join(DONE, file));
      const sc = join(QUEUE, basename(file, extname(file)) + ".txt");
      if (existsSync(sc)) renameSync(sc, join(DONE, basename(sc)));
      file = pickOldest();
      if (!file) return;
      filePath = join(QUEUE, file);
      caption = captionFor(file);
    }
  }

  if (dryRun) {
    log(`DRY RUN: would post ${file} as TRIAL Reel with caption: ${caption}`);
    return;
  }

  const { IG_USER_ID, IG_ACCESS_TOKEN, BLOB_READ_WRITE_TOKEN } = env;
  if (!IG_USER_ID || !IG_ACCESS_TOKEN || !BLOB_READ_WRITE_TOKEN) {
    log("not configured yet (missing IG_USER_ID / IG_ACCESS_TOKEN / BLOB_READ_WRITE_TOKEN), skipping");
    return;
  }

  log(`posting ${file} as TRIAL Reel`);
  const mediaUrl = await uploadToBlob(filePath, BLOB_READ_WRITE_TOKEN);

  try {
    const params = {
      media_type: "REELS",
      video_url: mediaUrl,
      caption,
      trial_params: { graduation_strategy: "MANUAL" },
    };
    const container = await graph(`${IG_USER_ID}/media`, params, IG_ACCESS_TOKEN);
    await waitForContainer(container.id, IG_ACCESS_TOKEN);
    const published = await graph(`${IG_USER_ID}/media_publish`, { creation_id: container.id }, IG_ACCESS_TOKEN);
    log(`published ${file} -> media id ${published.id}`);
  } finally {
    await deleteBlob(mediaUrl, BLOB_READ_WRITE_TOKEN);
  }

  renameSync(filePath, join(DONE, file));
  const sidecar = join(QUEUE, basename(file, extname(file)) + ".txt");
  if (existsSync(sidecar)) renameSync(sidecar, join(DONE, basename(sidecar)));

  const remaining = readdirSync(QUEUE).filter(
    (f) => !f.startsWith(".") && (VIDEO_EXT.has(extname(f).toLowerCase()) || IMAGE_EXT.has(extname(f).toLowerCase()))
  ).length;
  log(`done, ${remaining} clips left in queue`);
  if (remaining < LOW_QUEUE_THRESHOLD) {
    notify(`Skate queue is low: ${remaining} clips left. Drop more into iCloud > Skate Queue.`);
  }
}

main().catch((e) => {
  log(`ERROR: ${e.message}`);
  notify(`Skate post FAILED: ${e.message}`);
  process.exit(1);
});
