// LOBO — Stremio addon for cinejoy.pk servers: one stream per quality per server
// Local:  node addon.js          → install http://127.0.0.1:7000/manifest.json
// Render: set nothing (PORT auto) → install https://<app>.onrender.com/manifest.json
//
// - H.264 variants play DIRECTLY from the CDN (no proxy) — CDNs send CORS:*
// - HEVC/4K variants route through the Stremio streaming server (notWebReady)
// - Lisbon re-resolves a FRESH token at play time via /q/
// - /health is a keep-alive endpoint: ping it every <10 min to keep free Render awake
const path = require("path");
const fs = require("fs");
const express = require("express");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");

const HERE = __dirname;
const wasmBytes = fs.readFileSync(path.join(HERE, "crush.wasm"));
const realFetch = globalThis.fetch;
const M = require(path.join(HERE, "cinejoy-core.cjs")).exportsMap;

const PORT = process.env.PORT || 7000;
const TMDB_KEY = "8476a7ab80ad76f0936744df0430e67c";
const SERVERS = ["Nebula", "Lisbon", "Solara", "Athens"];
// set ADDON_BASE to override the auto-detected host used in /q/ URLs (rarely needed)
const ADDON_BASE = process.env.ADDON_BASE || null;

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("crush.wasm")) return new Response(wasmBytes, { status: 200 });
  if (u.includes("flagsapi")) return new Response("", { status: 200 });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try { return await realFetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
};

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

// ---- TMDB (imdb → tmdb/title/year), 10-min memo ----
const tmdbCache = new Map();
async function tmdbFind(imdbId) {
  if (tmdbCache.has(imdbId)) return tmdbCache.get(imdbId);
  const r = await realFetch(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id`);
  const j = await r.json();
  const movie = j.movie_results && j.movie_results[0];
  const tv = j.tv_results && j.tv_results[0];
  let meta = null;
  if (movie) meta = { type: "movie", tmdb: String(movie.id), title: movie.title, year: (movie.release_date || "").slice(0, 4) };
  else if (tv) meta = { type: "series", tmdb: String(tv.id), title: tv.name, year: (tv.first_air_date || "").slice(0, 4) };
  if (meta) tmdbCache.set(imdbId, meta);
  return meta;
}

async function resolveServer(server, meta, season, episode) {
  const r = meta.type === "movie"
    ? await M.k(server, meta.tmdb, meta.imdb, meta.year, meta.title)
    : await M.l(server, meta.tmdb, season, episode, meta.imdb, meta.year, meta.title);
  const playlists = (r && r.stream || []).map(s => s.playlist).filter(Boolean);
  if (!playlists.length) throw new Error("no playlist");
  return playlists[0];
}

function absUrl(uri, baseUrl) {
  if (/^https?:\/\//.test(uri)) return uri;
  return new URL(uri, baseUrl).toString();
}

async function fetchMaster(url, attempts) {
  const n = attempts || 4;
  for (let i = 0; i < n; i++) {
    try {
      const resp = await realFetch(url);
      if (resp.status === 200) return await resp.text();
    } catch (e) { /* retry */ }
    if (i < n - 1) await new Promise(s => setTimeout(s, 5000));
  }
  return null;
}

function warmInBackground(url) {
  (async () => {
    for (let i = 0; i < 8; i++) {
      try {
        const resp = await realFetch(url);
        if (resp.status === 200) return;
      } catch (e) {}
      await new Promise(s => setTimeout(s, 7000));
    }
  })().catch(() => {});
}

function parseMaster(body, masterUrl) {
  const lines = body.split("\n").map(l => l.trim()).filter(Boolean);
  const variants = [];
  let audioUri = null, pending = null;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-MEDIA:") && /TYPE=AUDIO/.test(line)) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) audioUri = absUrl(m[1], masterUrl);
    } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pending = line;
    } else if (pending && !line.startsWith("#")) {
      const resM = pending.match(/RESOLUTION=(\d+x\d+)/);
      const bwM = pending.match(/BANDWIDTH=(\d+)/);
      variants.push({
        uri: absUrl(line, masterUrl),
        resolution: resM ? resM[1] : null,
        bandwidth: bwM ? parseInt(bwM[1], 10) : 0,
        streamInf: pending,
        hevc: /hvc1|hevc/i.test(pending),
      });
      pending = null;
    }
  }
  return { variants, audioUri };
}

function qualityLabel(resolution) {
  if (!resolution) return "auto";
  const h = parseInt(resolution.split("x")[1], 10);
  if (h >= 2000) return "4K HDR";
  if (h >= 1080) return "1080p";
  if (h >= 720) return "720p";
  if (h >= 360) return "360p";
  return resolution;
}

const encodeToken = o => Buffer.from(JSON.stringify(o)).toString("base64url");
const decodeToken = t => JSON.parse(Buffer.from(t, "base64url").toString("utf8"));

const app = express();
const builder = new addonBuilder({
  id: "org.lobo.cinejoy",
  version: "1.3.0",
  name: "LOBO",
  description: "Cinejoy servers — per-quality HLS, direct play, fresh tokens at play time",
  logo: `http://127.0.0.1:${PORT}/logo.jpg`,
  resources: ["stream"],
  types: ["movie", "series"],
  catalogs: [],
  idPrefixes: ["tt"],
});

// remember the host each request came in on, so /q/ URLs point back to a host
// the current caller (browser or streaming server) can actually reach
let reqHost = process.env.ADDON_BASE ? process.env.ADDON_BASE.replace(/^https?:\/\//, "") : null;
app.use((req, res, next) => { if (req.headers.host) reqHost = req.headers.host; next(); });
const qUrl = token => `http://${reqHost || `127.0.0.1:${PORT}`}/q/${token}`;

builder.defineStreamHandler(async (args) => {
  const parts = String(args.id).split(":");
  const imdbId = parts[0];
  const season = parts[1] || "1";
  const episode = parts[2] || "1";
  if (!imdbId.startsWith("tt")) return { streams: [], cacheMaxAge: 3600 };

  let meta = await tmdbFind(imdbId);
  if (!meta) return { streams: [], cacheMaxAge: 3600 };
  meta.imdb = imdbId;
  if (args.type === "movie" && meta.type !== "movie") return { streams: [], cacheMaxAge: 3600 };
  if (args.type === "series" && meta.type !== "series") return { streams: [], cacheMaxAge: 3600 };

  const results = await Promise.allSettled(
    SERVERS.map(s => withTimeout(resolveServer(s, meta, season, episode), 14000).then(pl => ({ server: s, master: pl })))
  );

  const streams = [];
  const seen = new Set();
  let anyCold = false;
  for (const r of results) {
    if (r.status !== "fulfilled" || !r.value) continue;
    const { server, master } = r.value;
    const body = await withTimeout(fetchMaster(master), 45000).catch(() => null);
    if (!body) {
      // cold transcode (Lisbon): keep it proxied so the streaming server retries while warming
      anyCold = true;
      warmInBackground(master);
      const key = `${server}-master`;
      if (!seen.has(key)) {
        seen.add(key);
        streams.push({
          name: `LOBO ${server} (starting…)`,
          description: `${meta.title} (${meta.year}) — transcode warming up; play it, or reload the stream list in ~15s for per-quality links`,
          url: master,
          behaviorHints: { notWebReady: true, bingeGroup: `lobo-${server}-master` },
        });
      }
      continue;
    }
    const { variants, audioUri } = parseMaster(body, master);
    for (const v of variants.sort((a, b) => b.bandwidth - a.bandwidth)) {
      const label = qualityLabel(v.resolution);
      const key = `${server}-${v.resolution || v.uri}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // direct play whenever the browser/mpv can decode it; only HEVC needs the streaming server
      const direct = !v.hevc;
      let url;
      if (!audioUri) {
        url = v.uri;                       // muxed server (Nebula): CDN URL directly
      } else {
        // split-audio server (Lisbon): mini-master via addon, FRESH token at play time
        url = qUrl(encodeToken({ i: imdbId, s: server, q: v.resolution, se: season, ep: episode, ty: meta.type }));
      }
      const hints = { bingeGroup: `lobo-${server}-${label}` };
      if (!direct) hints.notWebReady = true;
      streams.push({
        name: `LOBO ${server} ${label}`,
        description: `${meta.title} (${meta.year}) — ${label}${direct ? " (direct)" : " (via streaming server)"}${audioUri ? ", fresh token" : ""}`,
        url,
        behaviorHints: hints,
      });
    }
    if (!variants.length && !seen.has(`${server}-master`)) {
      seen.add(`${server}-master`);
      streams.push({
        name: `LOBO ${server}`,
        description: `${meta.title} (${meta.year}) — single playlist`,
        url: master,
        behaviorHints: { notWebReady: true, bingeGroup: `lobo-${server}-master` },
      });
    }
  }

  streams.sort((a, b) => (b.name.includes("4K") ? 1 : 0) - (a.name.includes("4K") ? 1 : 0));
  return { streams, cacheMaxAge: anyCold ? 10 : 300 };
});

// play-time proxy for split-audio servers (Lisbon): fresh resolve → fresh token → mini-master.
// CORS-open so browsers can direct-play the mini-master; warms cold transcodes with retries.
app.get("/q/:token", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*").set("Cache-Control", "no-store");
  try {
    const t = decodeToken(req.params.token);
    const meta = await tmdbFind(t.i);
    if (!meta) return res.status(404).end();
    meta.imdb = t.i;
    const master = await resolveServer(t.s, meta, t.se, t.ep);
    const body = await fetchMaster(master, 6);
    if (!body) return res.status(503).send("transcode not ready yet — retry");
    const { variants, audioUri } = parseMaster(body, master);
    if (!variants.length) return res.status(502).send("no variants");
    const wantH = t.q ? parseInt(t.q.split("x")[1], 10) : 0;
    const want = variants.find(v => v.resolution === t.q)
      || variants.slice().sort((a, b) => Math.abs(parseInt((a.resolution || "0x0").split("x")[1], 10) - wantH) - Math.abs(parseInt((b.resolution || "0x0").split("x")[1], 10) - wantH))[0]
      || variants[0];
    if (!audioUri) return res.redirect(302, want.uri);
    const pl = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="${audioUri}"`,
      want.streamInf,
      want.uri,
      "",
    ].join("\n");
    res.set("Content-Type", "application/vnd.apple.mpegurl").send(pl);
  } catch (e) {
    res.status(502).send("resolve failed: " + e.message);
  }
});

// keep-alive / health endpoint — ping this every <10 min to keep free Render awake
app.get("/health", (req, res) => res.set("Access-Control-Allow-Origin", "*").json({ ok: true, uptime: process.uptime(), ts: Date.now() }));

app.get("/logo.jpg", (req, res) => res.sendFile(path.join(HERE, "logo.jpg")));

app.use("/", getRouter(builder.getInterface()));
app.listen(PORT, "0.0.0.0", () => {
  console.log(`LOBO addon on 0.0.0.0:${PORT}`);
  console.log(`  install: http://127.0.0.1:${PORT}/manifest.json  (or your public URL)`);
  console.log(`  keep-alive: GET /health`);
});
