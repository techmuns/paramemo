# Paramemo — Session Handoff

> **Purpose of this file.** A working-context handoff so a *fresh* Claude Code session on this
> repo can continue exactly where the previous session left off, with no memory of the prior chat.
> Read this top to bottom first, then read the "OPEN / PENDING WORK" section — that's what to do next.
> Last updated: 2026-08-31.
>
> **Keep this file current.** Whatever we build or change, update this handoff in the SAME change (the
> TL;DR, the pending-work section, the code-locations map, and the commit list). A stale handoff is
> worse than none — it once told a fresh session that already-shipped work was still "pending". Treat
> updating it as part of finishing any piece of work, not an afterthought.

---

## 0. TL;DR — where we are right now

- The dashboard is **built, deployed, and working**. Live at **https://paramemo.tech-441.workers.dev**
  (Visit Health deal at `#visit-health`).
- Everything below is **merged to `main` and live** (Cloudflare auto-deploys from `main`). Latest
  commit: `6982927` (PR #9). The pipeline is nine merged PRs (#1–#9) — see §12.
- **The dashboard now has 11 tabs**: Snapshot · Deep Dive · Financials · **Excel Analysis** · Fit ·
  Integrity · Questions · Thesis · Comps · Returns · **Audit**. The last two of these (Excel Analysis,
  Audit) were built AFTER this handoff was first written — an earlier version of this file wrongly still
  listed Excel Analysis as "pending", which is the whole reason for the "keep this current" rule above.
- **Recently shipped** (see §9 for detail):
  1. **Excel Analysis tab** (PR #1/#3/#7) — a second AI pass reads the whole Excel model and turns it
     into charts (revenue/cost trends, margins, segment splits, unit economics, ramps). Generic: whatever
     the model breaks out becomes the visuals. This IS the "detailed Excel analysis" workstream — DONE.
  2. **PR #9** (`6982927`) — three things: (a) auto-derive **Return on Equity** when the model leaves it
     blank but PAT ÷ net worth is computable (per-cell, additive); (b) **combine Deep Dive + Excel
     Analysis into ONE GitHub-Actions run** (`/api/insights`, two steps, one runner spin-up) with a clean
     fallback to the two separate passes; (c) a new on-demand **Audit tab** — a "Run audit" button that
     re-reads the memo AND the source documents and lists every difference (wrong / missing / unsupported
     / assumption / verified) with a suggested fix. Audit **reports only — it never edits the deal**.
  3. **Exhaustive comps extraction** (prompt-level, §7/§9.2) — the model pulls EVERY named comparable /
     deal from the whole document into `peerBenchmark` / `comps.transactions`. Takes effect on a fresh
     upload; valuation-comps exports in the "Other documents" slot remain the authoritative path.
- **Still pending:** nothing on the dev side. Only (a) the **"Full Excel breakdown" view TOGGLE**, still
  gated on a **client (Faraz) decision** — do NOT build it until the user relays his answer; and (b) a few
  **optional** deferred follow-ups from PR #9's review (see §9.4). Trading comps are already live/complete.

---

## 1. What this project is

**Paramemo** = a screening-memo dashboard for **Paragon Partners** (a PE firm; primary user contact is
**Faraz Motani**, faraz@paragonpartners.in — the deal lead whose Excel models we mirror). The user
driving this build is **tech@muns.io**.

You upload a deal's documents (Investment Memorandum / CIM PDF, an Excel financial model, banker call
notes `.eml`, optionally a transcript and valuation-comps exports). A Cloudflare Worker sends them to
Claude (on Amazon Bedrock), which returns a structured JSON memo. The Worker post-processes it
deterministically (returns math, ratios, provenance) and stores it in KV. The front-end renders a
multi-tab dashboard: Snapshot, Deep Dive, Financials, **Excel Analysis**, Fit, Integrity, Questions,
Thesis, **Comps** (Peer Benchmarking + Valuation Comps), **Returns**, and **Audit**.

The flagship live deal is **Visit Health** (a.k.a. "Budget Health" in the notes) — an Indian B2B2C
primary-care / OPD-benefits platform.

---

## 2. Deploy model & golden rules (READ BEFORE PUSHING)

- **Deploy = git push to `main`.** Cloudflare's native Git integration builds and deploys the Worker
  on every push to `main` (~30–90s). There is **no `wrangler deploy` step you run** and the deploy is
  **NOT** done by GitHub Actions. Config: `wrangler.jsonc` (entry `worker/index.js`, static assets in
  `public/`, KV namespace binding `DEALS`).
- **How changes reach `main` (current workflow — this changed).** Early work was pushed straight to
  `main`; the recent workstream (PRs #1–#9) uses a **feature branch → PR → squash-merge to `main`**
  flow, which triggers the Cloudflare deploy on merge and lets an automated reviewer (Codex) comment
  first. Cloudflare also builds a **preview URL per PR**. The GitHub Actions *generation* workflow
  (`generate.yml`) still only runs from the default branch, and `repository_dispatch` always runs
  `main`'s runner — so a Worker change and its runner change must land together at merge. Match whatever
  branch the user points you at; if none is given, a PR into `main` is the safe default.
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
- **Second-pass "insights" also route through GA** when mode is `gha` (same overload reason). There are
  **three** of them, each its own focused Bedrock call, merged additively onto the stored deal (a failure
  never flips the deal to "error" — the client can retry):
  - **Deep Dive** (`POST /api/deepdive`, job `dd_<id>_<ts>`, `kind:"deepdive"`) → `company:<id>.deepDive`.
  - **Excel Analysis** (`POST /api/excel-analysis`, job `xa_<id>_<ts>`, `kind:"excel"`) → `company:<id>.excelAnalysis`.
  - **Audit** (`POST /api/audit`, job `au_<id>_<ts>`, `kind:"audit"`) → its OWN key `audit:<id>` (so an
    audit write never clobbers a Deep Dive / Excel write racing it); `GET /api/companies` merges it back
    onto the deal as `c.audit`. Audit is **on-demand** (a "Run audit" button), never automatic.
  - **PR #9 combined Deep Dive + Excel into ONE GA run** (`/api/insights`, a `steps[]` payload the runner
    loops) so a fresh build does one runner spin-up instead of two; the client falls straight back to the
    two separate passes whenever the server can't combine. `/api/gha-result` has a branch per `kind`.
- **`/api/regenerate`** rebuilds an existing deal in place (same id) from its stored source text plus a new
  report — used by the Comps-tab "Add report" button. It preserves the existing Deep Dive / Excel Analysis
  and deletes any now-stale `audit:<id>`.

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

  **How to add reports on the dashboard — two ways:**
  1. **New deal:** click **"+ Add a deal"** → under the required IM + Excel use **"Other documents
     (optional)"** (multi-file: PDF/XLSX/CSV/images) → drop the valuation / transaction reports → generate.
  2. **Existing deal (SHIPPED):** open the deal → **Comps tab** → **"Add report"** button (also in the
     Comps action bar). Drop a valuation-comps / Private Circle export (or updated deck) and the memo
     **rebuilds in place** — no need to re-upload the IM + Excel. See §10a for how it works.

  Either way the AI maps each export's rows into the Transaction Comps table (date, target, buyer, seller,
  type, % sought, deal value, EV/EBITDA, EV/Revenue) with an auto median row.

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

### 9.1 "Detailed Excel analysis" — SHIPPED as the Excel Analysis tab
This WAS the user's main next want; it is now **DONE**. The **Excel Analysis tab** (PR #1, refined in
#3/#7, combined into one GA run in #9) is a second AI pass that reads the whole Excel model and turns
whatever it breaks out — cost/opex structure, unit economics, revenue by segment/BU, capacity/ramp,
cash flow, assumptions — into charts (trend / bars / donut / kpis / table). It's **generic**: sections
are decided per-model from the sheet's own rows, using the SAME typed-block renderer as the Deep Dive.
Code: `handleExcelAnalysis` (worker) + `renderExcelAnalysis` (app.js). So the "surface currently-unused
rich Excel data" goal is met by this tab — no separate wiring needed.

**Still gated (the ONE open item here):** a **client decision** the user forwarded to Faraz — whether to
add a view **TOGGLE**: *Option 1* = current "Consolidated + IM" view vs *Option 2* = a **full Excel
breakdown** view. **The user said "wait" for Faraz's reply. Do NOT build the toggle until the user relays
the answer.** The Excel Analysis tab already surfaces the breakdown data; the toggle is about how the
*core Financials tab* presents consolidated-vs-full, which is what needs Faraz's call.

### 9.2 Transaction comps — completion  (prompt fix SHIPPED)
- **DONE:** exhaustive comps extraction is live in the prompt (worker) — every named comparable/deal from
  the whole document now flows into `peerBenchmark`/`comps.transactions`, Indian or global, listed or
  unlisted (competitive-landscape, international-benchmark, "Acquired by X", target's own rounds). Applies
  on the **next fresh upload**. For Visit that surfaces One Medical/Amazon, Optum, CVS MinuteClinic + the
  ₹440–490 Cr last round, alongside the banker-note peers (MediBuddy/Kenko/Seeking Care).
- **Authoritative path unchanged:** a valuation-comps export dropped in the "Other documents" upload slot
  is parsed directly into `comps.transactions` — the most reliable source for private names/deals.
- **DONE — "attach a report to an existing deal & regenerate":** Comps tab → "Add report". Rebuilds the
  deal in place (same id) from its stored source text + the new report, preserving the Deep Dive. See §10a.

### 9.3 Screener-via-Playwright scraper — only if needed
The user offered Screener.in login creds (to add as GitHub Actions secrets) for a Playwright scrape.
**Currently unnecessary** — Yahoo fills every listed-peer column. Build this only if a future deal needs
a ticker Yahoo doesn't carry. (Chromium is pre-installed in the env; `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`;
do not run `playwright install`.)

### 9.4 Audit tab — SHIPPED (PR #9); audience reworked (PR #11); a few optional follow-ups deferred
The on-demand **Audit** tab is live: `handleAudit` (worker) + `renderAudit` (app.js). It re-reads the
memo AND the stored source docs (`dealsrc:<id>`), compares them, and returns findings tagged
**wrong / missing / unsupported / assumption / verified**, each with document-vs-dashboard and a suggested
fix. `coerceAudit` normalises + orders findings and **derives the verdict from them** (never trusts the
model's own). See §10b.

**PR #11 reworked who sees / fixes what** (client feedback: the partner has no code access, so "fix the
app" was meaningless to him):
- **Deal-scope findings** are the only ones the partner sees, each now with a one-click **"Apply this
  fix"** (re-runs the deal with a correction directive; §10b).
- **App-scope findings** (tool bugs) are hidden from the partner and shown only behind a dev flag
  (`?dev=1`) as "Tool issues — for the Munshot team". **These are our running backlog to fix in code** —
  as we improve the tool, the corresponding class of app-scope finding should stop appearing.

PR #9's review (Codex bot) raised a few **P2** items the author consciously **deferred** with public
replies — all minor, none blocking. Pick them up only if the user asks:
- **Persist the pass "pending" markers across a page reload** so a live spinner (Deep Dive / Excel /
  Audit) survives a refresh. Today the RESULT always survives (it re-hydrates on focus), but the live
  spinner and single-run guard are client-only, so a reload mid-run can allow a duplicate run.
- **Persist a server-side FAILURE marker** for the GA passes so the client fails fast instead of waiting
  out its 16-min pending timeout on a known GA error. (Same gap for Deep Dive / Excel / Audit — a shared
  pass-lifecycle change is the clean fix.)
- **Version-guard an in-flight audit** against a concurrent regenerate (a narrow, self-correcting race).

These three are grouped as a single "shared pass-lifecycle" follow-up; do them together if at all.

### 9.5 Client feedback (Faraz, via WhatsApp) — export section-picker + returns mixed-basis
Faraz's screening-flow feedback, being worked through (PR #12):
- **Returns: entry on Revenue, exit on EBITDA/PAT (SHIPPED).** The UI already supported independent
  `entryBasis` / `exitBasis` dropdowns (switching a basis resets that leg's multiple to the comps median
  — an earlier Faraz ask, see `recomputeReturns`). Added: the core-memo **prompt now DEFAULTS to a mixed
  basis** — enter on revenue, exit on EBITDA (or PAT) — when a revenue-entered company is solidly
  profitable by the exit year, so the partner no longer has to flip it by hand. Fresh upload / regenerate.
- **Export: choose which sections to download (SHIPPED).** The Export button now opens a **section
  picker** (`openExportModal`) — a checkbox per report section (all ticked by default) — so the partner
  drops sections he doesn't need (his example: skip **Key questions** once the mgmt meeting has happened).
  `renderFullReport(c, include)` emits only the chosen keys; `REPORT_SECTIONS` is the offered list.
  (This subsumes his earlier "toggle Excel on/off on export" ask into a per-section toggle.)
- **NOTE — more feedback likely incoming.** The user was sharing Faraz's WhatsApp notes in batches, so
  check for further items before assuming this list is complete.

---

## 10. Key code locations (fast navigation)

> Line numbers drift as the file grows (`worker/index.js` is ~1960 lines now, `app.js` ~5330) — search
> by function name rather than trusting a number. `node --check` both files before pushing.
- **`worker/index.js`**
  - `coerceReturns(o)` — returns model: basis, entry-anchored-to-ask, exit illustrative, >40× guard.
  - `normalizeCompany` / `ensureDerivedFinancials(fin)` — fills only-when-missing ratios/CAGR/revenueMix,
    incl. **RoE = PAT ÷ net worth** (per-cell, additive; PR #9). RoCE deliberately left to the model.
  - `handleGenerate` — GA dispatch branch + dedupe. `handleRegenerate` — rebuild-in-place (§10a); also
    accepts a one-off `correction` directive (Audit "Apply this fix", §10b), folded into the prompt only.
  - `handleGhaResult` — validates/stores model output; branches per `kind` (**deepdive / excel / audit**)
    + don't-clobber-done guard.
  - `handleDeepDive` / `handleExcelAnalysis` / `handleAudit` — the three GA-patient second passes.
    `coerceDeepDive` (shared by deep dive + excel) / `coerceAudit` (splits `findings` deal-scope vs
    `appFindings` app-scope; verdict from deal-scope only).
  - `handlePeerMultiple` / `peerViaMunshot` / `yahooCreds(env)` / `peerViaYahoo(ticker,env)` — live comps
    (Munshot → Yahoo → screener.in). `runGovernance` — Integrity web/court sweep.
  - The big **prompt** (system/user) — comps provenance, year-span, deal-terms, returns basis (entry/exit
    basis may DIFFER — mixed-basis default, Faraz §9.5). Search `RETURNS (ALWAYS include` and the
    `PROVENANCE` rules. Audit prompt: search `AUDIT_SPEC`.
- **`public/js/app.js`**
  - `personName(p)` / `personAvatar(s)` — role-as-identity when a slide gives no personal name.
  - `renderManagement` / `renderPromoters` / `renderMemoExact` — people rendering.
  - `attachCompsLive` — client-side live comps fetch + overwrite of listed-peer columns.
  - `reconcileJobsFromServer` / `ensureJobPolling` / `refreshCompaniesFromServer` — GA-aware job polling +
    focus/visibility refresh; carefully preserves in-flight `_deepDivePending` / `_excelPending` /
    `_auditPending` flags across a server refresh.
  - `startDeepDive` / `startExcelAnalysis` / `startAudit` (+ their `retry*` / `maybeAuto*`) — the passes.
  - `renderExcelAnalysis` (reuses the `renderDDSection` / `renderDDBlock` deep-dive renderer) /
    `renderAudit` + `auditFindingCard` — the two newest tabs. Audit shows deal-scope findings only
    (app-scope behind `IS_DEV` = `?dev=1`); `applyAuditFix` / `auditFixDirective` drive the one-click
    "Apply this fix" (a correction-only `startRegeneration(company, [], {correction})`).
  - `renderFullReport(c, include)` + `REPORT_SECTIONS` / `reportSections(c)` / `openExportModal` — the
    PDF/report export and its **section picker** (Faraz, §9.5). Export button → picker modal → `exportPdf`.
- **`scripts/gha-generate.mjs`** — the GitHub Actions runner (patient Bedrock retries, 404-exit-clean,
  loops a `steps[]` payload for the combined insights run).
- **`.github/workflows/generate.yml`** — the `generate-deal` workflow (concurrency `generate-${jobId}`).
- **`wrangler.jsonc`** — Worker + assets + `DEALS` KV binding.

### 10a. "Add report → regenerate a deal in place" (how it works)
Adding a report to an existing deal rebuilds its memo under the SAME id, reusing the whole `/api/generate`
path (system prompt, GA/inline, streaming) — no prompt duplication.
- **Client:** Comps-tab "Add report" → `openAttachReportModal(company)` → `startRegeneration` → `runRegenJob`
  extracts ONLY the new report(s) (text + page images) and POSTs `{id, jobId, extraText, extraImages}` to
  `/api/regenerate` via `callGenerate(..., 'regenerate')`. Shows as a normal pipeline job.
- **Server:** `handleRegenerate` — idempotency lock `regenlock:<jobId>` (callGenerate retries once; GA
  returns before build) → loads `company:<id>` + `dealsrc:<id>` (stored `{imText,excelText,notesText}`) →
  appends the report to `imText` under a header → forwards an internal Request to `handleGenerate` with
  `reuseId:<id>`. `generateCompany`/`handleGhaResult` honor `reuseId` (skip `uniqueId`, overwrite in place)
  and **preserve the existing `deepDive`** (the core pass omits it). IM-text cap raised to 160k so an
  appended report never truncates.
- **Refresh:** inline → `runRegenJob` replaces the company + re-renders. GA (default) → `reconcileJobsFromServer`
  now replaces an existing company when its own `_regen` job completes (and the name-match fallback is
  skipped for regen jobs, so it can't falsely complete against the stale copy).
- **Gotcha for the next session:** a regen only completes on a decisive server done/error record — never
  on name-match. If you touch the poller, keep the `j._regen` guards.

### 10b. Audit tab — on-demand self-audit (how it works)
A "Run audit" button (Audit tab of an uploaded deal) checks the memo against its source documents and
lists differences. Findings are **split by who can act on them** (PR #11): the partner sees only the
ones he can fix; tool bugs are kept for the builder. Same GA-patient, poller-merged plumbing as the
Deep Dive / Excel passes.
- **Client:** `renderAudit(c)` → `retryAudit(id)` → `startAudit(id, inputs)` POSTs `{id, …source text}`
  to `/api/audit`. Flags `_auditPending` (spinner) → poller merges the new report → re-render. Re-runnable:
  it stamps `_auPrevAt` with the current audit's timestamp and only accepts a report with a NEWER
  `generatedAt`, so a re-run never stops on the previous one.
- **Server:** `handleAudit` loads `company:<id>` + `dealsrc:<id>`, runs `ensureDerivedFinancials` on the
  memo copy FIRST (so a derivable-but-blank ratio like RoE isn't falsely flagged), tells the model
  EXACTLY which sources it was handed (so it can't claim to have checked a doc it never saw — e.g. an
  empty scanned IM), calls Bedrock via GA (`kind:'audit'`), and stores the report under its **own key**
  `audit:<id>`. `coerceAudit` normalises findings and **splits them by scope**: `findings` (deal-scope,
  shown to the partner) and `appFindings` (app-scope tool bugs). Verdict (`clean`/`minor`/`issues`) is
  derived from the DEAL findings only — the model's own verdict, and tool bugs the partner can't fix,
  don't drive it.
- **Deal vs app — who sees / fixes what (PR #11):**
  - **Deal-scope** = wrong/missing content in THIS memo → shown to the partner, each with an **"Apply
    this fix"** button. Clicking it (`applyAuditFix` → `startRegeneration(company, [], {correction})`)
    re-runs the deal via `/api/regenerate` with a one-off `correction` directive folded into the prompt
    (NOT persisted to `dealsrc`), rebuilding in place (preserves Deep Dive / Excel). The rebuild clears
    the now-stale `audit:<id>`; the partner re-runs the audit to confirm the fix is gone.
  - **App-scope** = a tool bug that recurs across deals → the partner has NO code/admin access, so it's
    **hidden from him**. `appFindings` are kept (never lost) and shown only behind the **dev flag**
    (`IS_DEV`: `?dev=1` in the URL, sticky via `localStorage 'paramemo:dev'`) in a "Tool issues — for the
    Munshot team" section. These are OUR backlog to fix in code (§9.4).
- **Findings shape:** `{ severity: high|medium|low, status: wrong|missing|unsupported|assumption|verified,
  scope: deal|app, area, title, finding, memo, source_says, fix }`. `strengths[]` = things verified correct.
- **Lifecycle:** a regenerate (incl. an "Apply this fix") deletes `audit:<id>` (stale). Deleting a deal
  deletes `audit:<id>` too. `GET /api/companies` reads `company:<id>` + `audit:<id>` in parallel and
  merges the audit back as `c.audit`. Sample deals can't be audited / fixed (no source docs).

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

## 12. Commit history (on `main`)

**PR era (feature branch → PR → squash-merge to `main`; latest first):**
`6982927` (#9) RoE fill · combine Deep Dive + Excel into one run · on-demand Audit tab ·
`be6c125` (#8) auto-refresh deals on tab focus · `682eafd` (#7) hover tooltips on every chart ·
`1ef0456` (#6) prompt source-precedence + anchor returns to priced-on year · `b67fbf1` (#5) classify
founders as promoters · `413974c` (#4) source-precedence rule (note can't override IM) · `0a7781a` (#3)
Excel extraction drops month-only columns · `8f0bfdd` (#2) "—" instead of "0%" for absent-base margins ·
`0382dad` (#1) **Add Excel Analysis tab**.

**Pre-PR era (pushed straight to `main`):**
`36c6e25` GA mode · `383979f` fingerprint diag · `17d5a29` role-as-identity ·
`dbfd6ad` extraction/formatting bug batch · `6675b76` year-span · `51bf569` returns revenue basis+guard ·
`b66f813` anchor entry to ask · `fa0c0fc` anchor from headline · `9274fef` derive ratios/CAGR/mix ·
`c00e5f1` GHA duplicate-dispatch harmless · `1dc749f` deep-dive via GA · `6d78d08` Yahoo live comps.
