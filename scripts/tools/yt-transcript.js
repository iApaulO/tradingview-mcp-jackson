#!/usr/bin/env node
// YouTube transcript fetcher — via Apify, using the APIFY_TOKEN already in .env.
//
// WHY APIFY AND NOT yt-dlp. A yt-dlp version of this was written first and immediately hit YouTube's
// bot check: HTTP 429 plus "Sign in to confirm you're not a bot". The documented workaround is
// `--cookies-from-browser`, which reads the local browser's YouTube session cookies. Apify's actors
// run server-side behind their own proxy pool, so there is no bot check to defeat and NOTHING TOUCHES
// THE LOCAL BROWSER SESSION. Better on both reliability and blast radius.
//
// Actor: pintostudio/youtube-transcript-scraper (~5.08M runs). Returns { data: [{start, dur, text}] }.
// Runs consume Apify compute credits; the account is on the FREE plan, so they are metered.
//
// Usage:
//   node scripts/tools/yt-transcript.js <url-or-id>                 plain prose to stdout
//   node scripts/tools/yt-transcript.js <url-or-id> --timestamps    [mm:ss] prefixed lines
//   node scripts/tools/yt-transcript.js <url-or-id> --out=file.txt  write to a file
//   node scripts/tools/yt-transcript.js <url-or-id> --json          raw segments as JSON
//   node scripts/tools/yt-transcript.js <url-or-id> --actor=user~name   use a different actor
//
// Transcripts are the creator's content: fine for private study, analysis and citation, not for
// republication. When a transcript is used as evidence for a claim, cite the TIMESTAMP so the claim
// can be checked at source — the same discipline the significance register applies to everything else.

import { readFileSync, writeFileSync, existsSync } from "fs";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
if (!target) {
  console.error("usage: node scripts/tools/yt-transcript.js <url-or-id> [--timestamps] [--out=file] [--json] [--actor=user~name]");
  process.exit(1);
}
const opt = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.split("=").slice(1).join("=") : d; };
const WANT_TS = args.includes("--timestamps");
const WANT_JSON = args.includes("--json");
const OUT = opt("out", null);
const ACTOR = opt("actor", "pintostudio~youtube-transcript-scraper");

// token from the environment, else from .env (which is gitignored)
let token = process.env.APIFY_TOKEN;
if (!token) {
  for (const p of [".env", new URL("../../.env", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")]) {
    try {
      if (existsSync(p)) {
        const m = readFileSync(p, "utf8").match(/APIFY_TOKEN\s*=\s*(.+)/);
        if (m) { token = m[1].trim(); break; }
      }
    } catch { /* try the next location */ }
  }
}
if (!token) { console.error("APIFY_TOKEN not found in environment or .env"); process.exit(1); }

const url = /^https?:\/\//.test(target) ? target : `https://www.youtube.com/watch?v=${target}`;

const res = await fetch(`https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${token}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ videoUrl: url }),
});
if (!res.ok) {
  console.error(`Apify returned ${res.status}.${res.status === 402 ? " Free-plan compute credits may be exhausted." : ""}`);
  console.error((await res.text()).slice(0, 400));
  process.exit(2);
}

const payload = await res.json();
const items = Array.isArray(payload) ? payload : (payload?.items ?? [payload]);
const segs = items[0]?.data ?? items[0]?.transcript ?? (Array.isArray(items[0]) ? items[0] : null);

if (!segs || !segs.length) {
  console.error("No transcript returned — the video may have captions disabled, or be private/age-gated.");
  console.error(JSON.stringify(items[0] ?? {}, null, 1).slice(0, 400));
  process.exit(3);
}

const norm = segs
  .map((s) => ({ t: Number(s.start ?? s.offset ?? 0), text: String(s.text ?? "").replace(/\s+/g, " ").trim() }))
  .filter((s) => s.text);

const mmss = (sec) => {
  const x = Math.max(0, Math.floor(sec));
  const h = Math.floor(x / 3600), m = Math.floor((x % 3600) / 60), s = x % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s).padStart(2, "0")}`;
};

const header =
  `SOURCE:   ${url}\n` +
  `ACTOR:    ${ACTOR}\n` +
  `SEGMENTS: ${norm.length}\n` +
  `FETCHED:  ${new Date().toISOString()}\n\n`;

let body;
if (WANT_JSON) body = JSON.stringify(norm, null, 1);
else if (WANT_TS) body = norm.map((s) => `[${mmss(s.t)}] ${s.text}`).join("\n");
else body = norm.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();

if (OUT) {
  writeFileSync(OUT, WANT_JSON ? body : header + body, "utf8");
  console.error(`wrote ${OUT} — ${norm.length} segments, ${body.length} chars`);
} else {
  process.stdout.write((WANT_JSON ? "" : header) + body + "\n");
}
