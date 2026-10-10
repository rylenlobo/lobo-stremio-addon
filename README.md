# Cinejoy Stremio Addon

Serves cinejoy.pk's cracked servers (Nebula / Lisbon / Solara / Athens) as direct HTTP HLS
streams inside Stremio. No browser, no debrid.

## Run

```bash
cd ~/Desktop/cinejoy-capture/stremio-addon
node addon.js
```

## Install in Stremio

With `addon.js` running, open **Stremio → Addons → paste in the search box:**

```
http://127.0.0.1:7000/manifest.json
```

Press Install. (Desktop app accepts plain http on 127.0.0.1; Stremio Web also allows
localhost manifests.)

## Use

Open any movie or series in Stremio → the **Streams** panel shows one entry per quality, per server:

- `Cinejoy Lisbon 4K HDR` — 3840x2160 HEVC (titles with 4K sources only, sorted first)
- `Cinejoy Nebula 1080p` / `720p` — direct variant playlist URLs (audio+video muxed)
- `Cinejoy Lisbon 1080p` / `720p` / `360p` — served via the addon's `/q/<token>` mini-master
  (Lisbon splits audio into a separate HLS track, so the addon synthesizes a one-variant master
  containing the chosen video variant + the audio group)

Nebula streams are direct CDN URLs. Lisbon streams need the mini-master, which must be reachable
by your **streaming server** — default `http://host.docker.internal:7000/q/...` (Docker Stremio).
Native Stremio? Run with `ADDON_PUBLIC_HOST=127.0.0.1:7000 node addon.js`.

Cold Lisbon transcodes: fresh tokens take ~15-20s to warm; you'll see a `Cinejoy Lisbon (starting…)`
entry — play it (it buffers while warming) or reload the stream list and the per-quality links appear.
The addon warms the token in the background and shortens its cache (10s) while cold.

## How it works

1. Stremio asks `/stream/{type}/{imdbId}.json`
2. IMDb → TMDB via TMDB `/find` (cinejoy's own client-side API key, captured from their traffic)
3. Title/year taken from TMDB; then cinejoy's own resolver (their sealed `POST api.wing.st/g`
   protocol — bundled `cinejoy-core.cjs` + `crush.wasm`) is called for each server
4. Each server that carries the title returns its master.m3u8, which is passed to Stremio as
   a `stream.url` with `behaviorHints.notWebReady: true` (Stremio's streaming server plays HLS)
5. 4K streams are sorted first; `bingeGroup` is set so next-episode auto-selects the same server

Files: `addon.js` (this addon) · `cinejoy-core.cjs` (bundle of cinejoy's crypto module) ·
`crush.wasm` (their sealing wasm) · port 7000 default (`PORT=xxxx node addon.js` to change).

For research/documentation of the protocol see `../ENDPOINTS.md`.
