// Cloud skate poster on GitHub Actions cron. Storage: Cloudflare R2 (zero egress).
// Queue = R2 queue/NNN-name.mp4, served via public r2.dev URL. TRIAL reels only.
import { S3Client, ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const IG_USER_ID = process.env.IG_USER_ID;
const SEED_TOKEN = process.env.IG_ACCESS_TOKEN;
const DRY_RUN = process.env.DRY_RUN === "1";
const PUBLIC = process.env.R2_PUBLIC_URL;

const s3 = new S3Client({ region: "auto", endpoint: process.env.R2_ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
const BUCKET = process.env.R2_BUCKET;

const CAPTIONS = ["lowkey fun","one more try","just cruising","felt this one","no thoughts just push","late sesh hits different","same spot every day",""];
const TAG_SETS = ["#skateboarding #sk8 #skatelife #relatable","#skateboarding #skaters #skating #explorepage","#skateboarding #sk8 #skatepark #alt","#skateboarding #skating #skatelife #skaters","#skateboarding #sk8 #skaters #relatable"];
function defaultCaption(file) {
  let seed = 0; for (const c of file) seed += c.charCodeAt(0); seed += new Date().getDate();
  const t = CAPTIONS[seed % CAPTIONS.length], tags = TAG_SETS[seed % TAG_SETS.length];
  return t ? `${t}\n\n${tags}` : tags;
}
async function readText(key) { try { const o = await s3.send(new GetObjectCommand({Bucket:BUCKET,Key:key})); return await o.Body.transformToString(); } catch { return null; } }
async function writeText(key, body) { await s3.send(new PutObjectCommand({Bucket:BUCKET,Key:key,Body:body,ContentType:"application/json"})); }
async function delKey(key) { await s3.send(new DeleteObjectCommand({Bucket:BUCKET,Key:key})); }

async function getToken() { const j = JSON.parse(await readText("state/token.json") || "null"); return j?.access_token || SEED_TOKEN; }
async function refreshToken(token) {
  try { const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`); const j = await r.json();
    if (r.ok && j.access_token) { await writeText("state/token.json", JSON.stringify({access_token:j.access_token,refreshed:new Date().toISOString()})); return j.access_token; } } catch {}
  return token;
}
async function graph(path, params, token) {
  const r = await fetch(`https://graph.instagram.com/v21.0/${path}`, { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({...params, access_token: token}) });
  const j = await r.json(); if (!r.ok || j.error) throw new Error(`graph ${path}: ${JSON.stringify(j.error ?? j)}`); return j;
}
async function waitForContainer(id, token) {
  for (let i=0;i<60;i++){ const j = await fetch(`https://graph.instagram.com/v21.0/${id}?fields=status_code&access_token=${token}`).then(r=>r.json());
    if (j.status_code==="FINISHED") return; if (j.status_code==="ERROR") throw new Error("container error"); await new Promise(r=>setTimeout(r,10000)); }
  throw new Error("container never finished");
}
async function queueKeys() {
  const keys = []; let tok;
  do { const r = await s3.send(new ListObjectsV2Command({Bucket:BUCKET,Prefix:"queue/",ContinuationToken:tok}));
    (r.Contents??[]).forEach(o=>{ if(/\.(mp4|mov|m4v)$/i.test(o.Key)) keys.push(o.Key); }); tok = r.NextContinuationToken; } while (tok);
  return keys.sort();
}
async function alreadyPublished(pendingMs, token) {
  try { const r = await fetch(`https://graph.instagram.com/v21.0/me/media?fields=timestamp&limit=5&access_token=${token}`); const j = await r.json();
    return (j.data??[]).some(m => { const t=new Date(m.timestamp).getTime(); return t>=pendingMs-120000 && t<=pendingMs+1500000; }); } catch { return false; }
}

async function main() {
  let token = await getToken(); token = await refreshToken(token);
  let queue = await queueKeys();
  if (!queue.length) { console.log("queue empty, skipping (no recycling)"); return; }

  const pending = JSON.parse(await readText("state/pending.json") || "null");
  if (pending && !DRY_RUN) {
    if (await alreadyPublished(pending.time, token)) { console.log(`${pending.key} published on lost-response attempt, removing`); await delKey(pending.key); queue = await queueKeys(); }
    await delKey("state/pending.json");
    if (!queue.length) return;
  }

  const key = queue[0];
  const name = key.replace(/^queue\/\d*-?/, "");
  const sidecar = await readText(key.replace(/\.[^.]+$/, ".txt"));
  const caption = sidecar ? sidecar.trim() : defaultCaption(name);
  const videoUrl = `${PUBLIC}/${key}`;

  if (DRY_RUN) { console.log(`DRY RUN: would post ${key} | ${videoUrl} | caption: ${caption}`); return; }

  console.log(`posting ${key} as TRIAL Reel`);
  const container = await graph(`${IG_USER_ID}/media`, { media_type:"REELS", video_url: videoUrl, caption, trial_params:{graduation_strategy:"MANUAL"} }, token);
  await waitForContainer(container.id, token);
  await writeText("state/pending.json", JSON.stringify({ key, time: Date.now() }));
  const published = await graph(`${IG_USER_ID}/media_publish`, { creation_id: container.id }, token);
  await delKey("state/pending.json");
  console.log(`published ${key} -> media id ${published.id}`);
  await delKey(key);
  const left = (await queueKeys()).length;
  console.log(`done, ${left} clips left in queue`);
}
main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
