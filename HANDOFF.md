# Paramemo — Session Handoff

> **Purpose of this file.** A working-context handoff so a *fresh* Claude Code session on this
> repo can continue exactly where the previous session left off, with no memory of the prior chat.
> Read this top to bottom first, then read the "OPEN / PENDING WORK" section — that's what to do next.
> Last updated: 2026-08-29.

---

## 0. TL;DR — where we are right now

- The dashboard is **built, deployed, and working**. Live at **https://paramemo.tech-441.workers.dev**
  (Visit Health deal at `#visit-health`).
- All bug-fix and feature work from the last session is **committed and pushed to `main`** (Cloudflare
  auto-deploys from `main`). Latest commit at handoff: `6d78d08`.
- We just finished a long **explanation phase** (no code): explaining the Returns tab, the Comps tabs,
  data provenance, and correcting a peer-naming claim. See §6–§8.
- **Immediate next things the user wants** (see §9 for detail):
  1. **The "detailed Excel analysis" workstream** — surface the rich data that's in the uploaded
     Excel/CIM but *not yet wired* into the dashboard (opex structure, unit economics, BU-level
     revenue split, clinic ramp, fund use). Partly gated on a **client (Faraz) decision** about a
     "Full Excel breakdown" view toggle — do NOT build the toggle until the user relays Faraz's reply.
  2. **Transaction comps completion** — DONE at the prompt level ("exhaustive comps extraction",
     see §7/§9.2): the model is now told to pull EVERY named comparable/deal from the whole
     document (competitive-landscape, international-benchmark, "Acquired by X" captions, the target's own
     rounds) into `peerBenchmark`/`comps.transactions`, Indian or global, listed or unlisted. It takes
     effect on the **next fresh upload** of a deal. Per-deal valuation-comps exports remain the
     authoritative path (drop them in the "Other documents" upload slot). Trading comps already live/complete.

---

## 1. What this project is

**Paramemo** = a screening-memo dashboard for **Paragon Partners** (a PE firm; primary user contact is
**Faraz Motani**, faraz@paragonpartners.in — the deal lead whose Excel models we mirror). The user
driving this build is **tech@muns.io**.

You upload a deal's documents (Investment Memorandum / CIM PDF, an Excel financial model, banker call
notes `.eml`, optionally a transcript and valuation-comps exports). A Cloudflare Worker sends them to
Claude (on Amazon Bedrock), which returns a structured JSON memo. The Worker post-processes it
deterministically (returns math, ratios, provenance) and stores it in KV. The front-end renders a
multi-tab dashboard: Memo, Financials, **Returns**, **Comps** (Peer Benchmarking + Valuation Comps),
Deep Dive, Integrity.

The flagship live deal is **Visit Health** (a.k.a. "Budget Health" in the notes) — an Indian B2B2C
primary-care / OPD-benefits platform.

---

## 2. Deploy model & golden rules (READ BEFORE PUSHING)

- **Deploy = git push to `main`.** Cloudflare's native Git integration builds and deploys the Worker
  on every push to `main` (~30–90s). There is **no `wrangler deploy` step you run** and the deploy is
  **NOT** done by GitHub Actions. Config: `wrangler.jsonc` (entry `worker/index.js`, static assets in
  `public/`, KV namespace binding `DEALS`).
- **Work on `main`.** Despite an original task instruction naming a `claude/...` develop branch, the
  entire project history and the user's workflow are on `main` — because (a) Cloudflare deploys from
  `main`, and (b) the GitHub Actions workflow only runs from the default branch. The user has endorsed
  push-to-main. Continue on `main` unless the user says otherwise.
- **Secrets are NOT in the repo.** `GHA_SECRET`, `BEDROCK_API_KEY`, `AWS_REGION`, `BEDROCK_MODEL_IDS`,
  `WORKER_URL` live in **GitHub Actions repo secrets/vars** and the **Cloudflare Worker env**. Never
  paste secret values into committed files. (If you ever need to confirm the Worker's `GHA_SECRET`
  matches Actions', use a short-lived fingerprint endpoint — hash+length, never the value — then remove
  it; that's how a past mismatch was diagnosed.)
- **A markdown file at repo root (like this one) is deploy-safe** — it doesn't change the Worker bundle,
  so Cloudflare redeploys an identical Worker. Harmless.

---

## 3. Architecture map

**Worker** (`worker/index.js`, single file, ~1300+ lines):
- HTTP router for the API + serves `public/`.
- KV namespace `DEALS`: stores memos (`company:<id>`), the jobs map, GA job payloads (`ghajob:<jobId>`,
  TTL 3600s), Yahoo creds cache (`yahoo:creds`, TTL 1200s).
- Calls **Claude on Amazon Bedrock** (Converse API). Model fallback chain (env `BEDROCK_MODEL_IDS`):
  `anthropic.claude-sonnet-5, us.anthropic.claude-sonnet-5, us.anthropic.claude-sonnet-4-5-20250929-v1:0`.
  Bedrock **intermittently rate-limits / overloads** — this is the single biggest operational pain and
  the reason the GA path exists (below).

**Two generation modes** (toggle stored in KV; check with `GET /api/gen-mode`, set with
`POST /api/gen-mode {mode:"gha"|"worker"}` + Bearer `GHA_SECRET`):
- **`gha` (default, reliable):** the Worker fires a `repository_dispatch` (event `generate-deal`) with
  just `{jobId}`, and stashes the built prompt in KV. GitHub Actions (`.github/workflows/generate.yml`
  → `scripts/gha-generate.mjs`) fetches the prompt via `/api/gha-payload`, calls Bedrock **patiently**
  (~15 retry waves, up to ~15+ min — GH Actions has no 14-min Worker wall), and posts the raw output
  back to `/api/gha-result`, which validates + stores it exactly like an inline run. **This is how we
  beat Bedrock overload.**
- **`worker` (fallback):** the old inline path — Worker calls Bedrock directly and streams. Fast when
  Bedrock is calm; dies on overload. **"Go to fallback" = `POST /api/gen-mode {mode:"worker"}`.**
- **Deep Dive** also routes through GA when mode is `gha` (same overload reason) — a `dd_<id>_<ts>`
  job with `kind:"deepdive"`; `/api/gha-result` has a deep-dive branch that merges into
  `company:<id>.deepDive`.

**GA-mode hardening already in place** (don't regress these):
- Duplicate `repository_dispatch` of the same jobId is a **no-op** (dedupe on `ghajob:<jobId>`).
- `/api/gha-result` won't clobber a job that's already `done` (prevents a phantom "build failed").
- `scripts/gha-generate.mjs` treats a `404` on `/api/gha-payload` as **success** (a sibling run already
  consumed the one-shot payload; concurrency group `generate-${jobId}` serializes them).

**Front-end** (`public/`): `public/js/app.js` (main render + polling), plus HTML/CSS. Renders all tabs,
polls the jobs map while a generation/deep-dive is running, and does the **live comps fetch** client-side.

---

## 4. Data-source map (which dashboard element comes from where)

Five sources, each with an icon convention used in the UI:

| Icon | Source | What it feeds |
|---|---|---|
| 📊 | **Excel** (`Consolidated_IS` tab) | Financials series (revenue/EBITDA/expense rows by year), segment splits. **Numbers only.** |
| 📄 | **IM / CIM** (PDF) | Narrative, business model, the A/E/P year labels (FYxxA/E/P), FY22–24 history, market-size, management team, fund use, benchmarks. **Dashboard is heavily IM-dominated.** |
| 📧 | **Banker notes** (`.eml`) | Deal terms (ask/inbound/last round), cap table, **named private competitors**, unit economics, MCA-discrepancy flag, run-rate. |
| 🌐 | **Yahoo Finance (live)** | Listed-peer trading multiples (see §7). |
| 🧮 | **Code (deterministic)** | Ratios, CAGR, revenue-mix donut, **all returns math** (the AI does none of the returns arithmetic). |
| 🔍 | **External scan** | Integrity tab (Google/legal signals). |

Key nuance the user cares about: **the dashboard leans on the IM far more than the Excel.** The Excel
currently only feeds the raw financial series; a lot of rich Excel/CIM detail is **unused** (see §9.1).

---

## 5. Reference data — Visit Health (inlined so a fresh session has it)

> The prior session had these in `/tmp/ref_excel.txt`, `/tmp/ref_notes.txt`, `/tmp/visit_cim.txt`.
> Those are **ephemeral and won't survive** into a new container, so the essentials are copied here.
> The authoritative source is whatever the user re-uploads; treat these as context, not gospel.

**Financials (INR Cr), from CIM p.34 / Excel `Consolidated_IS`:**

| Metric | FY22A | FY23A | FY24A | FY25A | FY26E | FY27P | FY28P | FY29P | FY30P | FY31P |
|---|---|---|---|---|---|---|---|---|---|---|
| Revenue | 18 | 53 | 130 | 225 | 384 | 667 | 917 | 1288 | 1764 | 2257 |
| Direct Exp | 4 | 22 | 81 | 157 | 270 | 468 | 616 | 816 | 1066 | 1333 |
| Employee | 7 | 18 | 26 | 34 | 54 | 73 | 96 | 122 | 152 | 189 |
| Other Exp | 7 | 12 | 20 | 17 | 26 | 39 | 64 | 117 | 173 | 203 |
| EBITDA | -0.3 | 0.2 | 2.7 | 16.4 | 34.0 | 87.9 | 141.2 | 232.9 | 373.3 | 532.3 |
| EBITDA % | -2% | 0% | 2% | 7% | 9% | 13% | 15% | 18% | 21% | 24% |

(The precise Excel revenue series used in code was `[225.52,384.21,667.35,916.54,1288.27,1763.95,2257.39]`
FY25→FY31; EBITDA `[16.37,34.04,87.96,141.25,232.9,373.36,532.33]`.)

**Revenue by business unit (CIM p.35), INR Cr:** FY26E → Retail 173, Employee benefits 149, Prepolicy
medical checkup 27, Affinity & other 35 (OPD platform 384; Primary clinics 0; Total 385). FY31P →
OPD platform 1854, Primary clinics 404 (Total 2257).

**Deal terms (banker notes):** Seller **ask ≈ ₹2,000 Cr**; **inbound indication ≈ ₹1,800 Cr**; **last
round ≈ ₹440–490 Cr** (~2.5 yrs ago); total primary capital raised to date **<₹100 Cr**. Implied at ask:
**~5.2× FY26 revenue**, ~4.0× FY27E, ~33× EBITDA run-rate. Banker was explicit: **revenue-multiple
pricing is the expectation; EBITDA-multiple pricing = no deal.**

**Cap table:** ~60% investors (PolicyBazaar + Zydus family), ~40% founders + ESOP.

**Unit economics:** ~₹5,000/employee/year; network rate ~₹600/consultation; gross margin corporate ~25%,
insurer ~35–37%, **blended ~30%**; EBITDA margin FY26 ~7–10%; run-rate ₹42 Cr/mo revenue, ₹5 Cr/mo EBITDA.

**Named private competitors (banker notes §1.7):** **MediBuddy** (#1, ~₹1,000 Cr, loss-making),
**Visit/Budget Health** (#2, profitable), **Kenko/Connect** (#3), **Seeking Care** (#4, in M&A process),
**Healthy Sure** (TPA-adjacent). → These feed **Peer Benchmarking**.

**Named benchmark companies (CIM p.26, international):** **One Medical** ("Acquired by Amazon; 210+
subscription clinics"), **Optum Health** ("2,200+ insurance clinics; 4.7M people"), **CVS MinuteClinic**
("1,000+ clinics; 5M+ visits"). → Currently **NOT wired** into Transaction Comps (opportunity, §9.2).

**Market size (CIM p.30):** India healthcare $225Bn→$400Bn; primary care $100Bn→$200Bn; urban primary
$60→$100; Visit top-10-cities $25→$40 (FY25→FY30, ~12% CAGR).

---

## 6. Returns tab — how it works (and the exit-3.5× question)

The Returns model **mirrors Faraz's own Excel models** (JRG Auto / Project Bloom). **All math is in
code** (`coerceReturns` + downstream in `worker/index.js`; the AI only proposes assumptions):

- **Basis** can be `revenue`, `ebitda`, or `pat` (P/E). For Visit it's **revenue** (thin EBITDA, priced
  on revenue). The code guards against absurd multiples: an EV/EBITDA >40× auto-re-expresses on revenue.
- **Entry multiple is anchored to the real ask.** `coerceReturns` reads `transaction.valuationCr`
  (or parses "₹2,000 cr … ask" from the deal headline) and sets `entryX = ask ÷ entry-year metric`.
  For Visit: ₹2,000 Cr ÷ ₹384 Cr FY26 revenue ≈ **5.2×**. So entry = the price you'd actually pay.
- **Exit multiple (`defaults.exitX`) is the ONE illustrative assumption** — proposed by the AI under a
  prompt rule ("usually LOWER forward revenue multiple, ~2–5×"), kept as-is by code (fallback default 4×
  if missing). **Not from any document.** For Visit it landed at **3.5×**. Lower than entry = assumed
  multiple compression as the company scales. It's the lever the user is meant to argue about
  (adjustable via the exit slider on the tab).
- **Result (Visit, illustrative):** entry 5.2× / exit 3.5× revenue, FY26→FY31, revenue 5.9× → **MoIC
  ~3.6×, IRR ~29%**. Intuition: value grows ≈ revenue-growth ÷ multiple-compression = 5.9 ÷ (5.2/3.5) ≈ 3.9×.
- Three **sensitivity grids** whose entry axis adapts to the basis (`retBasis()`).

**Cross-verification checks we told the user** (to trust the tab): (1) entry EV ≈ the stated ask;
(2) entry/exit years appear verbatim in the financials; (3) exit EBITDA/revenue = management's own last
projected year, not a growth guess; (4) implied multiples sane (no 100×); (5) the sliders move MoIC/IRR
sensibly.

---

## 7. Comps tabs — trading vs transaction

**Peer Benchmarking** = the qualitative peer table (from banker-note named competitors:
MediBuddy/Kenko/Seeking Care/etc.).

**Valuation Comps** has two halves:
- **Trading comps = ✅ live & complete.** Listed-peer multiples via `GET /api/peer-multiple?ticker=X`:
  tries Munshot (fastapi.muns.io) → **Yahoo Finance** (v10 quoteSummary with a crumb+cookie handshake,
  cached in KV `yahoo:creds`; self-heals a 401 by deleting the cache) → screener.in via scrape.do.
  Yahoo returns marketCap, EV, trailingPE, EV/EBITDA, EV/Revenue, revenue, EBITDA margin. For Visit the
  listed peers are **Apollo Hospitals / Fortis / Max Healthcare** — **AI-selected public-market proxies,
  NOT named in any doc** (India has no listed pure-play OPD peer). All columns fill from live data;
  `app.js` `attachCompsLive` overwrites the model's estimates with live numbers and marks `_live=true`.
  Verified live (2026-08-29): APOLLOHOSP EV/Rev 5.08, EV/EBITDA 36.3, PE 60.9; FORTIS 7.7/36.3/66.6;
  MAXHEALTH 11.65/45.2/67.9.
- **Transaction comps = precedent M&A deals** ("acquirer paid X× for a comparable"). Two ways they fill:
  1. **From the deal's own documents (exhaustive extraction — shipped).** The prompt now scans the WHOLE
     document for every named deal/acquisition/round — competitive-landscape sections, international-
     benchmark / case-study slides, any "Acquired by X" caption, and the target's OWN prior rounds/last
     valuation — Indian or global, listed or unlisted, with honest provenance and null undisclosed
     multiples. For Visit this means One Medical/Amazon, Optum, CVS MinuteClinic (CIM p.26) + Visit's own
     ₹440–490 Cr last round now come through on a fresh upload; before this fix they were skipped because
     they weren't in a section literally headed "transactions".
  2. **From an uploaded valuation-comps export (authoritative).** A PrivateCircle / Capital IQ / VCCEdge /
     Tracxn "transaction comparables" sheet (same shape as Mitesh's `Rigid Packaging – Transactions`
     Excel), dropped in the **"Other documents"** slot of the "Add a deal" modal, is parsed directly into
     `comps.transactions`. **The client's phrase "valuation report for different companies" = exactly
     these exports.**

  **How to add reports on the dashboard:** click **"+ Add a deal"** → in the modal, under the required IM
  + Excel, use **"Other documents (optional)"** (multi-file: PDF/XLSX/CSV/images) → drop the valuation /
  transaction reports there → generate. The AI maps each export's rows into the Transaction Comps table
  (date, target, buyer, seller, type, % sought, deal value, EV/EBITDA, EV/Revenue) with an auto median
  row. To add reports to an EXISTING deal there's currently no "attach to this deal" button — you re-run
  the deal with the export attached (a fresh upload replaces the memo). Adding a one-click
  "attach & regenerate" is a candidate improvement if the user wants it.

**Provenance honesty rules baked into the prompt** (don't regress): trading multiples are labeled
"Listed peers · indicative multiples (model estimate — verify)" and never "live" in the model output
(the live overwrite happens client-side and is marked separately); transaction deals are "Publicly
reported (illustrative)" and prefer document-named peers; never fabricate a "banker notes" attribution.

---

## 8. Peer-naming — the corrected fact (user pressed on this)

Earlier in the session a loose claim ("no peer is mentioned in the docs") was **wrong and was corrected**.
Accurate position:
- **Private Indian peers ARE named** in the banker notes (MediBuddy/Kenko/Connect/Seeking Care/Healthy Sure).
- **Benchmark companies ARE named** in the CIM (One Medical/Amazon, Optum, CVS MinuteClinic) — "Acquired
  by Amazon" is itself a named transaction comp.
- **Ex-employers** appear on the CIM management slide (Ex-MediBuddy, Ex-Medi Assist).
- **Only the listed trading-comp peers (Apollo/Fortis/Max) are model-selected**, not from any doc.

---

## 9. OPEN / PENDING WORK (what to do next)

### 9.1 "Detailed Excel analysis" — surface currently-unused rich data  ← the user's main next want
The dashboard uses the Excel only for the raw financial series. A lot of high-value data sits in the
uploaded docs but is **not wired into any tab**. Candidate items to surface (Visit example):
- **Cost / opex structure** by year (Direct Expenses, Employee Benefits, Other Expenses — in the table §5).
- **Unit economics** (₹5,000/employee, ₹600/consultation, gross margins 25% / 35–37% / blended 30%,
  EBITDA run-rate ₹5 Cr/mo).
- **Revenue by business unit** (Retail / Employee benefits / Prepolicy checkup / Affinity / Clinics —
  FY26 and FY31 splits, §5).
- **City-clinic ramp** (50 clinics across Bangalore 12 / Mumbai 10 / Delhi NCR 18 / Hyderabad 5 / Pune 5).
- **Fund utilisation** (₹300 Cr: clinics + working capital + lab insourcing/intl + AI tech, CIM p.38).
- **International pilots** (Philippines HMO pilot, Indonesia; BCG supporting strategy).

**Gate:** part of this is tied to a **client decision** the user forwarded to Faraz — whether to add a
view **toggle**: *Option 1* = current "Consolidated + IM" view vs *Option 2* = a **full Excel breakdown**
view. **The user said "wait" for Faraz's reply. Do NOT build the toggle until the user relays the answer.**
Surfacing the *unused data itself* (the bullets above) can proceed if the user asks, independent of the toggle.

### 9.2 Transaction comps — completion  (prompt fix SHIPPED)
- **DONE:** exhaustive comps extraction is live in the prompt (worker) — every named comparable/deal from
  the whole document now flows into `peerBenchmark`/`comps.transactions`, Indian or global, listed or
  unlisted (competitive-landscape, international-benchmark, "Acquired by X", target's own rounds). Applies
  on the **next fresh upload**. For Visit that surfaces One Medical/Amazon, Optum, CVS MinuteClinic + the
  ₹440–490 Cr last round, alongside the banker-note peers (MediBuddy/Kenko/Seeking Care).
- **Authoritative path unchanged:** a valuation-comps export dropped in the "Other documents" upload slot
  is parsed directly into `comps.transactions` — the most reliable source for private names/deals.
- **Possible follow-up (not built):** a one-click "attach a report to an EXISTING deal & regenerate" so
  the user doesn't have to re-upload the IM+Excel to add a valuation export later.

### 9.3 Screener-via-Playwright scraper — only if needed
The user offered Screener.in login creds (to add as GitHub Actions secrets) for a Playwright scrape.
**Currently unnecessary** — Yahoo fills every listed-peer column. Build this only if a future deal needs
a ticker Yahoo doesn't carry. (Chromium is pre-installed in the env; `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`;
do not run `playwright install`.)

---

## 10. Key code locations (fast navigation)

- **`worker/index.js`**
  - `coerceReturns(o)` — returns model: basis, entry-anchored-to-ask, exit illustrative, >40× guard. (~line 1156)
  - `normalizeCompany` / `ensureDerivedFinancials(fin)` — fills only-when-missing ratios/CAGR/revenueMix.
  - `handleGenerate` — GA dispatch branch + dedupe.
  - `handleGhaResult` — validates/stores model output; has the **deepdive** branch + don't-clobber-done guard.
  - `handleDeepDive` — routes deep dive through GA when mode is `gha`.
  - `handlePeerMultiple` / `yahooCreds(env)` / `peerViaYahoo(ticker,env)` — live trading comps.
  - The big **prompt** (system/user) — comps provenance rules, year-span rule, deal-terms rule, returns
    basis guidance. Search for `RETURNS (ALWAYS include` (~line 512) and the provenance/PROVENANCE rules.
- **`public/js/app.js`**
  - `personName(p)` / `personAvatar(s)` — role-as-identity when a slide gives no personal name.
  - `renderManagement` / `renderPromoters` / `renderMemoExact` — people rendering.
  - `attachCompsLive` — client-side live comps fetch + overwrite of listed-peer columns.
  - `startDeepDive` / `reconcileJobsFromServer` / `ensureJobPolling` — deep-dive + job polling (GA-aware).
- **`scripts/gha-generate.mjs`** — the GitHub Actions runner (patient Bedrock retries, 404-exit-clean).
- **`.github/workflows/generate.yml`** — the `generate-deal` workflow (concurrency `generate-${jobId}`).
- **`wrangler.jsonc`** — Worker + assets + `DEALS` KV binding.

---

## 11. Gotchas / operational notes

- **Bedrock overload is normal.** If inline generation 502s, that's why GA mode is the default. Don't
  "fix" it by removing GA.
- **Yahoo 401 "Invalid Crumb"** self-heals (cache is deleted and re-handshaked). If comps go blank,
  check `/api/peer-multiple?ticker=APOLLOHOSP` directly.
- **scrape.do** has a monthly request cap (has hit "limit exceeded") — it's the last-resort comps source,
  Yahoo is primary.
- **Don't paste secret values** into any committed file. Verify `GHA_SECRET` match via a temporary
  fingerprint (hash+length) endpoint if ever needed, then remove it.
- **Deploy latency** ~30–90s after push; a "build failed" banner in the UI in the past was a phantom from
  duplicate GA dispatch (now fixed) — verify against the actual GitHub Actions run before believing it.

---

## 12. Commit history this session (all on `main`)

`36c6e25` GA mode · `383979f` fingerprint diag · `17d5a29` role-as-identity ·
`dbfd6ad` extraction/formatting bug batch · `6675b76` year-span · `51bf569` returns revenue basis+guard ·
`b66f813` anchor entry to ask · `fa0c0fc` anchor from headline · `9274fef` derive ratios/CAGR/mix ·
`c00e5f1` GHA duplicate-dispatch harmless · `1dc749f` deep-dive via GA · `6d78d08` Yahoo live comps.
