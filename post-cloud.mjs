// Cloud skate poster: runs on GitHub Actions cron, no Mac needed.
// Queue lives in Vercel Blob (queue/NNN-name.mp4, posted files move to done/).
// TRIAL reels only (hard rule): trial_params MANUAL on every post.
import { list, put, del, copy } from "@vercel/blob";

const IG_USER_ID = process.env.IG_USER_ID;
const SEED_TOKEN = process.env.IG_ACCESS_TOKEN;
const DRY_RUN = process.env.DRY_RUN === "1";

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

function defaultCaption(file) {
  let seed = 0;
  for (const c of file) seed += c.charCodeAt(0);
  seed += new Date().getDate();
  const text = CAPTIONS[seed % CAPTIONS.length];
  const tags = TAG_SETS[seed % TAG_SETS.length];
  return text ? `${text}\n\n${tags}` : tags;
}

async function getToken() {
  const { blobs } = await list({ prefix: "state/token.json" });
  if (blobs.length) {
    const j = await fetch(blobs[0].url + "?ts=" + Date.now()).then((r) => r.json());
    if (j.access_token) return j.access_token;
  }
  return SEED_TOKEN;
}

async function refreshToken(token) {
  try {
    const res = await fetch(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`
    );
    const j = await res.json();
    if (res.ok && j.access_token) {
      await put("state/token.json", JSON.stringify({ access_token: j.access_token, refreshed: new Date().toISOString() }), {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      return j.access_token;
    }
  } catch {}
  return token;
}

async function graph(path, params, token) {
  const res = await fetch(`https://graph.instagram.com/v21.0/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...params, access_token: token }),
  });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(`graph ${path}: ${JSON.stringify(j.error ?? j)}`);
  return j;
}

// Lost-response recovery: a pending marker is written before each publish and
// cleared after success. If a marker survives, check whether any media appeared
// within 25min of that attempt. Caption matching is unsafe (pool collisions).
async function pendingMarker() {
  const { blobs } = await list({ prefix: "state/pending.json" });
  if (!blobs.length) return null;
  try {
    return await fetch(blobs[0].url + "?ts=" + Date.now()).then((r) => r.json());
  } catch {
    return null;
  }
}

async function setPending(pathname) {
  await put("state/pending.json", JSON.stringify({ pathname, time: Date.now() }), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

async function clearPending() {
  const { blobs } = await list({ prefix: "state/pending.json" });
  for (const b of blobs) await del(b.url);
}

async function attemptSucceeded(attemptMs, token) {
  try {
    const res = await fetch(
      `https://graph.instagram.com/v21.0/me/media?fields=timestamp&limit=5&access_token=${token}`
    );
    const j = await res.json();
    if (!res.ok || !j.data) return false;
    return j.data.some((m) => {
      const t = new Date(m.timestamp).getTime();
      return t >= attemptMs - 2 * 60_000 && t <= attemptMs + 25 * 60_000;
    });
  } catch {
    return false;
  }
}

async function waitForContainer(id, token) {
  for (let i = 0; i < 60; i++) {
    const j = await fetch(
      `https://graph.instagram.com/v21.0/${id}?fields=status_code&access_token=${token}`
    ).then((r) => r.json());
    if (j.status_code === "FINISHED") return;
    if (j.status_code === "ERROR") throw new Error(`container error: ${JSON.stringify(j)}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error("container never finished");
}

async function queueBlobs() {
  const { blobs } = await list({ prefix: "queue/", limit: 1000 });
  return blobs
    .filter((b) => /\.(mp4|mov|m4v)$/i.test(b.pathname))
    .sort((a, b) => a.pathname.localeCompare(b.pathname));
}

async function recycle() {
  const { blobs } = await list({ prefix: "done/", limit: 1000 });
  const vids = blobs.filter((b) => /\.(mp4|mov|m4v|txt)$/i.test(b.pathname));
  for (const b of vids) {
    await copy(b.url, b.pathname.replace(/^done\//, "queue/"), { access: "public", addRandomSuffix: false });
    await del(b.url);
  }
  return vids.filter((b) => !b.pathname.endsWith(".txt")).length;
}

async function captionFor(pathname) {
  const sidecar = pathname.replace(/\.[^.]+$/, ".txt");
  const { blobs } = await list({ prefix: sidecar });
  if (blobs.length) return (await fetch(blobs[0].url).then((r) => r.text())).trim();
  return defaultCaption(pathname.replace(/^queue\/\d+-/, ""));
}

async function main() {
  let token = await getToken();
  token = await refreshToken(token);

  let queue = await queueBlobs();
  if (!queue.length) {
    // NEVER recycle: reposting an already-posted file gets duplicate-flagged
    // by Instagram and buried at ~1 view (learned 2026-07-11). Skip instead.
    console.log("queue empty, skipping post (no recycling, fresh content only)");
    return;
  }

  const pending = await pendingMarker();
  if (pending && !DRY_RUN) {
    if (await attemptSucceeded(pending.time, token)) {
      console.log(`${pending.pathname} was published on a lost-response attempt, moving to done`);
      const { blobs } = await list({ prefix: pending.pathname });
      for (const b of blobs) {
        await copy(b.url, b.pathname.replace(/^queue\//, "done/"), { access: "public", addRandomSuffix: false });
        await del(b.url);
      }
      queue = await queueBlobs();
    }
    await clearPending();
    if (!queue.length) return;
  }

  const clip = queue[0];
  const caption = await captionFor(clip.pathname);

  if (DRY_RUN) {
    console.log(`DRY RUN: would post ${clip.pathname} as TRIAL Reel with caption: ${caption}`);
    return;
  }

  console.log(`posting ${clip.pathname} as TRIAL Reel`);
  const container = await graph(
    `${IG_USER_ID}/media`,
    { media_type: "REELS", video_url: clip.url, caption, trial_params: { graduation_strategy: "MANUAL" } },
    token
  );
  await waitForContainer(container.id, token);
  await setPending(clip.pathname);
  const published = await graph(`${IG_USER_ID}/media_publish`, { creation_id: container.id }, token);
  await clearPending();
  console.log(`published ${clip.pathname} -> media id ${published.id}`);

  // delete posted blob outright (no done/ archive: storage-capped, and we never recycle)
  await del(clip.url);
  const sidecar = clip.pathname.replace(/\.[^.]+$/, ".txt");
  const { blobs: sc } = await list({ prefix: sidecar });
  if (sc.length) await del(sc[0].url);

  const left = (await queueBlobs()).length;
  console.log(`done, ${left} clips left in queue`);
}

main().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});
