// Fetches current YouTube and TikTok views for every video in data.json and
// writes them into stats.json (with a thinned history for later charts).
// Usage: node scripts/update.mjs <data.json> <stats.json>
import { readFileSync, writeFileSync } from "node:fs";

const [dataPath, statsPath] = process.argv.slice(2);
const data = JSON.parse(readFileSync(dataPath, "utf8"));
let stats = {};
try { stats = JSON.parse(readFileSync(statsPath, "utf8")); } catch {}
const prev = stats.videos || {};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const num = s => (s == null ? null : Number(String(s).replace(/[^0-9]/g, "")));
const pick = (s, re) => { const m = s.match(re); return m ? m[1] : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function youtubeId(url) {
  if (!url) return null;
  const m = String(url).match(/(?:shorts\/|watch\?v=|youtu\.be\/|embed\/|live\/)([A-Za-z0-9_-]{11})/) || String(url).match(/^([A-Za-z0-9_-]{11})$/);
  return m ? m[1] : null;
}

async function youtube(id) {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${id}&hl=en&gl=US`, {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Cookie: "CONSENT=YES+1; SOCS=CAI" },
    });
    const html = await res.text();
    const views = num(pick(html, /"viewCount":"(\d+)"/));
    if (views == null) throw new Error(`no viewCount (HTTP ${res.status})`);
    return { views, likes: num(pick(html, /"likeCount":"(\d+)"/)), source: "youtube" };
  } catch (e) {
    // Fallback when YouTube blocks the runner: Return YouTube Dislike's public API.
    const r = await (await fetch(`https://returnyoutubedislikeapi.com/votes?videoId=${id}`)).json();
    if (typeof r.viewCount !== "number") throw new Error(`youtube: ${e.message}; fallback failed`);
    return { views: r.viewCount, likes: r.likes ?? null, source: "ryd" };
  }
}

async function tiktok(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" }, redirect: "follow" });
  const html = await res.text();
  const views = num(pick(html, /"playCount":"?(\d+)/));
  if (views == null) throw new Error(`no playCount (HTTP ${res.status})`);
  return { views, likes: num(pick(html, /"diggCount":"?(\d+)/)), source: "tiktok" };
}

const now = Math.floor(Date.now() / 1000);
const out = {};
for (const v of data.videos || []) {
  const p = prev[v.id] || { history: [] };
  const rec = { yt: p.yt || null, tt: p.tt || null, history: p.history || [] };
  const yid = youtubeId(v.youtube);
  if (yid) {
    try { rec.yt = { ...(await youtube(yid)), at: now }; }
    catch (e) { rec.ytError = e.message; console.log(`[${v.id}] YouTube: ${e.message}`); }
  } else rec.yt = null;
  if (v.tiktok && /tiktok\.com/.test(v.tiktok)) {
    try { rec.tt = { ...(await tiktok(v.tiktok)), at: now }; }
    catch (e) { rec.ttError = e.message; console.log(`[${v.id}] TikTok: ${e.message}`); }
  } else rec.tt = null;
  const last = rec.history[rec.history.length - 1];
  const point = [now, rec.yt?.views ?? null, rec.tt?.views ?? null];
  if (!last || now - last[0] >= 15 * 60) rec.history.push(point);
  if (rec.history.length > 1500) rec.history = rec.history.filter((_, i) => i % 2 === 0 || i > 1000);
  out[v.id] = rec;
  console.log(`[${v.id}] ${v.title}: YT ${rec.yt?.views ?? "-"} | TT ${rec.tt?.views ?? "-"}`);
  await sleep(400);
}

writeFileSync(statsPath, JSON.stringify({ updatedAt: now, videos: out }));
