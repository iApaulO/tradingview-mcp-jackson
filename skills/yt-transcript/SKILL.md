---
name: yt-transcript
description: >-
  Fetch YouTube video transcripts via Apify, as plain prose, timestamped lines, or raw JSON segments.
  Use whenever a YouTube video needs to be read, quoted, searched, or cited — trading education,
  interviews, conference talks, tutorials — or when a claim made in a video needs checking against
  data. Handles the bot-detection that blocks yt-dlp, and never touches the local browser session.
---

# YouTube transcripts

## Run it

```bash
node scripts/tools/yt-transcript.js <url-or-id>                  # plain prose
node scripts/tools/yt-transcript.js <url-or-id> --timestamps     # [mm:ss] per line
node scripts/tools/yt-transcript.js <url-or-id> --out=file.txt   # write to a file
node scripts/tools/yt-transcript.js <url-or-id> --json           # raw {t, text} segments
node scripts/tools/yt-transcript.js <url-or-id> --actor=user~name  # different Apify actor
```

Accepts a full URL or a bare video ID. Output carries a header with source URL, actor, segment count
and fetch time, so a saved transcript stays self-identifying.

## How it works, and why not yt-dlp

Apify actor **`pintostudio/youtube-transcript-scraper`** (~5.08M runs), authenticated with
`APIFY_TOKEN` from `.env` (gitignored) or the environment.

A yt-dlp version was built first and **failed immediately**: YouTube returned HTTP 429 and
*"Sign in to confirm you're not a bot."* The documented fix is `--cookies-from-browser`, which reads
the local browser's YouTube session cookies. Apify runs server-side behind its own proxy pool — no
bot check to defeat, and **nothing touches the local browser session.** Better on reliability and on
blast radius.

`yt-dlp` is still installed and is the fallback if Apify credits run out, but it will need cookies.

## Which mode to use

| mode | use when |
|---|---|
| plain | reading, summarising, feeding to analysis |
| `--timestamps` | **anything that will be cited** — the timestamp is the citation |
| `--json` | programmatic use; segments as `{t: seconds, text}` |

**Default to `--timestamps` for research.** A claim from a video is only checkable if you can say
where in the video it was made.

## Cost and failure modes

Runs consume Apify compute credits. The account is on the **FREE plan**, so they are metered — this
is not a free-forever firehose, and bulk jobs should be deliberate.

| exit | meaning |
|---|---|
| 2 | Apify HTTP error; 402 means free-plan credits exhausted |
| 3 | no transcript — captions disabled, or private/age-gated video |

Auto-generated (ASR) captions come back unpunctuated with run-on casing, and **mis-hear jargon** —
ticker symbols and indicator names are the usual casualties. Read a transcript as a lossy record of
speech, not as a document the speaker wrote.

## Using a transcript as evidence

Transcripts are the creator's content. Fine for private study, analysis, quoting and citation; not
for republication.

**If a video's claim is going to be tested, cite it with its timestamp and treat it as a
HYPOTHESIS, not a finding.** A confident presenter is not evidence, and video content is exactly
where the data-snooping failures in `market-microstructure-foundations` (Module 6) originate — rules
selected after the fact, presented without the variants that failed. The register's standards apply
unchanged: a claim from a video enters as an untested hypothesis and earns its status the same way
everything else does.
