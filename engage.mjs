// Engagement bot: replies to fresh comments on trial reels + seeds a first
// question-comment on new posts. Runs on GitHub Actions cron every 30 min.
import { list, put } from "@vercel/blob";

const SEED_TOKEN = process.env.IG_ACCESS_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const SELF = "yakovterrell";
const MAX_REPLIES_PER_RUN = 20;

const REPLIES = [
  "appreciate you 🙏",
  "🔥🔥",
  "means a lot fr",
  "more coming tomorrow",
  "trying to get it cleaner 😅",
  "this spot is unreal",
  "took me way too many tries lol",
  "🙏🔥",
  "respect 🤝",
  "אח שלי 🙏",
  "תודה אחי",
  "haha real",
];
const ANSWERS = [
  "honestly took like 20 tries",
  "board is an 8.25 if you were wondering",
  "this park is in israel 🇮🇱",
  "been skating 12 years now",
  "just practice it slow first fr",
];
const FIRST_COMMENTS = [
  "rate this 1-10",
  "what trick should i learn next?",
  "first try or nah? 😅",
  "which spot should i hit next?",
  "does this count as a clean landing?",
  "be honest, was that mid?",
];

async function smartReply(commentText, username) {
  if (!GEMINI_KEY) return null;
  const prompt = `You are Yakov (@yakovterrell), a young Israeli skater replying to a comment on one of your skateboarding trial reels on Instagram.
The comment from @${username}: "${commentText}"
Write ONE short reply (under 15 words). Rules:
- casual lowercase skater voice, max 1 emoji, no hashtags
- if they asked a question, actually answer it with personality (you skate 12 years, ride an 8.25, skate parks and street in Israel, film everything yourself)
- about half the time, end with a short question back to keep them commenting
- if the comment is in Hebrew, reply in Hebrew
- never sound like a bot, never be formal
Reply with ONLY the reply text.`;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.9, maxOutputTokens: 60 } }),
    });
    const j = await r.json();
    const t = j.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (t && t.length > 0 && t.length < 120) return t.replace(/^["']|["']$/g, "");
  } catch {}
  return null;
}

function pick(arr, seed) {
  let h = 0;
  for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return arr[h % arr.length];
}

async function getToken() {
  const { blobs } = await list({ prefix: "state/token.json" });
  if (blobs.length) {
    const j = await fetch(blobs[0].url + "?ts=" + Date.now()).then((r) => r.json());
    if (j.access_token) return j.access_token;
  }
  return SEED_TOKEN;
}

async function getState() {
  const { blobs } = await list({ prefix: "state/engage.json" });
  if (blobs.length) {
    try {
      return await fetch(blobs[0].url + "?ts=" + Date.now()).then((r) => r.json());
    } catch {}
  }
  return { replied: [], seeded: [] };
}

async function saveState(st) {
  st.replied = st.replied.slice(-2000);
  st.seeded = st.seeded.slice(-300);
  await put("state/engage.json", JSON.stringify(st), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

async function main() {
  const token = await getToken();
  const st = await getState();
  const media = (
    await fetch(
      `https://graph.instagram.com/v21.0/me/media?fields=id,timestamp&limit=15&access_token=${token}`
    ).then((r) => r.json())
  ).data ?? [];

  let replies = 0;
  for (const m of media) {
    const ageH = (Date.now() - new Date(m.timestamp).getTime()) / 3600e3;

    // seed a first question-comment on fresh posts (>=20min old so it doesn't look instant)
    if (ageH > 0.33 && ageH < 6 && !st.seeded.includes(m.id)) {
      const msg = pick(FIRST_COMMENTS, m.id);
      const res = await fetch(
        `https://graph.instagram.com/v21.0/${m.id}/comments`,
        { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: msg, access_token: token }) }
      );
      const j = await res.json();
      if (res.ok && j.id) { console.log(`seeded "${msg}" on ${m.id}`); st.seeded.push(m.id); }
      else console.log(`seed failed on ${m.id}: ${JSON.stringify(j.error ?? j).slice(0,120)}`);
    }

    if (ageH > 72) continue;
    const comments = (
      await fetch(
        `https://graph.instagram.com/v21.0/${m.id}/comments?fields=id,text,username,timestamp&limit=50&access_token=${token}`
      ).then((r) => r.json())
    ).data ?? [];

    for (const c of comments) {
      if (replies >= MAX_REPLIES_PER_RUN) break;
      if (c.username === SELF || st.replied.includes(c.id)) continue;
      if ((Date.now() - new Date(c.timestamp).getTime()) / 3600e3 > 48) continue;
      let msg = await smartReply(c.text ?? "", c.username);
      if (!msg) {
        const pool = c.text && c.text.includes("?") ? ANSWERS : REPLIES;
        msg = pick(pool, c.id);
      }
      const res = await fetch(
        `https://graph.instagram.com/v21.0/${c.id}/replies`,
        { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: msg, access_token: token }) }
      );
      const j = await res.json();
      if (res.ok && j.id) { console.log(`replied "${msg}" to @${c.username}`); st.replied.push(c.id); replies++; }
      else { console.log(`reply failed: ${JSON.stringify(j.error ?? j).slice(0,120)}`); st.replied.push(c.id); }
    }
  }
  await saveState(st);
  console.log(`done: ${replies} replies this run`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
