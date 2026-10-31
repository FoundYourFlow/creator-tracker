// Creator Tracker bot.
//  1. Finds new uploads on each creator's YouTube channel (official RSS feed) and adds them to data.json.
//  2. Fetches current views for every video link (YouTube + TikTok) into stats.json.
// Instagram and Pinterest don't expose view counts publicly, so those are typed in on the site.
// Usage: node scripts/update.mjs <data.json> <stats.json>   (exit code 0; prints "DATA_CHANGED" if data.json was edited)
import { readFileSync, writeFileSync } from "node:fs";

const [dataPath, statsPath] = process.argv.slice(2);
const PLATFORMS = ["youtube", "tiktok", "instagram", "pinterest"];
const STATUSES = ["Not Posted", "Scheduled", "Posted"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const YT_KEY = process.env.YT_API_KEY || "";

const num = s => (s == null ? null : Number(String(s).replace(/[^0-9]/g, "")));
const pick = (s, re) => { const m = s.match(re); return m ? m[1] : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const decode = s => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/* ---------- data format (kept identical to the site's norm()) ---------- */
export function norm(d) {
  d = d || {};
  const creators = (d.creators || []).map(c => typeof c === "string"
    ? { name: c, platforms: ["youtube", "tiktok"], accounts: {} }
    : { name: String(c.name || "").trim(), platforms: (c.platforms || []).filter(p => PLATFORMS.includes(p)), accounts: c.accounts || {} , ...(c.trackSince ? { trackSince: c.trackSince } : {}) })
    .filter(c => c.name);
  const videos = (d.videos || []).map(v => {
    if (v.links) return { ...v, links: { ...v.links }, status: { ...(v.status || {}) }, views: { ...(v.views || {}) } };
    const { youtube, tiktok, ytStatus, ttStatus, ytViews, ttViews, ...rest } = v;
    return { ...rest, links: { youtube: youtube || "", tiktok: tiktok || "" }, status: { youtube: ytStatus || "Not Posted", tiktok: ttStatus || "Not Posted" }, views: { youtube: ytViews || 0, tiktok: ttViews || 0 } };
  });
  return { creators, videos };
}

export function youtubeId(url) {
  const m = String(url || "").match(/(?:shorts\/|watch\?v=|youtu\.be\/|embed\/|live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
const ytHandle = url => { const m = String(url || "").match(/youtube\.com\/(@[A-Za-z0-9._-]+)/i); return m ? m[1] : null; };
const ytChannelIdFromUrl = url => { const m = String(url || "").match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/); return m ? m[1] : null; };

/* ---------- YouTube views ---------- */
async function ytDataApi(id) {
  const j = await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${id}&key=${YT_KEY}`)).json();
  const st = j.items?.[0]?.statistics;
  if (!st?.viewCount) throw new Error(j.error?.message || "no stats");
  return { views: num(st.viewCount), likes: num(st.likeCount), source: "api" };
}
async function ytPage(id) {
  const res = await fetch(`https://www.youtube.com/watch?v=${id}&hl=en&gl=US`, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Cookie: "CONSENT=YES+1; SOCS=CAI" },
  });
  const html = await res.text();
  const views = num(pick(html, /"viewCount":"(\d+)"/));
  if (views == null) throw new Error(`no viewCount (HTTP ${res.status})`);
  return { views, likes: num(pick(html, /"likeCount":"(\d+)"/)), source: "youtube" };
}
async function ytRyd(id) {
  // Return YouTube Dislike's public API — can lag behind YouTube by a few hours.
  const r = await (await fetch(`https://returnyoutubedislikeapi.com/votes?videoId=${id}`)).json();
  if (typeof r.viewCount !== "number") throw new Error("no data");
  return { views: r.viewCount, likes: r.likes ?? null, source: "ryd" };
}
async function youtube(id) {
  const errs = [];
  for (const [name, fn] of [["api", YT_KEY ? ytDataApi : null], ["page", ytPage], ["ryd", ytRyd]]) {
    if (!fn) continue;
    try { return await fn(id); } catch (e) { errs.push(`${name}: ${e.message}`); }
  }
  throw new Error(errs.join(" | "));
}

/* ---------- TikTok views ---------- */
async function tiktok(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" }, redirect: "follow" });
  const html = await res.text();
  const views = num(pick(html, /"playCount":"?(\d+)/));
  if (views == null) throw new Error(`no playCount (HTTP ${res.status})`);
  return { views, likes: num(pick(html, /"diggCount":"?(\d+)/)), source: "tiktok" };
}

/* ---------- YouTube channel discovery ---------- */
async function resolveChannel(url, cache) {
  const direct = ytChannelIdFromUrl(url); if (direct) return direct;
  const handle = ytHandle(url); if (!handle) return null;
  if (cache[handle]) return cache[handle];
  let id = null;
  if (YT_KEY) {
    try {
      const j = await (await fetch(`https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(handle)}&key=${YT_KEY}`)).json();
      id = j.items?.[0]?.id || null;
    } catch {}
  }
  if (!id) {
    try {
      const html = await (await fetch(`https://www.youtube.com/${handle}?hl=en`, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Cookie: "CONSENT=YES+1; SOCS=CAI" } })).text();
      id = pick(html, /"externalId":"(UC[A-Za-z0-9_-]{22})"/) || pick(html, /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/) || pick(html, /"channelId":"(UC[A-Za-z0-9_-]{22})"/);
    } catch {}
  }
  if (id) cache[handle] = id;
  return id;
}
async function channelUploads(channelId) {
  const xml = await (await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`)).text();
  const out = [];
  for (const e of xml.split("<entry>").slice(1)) {
    const id = pick(e, /<yt:videoId>([^<]+)<\/yt:videoId>/);
    if (!id) continue;
    out.push({ id, title: decode(pick(e, /<title>([^<]*)<\/title>/) || ""), published: pick(e, /<published>([^<]+)<\/published>/) });
  }
  if (!out.length && !xml.includes("<feed")) throw new Error("feed unavailable");
  return out;
}

/* ---------- run ---------- */
const raw = JSON.parse(readFileSync(dataPath, "utf8"));
const data = norm(raw);
let stats = {};
try { stats = JSON.parse(readFileSync(statsPath, "utf8")); } catch {}
const prev = stats.videos || {};
const channels = stats.channels || {};
const now = Math.floor(Date.now() / 1000);
let dataChanged = false;

// 1) discovery
const knownYt = new Set(data.videos.map(v => youtubeId(v.links?.youtube)).filter(Boolean));
for (const c of data.creators) {
  const url = c.accounts?.youtube;
  if (!url) continue;
  try {
    const ch = await resolveChannel(url, channels);
    if (!ch) { console.log(`[${c.name}] couldn't find YouTube channel for ${url}`); continue; }
    const uploads = await channelUploads(ch);
    for (const u of uploads.reverse()) {
      if (knownYt.has(u.id)) continue;
      if (c.trackSince && u.published && u.published < c.trackSince) continue;
      knownYt.add(u.id);
      const status = {}, links = {}, views = {};
      for (const p of c.platforms.length ? c.platforms : ["youtube"]) { status[p] = "Not Posted"; links[p] = ""; views[p] = 0; }
      links.youtube = `https://www.youtube.com/shorts/${u.id}`; status.youtube = "Posted"; views.youtube = views.youtube || 0;
      data.videos.push({ id: "yt-" + u.id, creator: c.name, title: u.title || "Untitled", links, status, views, notes: "", addedAt: u.published || new Date().toISOString(), auto: true });
      dataChanged = true;
      console.log(`[${c.name}] new YouTube upload: ${u.title} (${u.id})`);
    }
  } catch (e) { console.log(`[${c.name}] YouTube discovery: ${e.message}`); }
  await sleep(300);
}
if (dataChanged) {
  // write back in the same (new) format, keeping anything else at top level
  writeFileSync(dataPath, JSON.stringify({ ...raw, creators: data.creators, videos: data.videos }, null, 2) + "\n");
  console.log("DATA_CHANGED");
}

// 2) views
const out = {};
for (const v of data.videos) {
  const p = prev[v.id] || {};
  const rec = { youtube: p.youtube || p.yt || null, tiktok: p.tiktok || p.tt || null, history: p.history || [] };
  const yid = youtubeId(v.links.youtube);
  if (yid) {
    try {
      const r = await youtube(yid);
      if (r.source === "ryd" && rec.youtube?.views > r.views && rec.youtube.source !== "ryd") r.views = rec.youtube.views;
      rec.youtube = { ...r, at: now };
    } catch (e) { rec.youtubeError = e.message; console.log(`[${v.id}] YouTube: ${e.message}`); }
  } else rec.youtube = null;
  if (/tiktok\.com/.test(v.links.tiktok || "")) {
    try { rec.tiktok = { ...(await tiktok(v.links.tiktok)), at: now }; }
    catch (e) { rec.tiktokError = e.message; console.log(`[${v.id}] TikTok: ${e.message}`); }
  } else rec.tiktok = null;
  const total = (rec.youtube?.views || 0) + (rec.tiktok?.views || 0);
  const last = rec.history[rec.history.length - 1];
  if (!last || now - last[0] >= 15 * 60) rec.history.push([now, rec.youtube?.views ?? null, rec.tiktok?.views ?? null]);
  if (rec.history.length > 1500) rec.history = rec.history.filter((_, i) => i % 2 === 0 || i > 1000);
  out[v.id] = rec;
  console.log(`[${v.id}] ${v.title}: YT ${rec.youtube?.views ?? "-"} (${rec.youtube?.source ?? ""}) | TT ${rec.tiktok?.views ?? "-"} | total ${total}`);
  await sleep(300);
}

writeFileSync(statsPath, JSON.stringify({ updatedAt: now, channels, videos: out }));
