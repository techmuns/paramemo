# Paragon Partners — Screening Memo

A visual **screening-memo dashboard** for Paragon Partners. Partners upload a
company's Information Memorandum (PDF) and Excel financial model; the app reads
them, uses Claude to auto-build a colourful, plain-language memo across seven
tabs (Snapshot · Financials · Fit · Integrity · Questions · Thesis · Returns),
and lets a partner export a 2-page PDF to email — all read over the weekend
before Monday's pipeline meeting.

It's a **Cloudflare Worker static site** with a tiny API. No build step: plain
HTML + JS, Tailwind + Chart.js from CDN.

```
public/
  index.html            the app (single page) + all styles, incl. the print memo
  js/app.js             all app logic (pipeline, company tabs, upload, PDF export)
  data/companies.json   the 3 seeded deals — always available, offline
worker/
  index.js              serves the site + POST /api/generate, GET /api/companies
wrangler.jsonc          Cloudflare config (assets, KV binding, vars)
package.json            dev / deploy scripts
```

- **Seed data** (the 3 real deals) is bundled and works with no backend.
- **Uploaded deals** are read in the browser (pdf.js + SheetJS), the extracted
  **text** (never the raw files) is sent to your firm's own AI in the Worker,
  and the resulting memo is stored in Cloudflare **KV** so it persists for
  everyone.

---

## Run locally

```bash
npm install          # installs wrangler (dev dependency)
npm run dev          # wrangler dev → http://localhost:8787
```

Seed deals work immediately. **Uploading** a new deal needs the AI configured
(next section); without it, `/api/generate` returns a friendly "AI is not
configured" message and the 3 seeds keep working.

---

## Setup (one-time, in Cloudflare) — copy-paste

You need three things: a **KV namespace** (to store uploaded deals), one
**secret** (your Bedrock API key), and two **vars** (region + model). Run these
from the project folder.

### 1 · Create the KV namespace and paste its id

```bash
npx wrangler kv namespace create DEALS
```

It prints an `id`. Open **`wrangler.jsonc`** and paste it in place of
`<PASTE_YOUR_KV_NAMESPACE_ID>`:

```jsonc
"kv_namespaces": [
  { "binding": "DEALS", "id": "the-id-it-printed" }
]
```

### 2 · Set the AI region and model (already in `wrangler.jsonc`, edit if needed)

```jsonc
"vars": {
  "AWS_REGION": "us-east-1",
  "BEDROCK_MODEL_ID": "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
}
```

- **`AWS_REGION`** — the AWS region where you use Amazon Bedrock.
- **`BEDROCK_MODEL_ID`** — a Claude model **or (recommended) a cross-region
  inference-profile id** that is *enabled in your Bedrock account*. Find it in
  the Bedrock console → Model access / Inference profiles. It usually looks like
  `us.anthropic.claude-...-v1:0`. Replace the default with yours.

### 3 · Add the secret (NOT committed — stored encrypted in Cloudflare)

```bash
npx wrangler secret put BEDROCK_API_KEY
# paste your Amazon Bedrock API key when prompted
```

> **BEDROCK_API_KEY** is an [Amazon Bedrock API key](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html)
> (Bedrock → API keys). The Worker calls Bedrock's Messages API with
> `Authorization: Bearer <that key>` — no AWS SDK, no SigV4 signing.

**Optional OCR fallback** — only used when a PDF is a *scanned image* (no
selectable text). If you set this, the Worker OCRs such PDFs via Mistral; if you
don't, scanned PDFs just prompt the partner to paste the key details.

```bash
npx wrangler secret put MISTRAL_API_KEY   # optional
```

### 4 · Deploy

```bash
npm run deploy       # wrangler deploy
```

That's it. Open the deployed URL, click **+ Add a deal**, upload an IM + Excel
model, and the memo builds in about a minute.

---

## What happens when you upload (end to end)

1. **Browser** reads the IM (pdf.js) and Excel model (SheetJS) locally, picks
   the best financial sheet(s) as CSV, and POSTs only **text** to
   `/api/generate` (plus any name/sector/banker/ask you typed).
2. **Worker** sends that text to **Claude on Amazon Bedrock** with the seed
   `kusumgar` entry as the exact schema, gets back one JSON object, **validates**
   it (re-asks once if malformed), assigns a unique `id` (never overwriting a
   seed), and stores it in **KV**.
3. The new deal appears in the pipeline and its memo opens. It persists for
   everyone via `GET /api/companies`.

**Export PDF** (in a company view) builds a print-optimised 2-page memo and opens
your browser's print dialog — choose *Save as PDF* to email it.

---

## Privacy & security

- Uploaded content goes **only** to your firm's own Amazon Bedrock (and Mistral,
  only if you enabled the OCR fallback) — nowhere else.
- **Secrets never reach the browser.** All AI calls happen in the Worker; the
  browser only ever sends extracted text to your own `/api/generate`.
- The Worker **validates and parses** every AI response before storing or
  rendering it, and never overwrites the 3 seeded deals.
- `BEDROCK_API_KEY` / `MISTRAL_API_KEY` are Cloudflare secrets and are **not** in
  this repository. `node_modules`, `.wrangler`, and `.dev.vars` are git-ignored.

---

## Tech

Cloudflare Workers (static assets + KV) · Tailwind (CDN) · Chart.js (CDN) ·
pdf.js + SheetJS (CDN, lazy-loaded on upload) · Inter + Sora fonts. No bundler.
