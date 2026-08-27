// Paragon Partners — Screening Memo · Cloudflare Worker
//
// Routes:
//   POST /api/generate   → read IM/Excel/notes text, call Claude (Bedrock), get a
//                          screening-memo JSON matching companies.json's shape,
//                          validate it, persist to KV, return { company }.
//   GET  /api/companies  → the list of uploaded deals stored in KV (or []).
//   *                    → static assets from /public via the ASSETS binding.
//
// Secrets NEVER reach the browser: all AI calls happen here. See README for setup.

const SEED_IDS = ['kusumgar', 'attero', 'style-union']; // the 3 seeds — never overwrite

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

// Resolve a secret/var tolerantly: exact name first, then a case-insensitive match on the env keys
// (Cloudflare binding names are case-sensitive, so "Munshot_Token" would otherwise miss "MUNSHOT_TOKEN").
function pickSecret(env, name) {
  if (env && env[name] != null && String(env[name]).trim()) return String(env[name]).trim();
  if (env) { const lower = name.toLowerCase(); for (const k of Object.keys(env)) if (k.toLowerCase() === lower && env[k] != null && String(env[k]).trim()) return String(env[k]).trim(); }
  return '';
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      // endsWith keeps the routes working even if the app is served under a sub-path.
      if (request.method === 'POST'   && path.endsWith('/api/generate'))      return await handleGenerate(request, env, ctx);
      if (request.method === 'POST'   && path.endsWith('/api/deepdive'))      return await handleDeepDive(request, env, ctx);
      if (request.method === 'GET'    && path.endsWith('/api/companies'))     return await handleCompanies(env);
      if (request.method === 'GET'    && path.endsWith('/api/peer-multiple')) return await handlePeerMultiple(request, env);
      if (request.method === 'DELETE' && path.includes('/api/companies/'))    return await handleDelete(request, env);
      if (request.method === 'DELETE' && path.includes('/api/jobs/'))         return await handleJobDelete(request, env);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      return json({ error: err.message || 'Something went wrong.' }, status);
    }
    // Everything else is a static asset.
    return env.ASSETS.fetch(request);
  },
};

/* ------------------------------------------------------------------ *
 * GET /api/companies — uploaded deals, newest first
 * ------------------------------------------------------------------ */
async function readIndex(env) {
  try { return JSON.parse((await env.DEALS.get('index')) || '[]'); }
  catch { return []; }
}
async function readHiddenSeeds(env) {
  try { return JSON.parse((await env.DEALS.get('hiddenSeeds')) || '[]'); }
  catch { return []; }
}

/* ------------------------------------------------------------------ *
 * BUILD-JOB RECORDS — durable pass/fail visibility for uploads.
 * The whole build is driven by the browser tab, and only a *successful* memo
 * used to be saved anywhere — so a failed or interrupted build left no trace and
 * vanished on reload. Now every build writes a small record to KV: "running" when
 * it starts, "error" (with the reason) if it fails, and it's cleared on success
 * (the finished deal itself is the record). GET /api/companies returns these, so
 * the dashboard shows a build's outcome even after a reload or on another device.
 * Stored as one key `jobs` = { [id]: { id, name, sector, status, startedAt, finishedAt, error } }.
 * ------------------------------------------------------------------ */
async function readJobsMap(env) {
  if (!env.DEALS) return {};
  try { const m = JSON.parse((await env.DEALS.get('jobs')) || '{}'); return (m && typeof m === 'object') ? m : {}; }
  catch { return {}; }
}
async function saveJobsMap(env, map) {
  // Prune so the key never grows unbounded: keep running jobs + anything finished in
  // the last 7 days, newest 40.
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  const kept = Object.values(map)
    .filter(j => j && j.id && (j.status === 'running' || (j.finishedAt || j.startedAt || 0) > cutoff))
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).slice(0, 40);
  const out = {}; for (const j of kept) out[j.id] = j;
  try { await env.DEALS.put('jobs', JSON.stringify(out)); } catch { /* best-effort */ }
  return out;
}
async function setJob(env, job) {
  if (!env.DEALS || !job || !job.id) return;
  try { const map = await readJobsMap(env); map[job.id] = { ...map[job.id], ...job }; await saveJobsMap(env, map); }
  catch { /* best-effort — a job record must never break a build */ }
}
async function clearJob(env, id) {
  if (!env.DEALS || !id) return;
  try { const map = await readJobsMap(env); if (map[id]) { delete map[id]; await saveJobsMap(env, map); } }
  catch { /* best-effort */ }
}
// DELETE /api/jobs/<id> — dismiss a build record (a failed/stale one) so it stops showing.
async function handleJobDelete(request, env) {
  if (!env.DEALS) return json({ ok: true });
  const id = decodeURIComponent((new URL(request.url).pathname.split('/api/jobs/')[1] || '').replace(/\/+$/, ''));
  if (id) await clearJob(env, id);
  return json({ ok: true });
}
async function handleCompanies(env) {
  // The peer-multiple endpoint always responds — Munshot market data first, then a
  // screener.in fallback (scrape.do when SCRAPEDO_API_KEY is set, else a best-effort
  // direct fetch) — so the "listed peers · live market data" panel is offered wherever a
  // deal has listed tickers. `peerLiveProxy` is retained for the UI's diagnostics only.
  const peerLiveProxy = !!pickSecret(env, 'SCRAPEDO_API_KEY');
  const peerLiveEnabled = true;
  if (!env.DEALS) return json({ companies: [], hiddenSeeds: [], peerLiveEnabled, peerLiveProxy, jobs: [] });   // KV not bound yet → no uploads
  const index = await readIndex(env);
  const companies = [];
  for (const id of index) {
    const raw = await env.DEALS.get(`company:${id}`);
    if (raw) { try { companies.push(JSON.parse(raw)); } catch { /* skip corrupt */ } }
  }
  // Running / failed builds, so the UI can show their outcome. A build stuck "running" well past
  // the Worker's own limit was almost certainly killed mid-flight (no done/error was ever written)
  // — surface it as a failure instead of a forever-spinner, and persist that so it stays resolved.
  let jobs = Object.values(await readJobsMap(env));
  const STALE_MS = 14 * 60 * 1000, now = Date.now();
  let mutated = false;
  jobs = jobs.map(j => {
    if (j && j.status === 'running' && now - (j.startedAt || now) > STALE_MS) {
      mutated = true;
      return { ...j, status: 'error', finishedAt: now, error: 'The build didn’t finish in time — the documents may be very large. Please try again.' };
    }
    return j;
  });
  if (mutated) { const m = {}; jobs.forEach(j => { if (j && j.id) m[j.id] = j; }); await saveJobsMap(env, m); }
  return json({ companies, hiddenSeeds: await readHiddenSeeds(env), peerLiveEnabled, peerLiveProxy, jobs });
}

// GET /api/peer-multiple?ticker=XXX — live market ratios for a LISTED peer.
// PRIMARY source is the Munshot market-data API (fastapi.muns.io/stock-data): it
// returns P/E, market cap AND the actual comp multiples (EV/EBITDA, EV/Revenue) for
// an NSE ticker, isn't bot-blocked, and needs no scraping proxy. If Munshot has no
// data it FALLS BACK to screener.in — via scrape.do when SCRAPEDO_API_KEY is set,
// else a best-effort direct fetch. Purely additive: returns {} / ok:false on any
// failure, never throws.
async function handlePeerMultiple(request, env) {
  const ticker = (new URL(request.url).searchParams.get('ticker') || '').trim().toUpperCase();
  if (!/^[A-Z0-9&.-]{1,20}$/.test(ticker)) return json({});

  // 1) Munshot — reliable, gives the comp multiples the Comps tab actually wants.
  try {
    const m = await peerViaMunshot(ticker, env);
    if (m && (m.pe != null || m.marketCapCr != null || m.evEbitda != null || m.evRevenue != null)) return json({ ticker, ok: true, via: 'munshot', ...m });
  } catch (_) { /* fall through to the screener path */ }

  // 2) screener.in fallback (scrape.do when keyed, else direct — may be blocked for datacenter IPs).
  const key = pickSecret(env, 'SCRAPEDO_API_KEY');
  const target = `https://www.screener.in/company/${encodeURIComponent(ticker)}/`;
  const fetchUrl = key
    ? `https://api.scrape.do/?token=${encodeURIComponent(key)}&url=${encodeURIComponent(target)}`
    : target;
  try {
    const res = await fetch(fetchUrl, {
      signal: AbortSignal.timeout(12000),
      headers: key ? {} : { 'user-agent': 'Mozilla/5.0 (compatible; ParagonScreening/1.0)', 'accept': 'text/html' },
    });
    if (!res.ok) return json({ ticker, ok: false, via: key ? 'scrape.do' : 'direct', status: res.status, detail: (await res.text().catch(() => '')).slice(0, 160) });
    const html = await res.text();

    // screener.in renders each top ratio as a "<span class=name>LABEL</span> … <span class=number>N</span>" pair.
    const grab = label => {
      const re = new RegExp(label + '[\\s\\S]{0,180}?<span[^>]*class="number"[^>]*>\\s*(-?[\\d,]+(?:\\.\\d+)?)', 'i');
      const m = html.match(re);
      const n = m ? parseFloat(m[1].replace(/,/g, '')) : null;
      return (n == null || isNaN(n)) ? null : n;
    };
    const out = { ticker, ok: true, via: key ? 'scrape.do' : 'direct' };
    const pe = grab('Stock P/E');
    const marketCapCr = grab('Market Cap');
    const roce = grab('ROCE');
    const roe = grab('ROE');
    if (pe != null) out.pe = pe;
    if (marketCapCr != null) out.marketCapCr = marketCapCr;
    if (roce != null) out.roce = roce;
    if (roe != null) out.roe = roe;
    return json(out);
  } catch (e) {
    return json({ ticker, ok: false, via: key ? 'scrape.do' : 'direct', error: (e && e.message) || 'fetch failed' });
  }
}

// Munshot market data for one listed peer. POST /stock-data returns a "Key=Value,Key=Value…"
// string for an NSE symbol (e.g. "GARFIBRES" → "GARFIBRES.NS"); we parse out the P/E, market
// cap and the EV multiples. Money fields come back as ABSOLUTE ₹ (INR) → convert to ₹ crore.
// Returns a fields object, or null when Munshot has no data for the ticker. Never throws to caller.
async function peerViaMunshot(ticker, env) {
  const url = pickSecret(env, 'MUNSHOT_STOCK_URL') || 'https://fastapi.muns.io/stock-data';
  const token = pickSecret(env, 'MUNSHOT_TOKEN');   // optional: the endpoint is public but the token raises rate limits
  const sym = ticker.includes('.') ? ticker : ticker + '.NS';   // Munshot uses Yahoo-style NSE symbols
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ ticker_symbol: sym, type: 'stockquote', country: pickSecret(env, 'MUNSHOT_COUNTRY') || 'India' }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return null;
  let data; try { data = await res.json(); } catch { return null; }
  if (typeof data !== 'string') return null;   // an error object ({detail:…}) means no data for this ticker
  const d = {};
  for (const part of data.split(',')) { const i = part.indexOf('='); if (i > 0) d[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  const gv = k => { const v = d[k]; if (v == null) return null; const n = parseFloat(String(v).replace(/,/g, '')); return isFinite(n) ? n : null; };
  const r2 = n => n == null ? null : Math.round(n * 100) / 100;
  const inr = /inr/i.test(d.Currency || 'INR');
  const toCr = n => (n == null || !inr) ? null : Math.round(n / 1e7);   // absolute ₹ → ₹ crore
  const out = {};
  const pe = r2(gv('P/E Ratio (Trailing)')); if (pe != null) out.pe = pe;
  const mc = toCr(gv('Market Cap')); if (mc != null) out.marketCapCr = mc;
  const ev = toCr(gv('Enterprise Value')); if (ev != null) out.evCr = ev;
  const ee = r2(gv('EV/EBITDA')); if (ee != null) out.evEbitda = ee;
  const er = r2(gv('EV/Revenue')); if (er != null) out.evRevenue = er;
  const pb = r2(gv('Price-to-Book')); if (pb != null) out.pb = pb;
  const roe = gv('Return on Equity'); if (roe != null) out.roe = Math.round(roe);
  return Object.keys(out).length ? out : null;
}

// DELETE /api/companies/<id> — remove an uploaded deal, OR hide a built-in sample.
async function handleDelete(request, env) {
  if (!env.DEALS) return json({ ok: true });
  const id = decodeURIComponent((new URL(request.url).pathname.split('/api/companies/')[1] || '').replace(/\/+$/, ''));
  if (!id) throw new ApiError(400, 'Missing company id.');
  if (SEED_IDS.includes(id)) {
    // Samples live in the static file (can't be deleted) — record a hide instead so it stays gone.
    const hidden = await readHiddenSeeds(env);
    if (!hidden.includes(id)) { hidden.push(id); await env.DEALS.put('hiddenSeeds', JSON.stringify(hidden)); }
    return json({ ok: true, id, hidden: true });
  }
  await env.DEALS.delete(`company:${id}`);
  try { await env.DEALS.delete(`dealsrc:${id}`); } catch { /* best-effort */ }
  const index = await readIndex(env);
  await env.DEALS.put('index', JSON.stringify(index.filter(x => x !== id)));
  return json({ ok: true, id });
}

/* ------------------------------------------------------------------ *
 * POST /api/generate — the upload → AI → memo flow
 * ------------------------------------------------------------------ */
async function handleGenerate(request, env, ctx) {
  if (!env.DEALS) throw new ApiError(503, "The memo builder's storage isn't set up yet — please contact your administrator.");

  let payload;
  try { payload = await request.json(); } catch { throw new ApiError(400, 'Invalid request body.'); }
  const { sheetNames = [], notesText = '', basics = {}, imPdfBase64 = '' } = payload || {};
  const jobId = (typeof payload.jobId === 'string' && payload.jobId) ? payload.jobId.slice(0, 64) : '';
  const excelText = String(payload.excelText || '').slice(0, 120000);
  // Cap combined document text (IM + any extra docs the browser concatenated) so a big multi-doc
  // upload can never overflow the model's context and trip a request-size error.
  let imText = String(payload.imText || '').trim().slice(0, 220000);
  // The browser also renders the IM/deck pages to JPEGs so the vision model can read logo walls,
  // org charts and infographics that never appear in the extracted text. Cap defensively.
  const imPages = (Array.isArray(payload.imPages) ? payload.imPages : []).filter(s => typeof s === 'string' && s).slice(0, 20);

  // OCR fallback: if the PDF had no extractable text (scanned image) and Mistral is
  // configured, OCR the bytes the browser sent. Best-effort; failures fall through.
  if (!imText && imPdfBase64 && env.MISTRAL_API_KEY) {
    imText = (await mistralOcr(imPdfBase64, env).catch(() => '')) || '';
  }
  if (!imText && !imPages.length && !String(excelText).trim()) {
    throw new ApiError(422, "We couldn't read any text from your documents. If the IM is a scan or photo, please upload a text-based PDF (or add the details in the fields), then try again.");
  }

  // Concrete schema example = the kusumgar seed entry (so the model matches the exact shape).
  const template = await loadTemplate(request, env);

  const system =
    'You are a disciplined, skeptical private-equity screening analyst. You are given a company\'s ' +
    'Information Memorandum (IM) — BOTH as rendered PAGE IMAGES and as its extracted text — together with its ' +
    'Excel financial model, and you produce a screening memo as ' +
    'STRICT JSON only, matching the given schema exactly (same keys and nesting). ' +
    'Return ONLY the JSON object — no markdown, no commentary.\n\n' +
    'WRITING: plain, non-technical English a busy partner can skim. All money in ₹ crore, rounded.\n\n' +
    'READ THE PAGE IMAGES CAREFULLY — this is the single most important thing you do. Company decks put critical facts inside images that are NOT in the extracted text — ' +
    'management & promoter names/titles (team & leadership slides), customer/partner names (logo walls), plant locations, ' +
    'the fundraise / deal terms, and charts. Go through EVERY page image one by one, top to bottom — do not skip a page — and transcribe what you see: ' +
    'promoters, management (each person\'s exact name + title), customers/clients/partners (read the name off every logo, even small ones), business segments, ' +
    'plants/capacity, certifications, competitors, and any deal / ask / valuation details. Completeness is critical: it is far better to capture every real name and number the pages show than to summarise. The page images ARE the documents.\n\n' +
    'ACCURACY: every number and fact must come from the documents you are given — the IM page images and their extracted text, and the Excel model. Never invent, extrapolate, or guess. ' +
    'If a value is in none of them, use an empty/TBD value — checklist status "tbd", "TBD" strings, ' +
    'an ownershipNote instead of an ownership array, or null cells — never fill a gap with a plausible number.\n' +
    'DO NOT USE OUTSIDE KNOWLEDGE beyond what the pages actually show. A name, client, founding year, ESOP, royalty or concentration % counts as "in the documents" only if you can read it in a page image or the extracted text — never from memory or inference. If neither the images nor the text name the management/promoters, return an empty people list (or a single "To be confirmed" note) rather than inventing anyone. Name only the customers actually shown (as text or as a logo you can read) — do not add plausible sector names. Do not turn an unrelated number (e.g. a sustainability "98%") into a concentration or ownership figure.\n\n' +
    'FINANCIAL YEARS (critical — must not drift):\n' +
    '• Copy the fiscal-year column headers from the Excel model VERBATIM (e.g. "FY21","FY22","FY24E"). ' +
    'Do not shift, renumber, relabel or infer years.\n' +
    '• A year is a FORECAST if its header is marked estimate/projected/budget (E, P, Est, Proj, Bud) or the ' +
    'model clearly presents it as such; otherwise it is an ACTUAL.\n' +
    '• financials.actualsThrough = the LAST ACTUAL (non-forecast) year, exactly matching the model\'s ' +
    'actual-vs-forecast split. Do not mark an actual year as an estimate or vice-versa.\n' +
    '• revenueSpark.years must equal financials.years, and revenueSpark.actualsThrough must equal financials.actualsThrough.\n' +
    '• headline.revenueLabel and headline.revenueCr MUST be the LATEST ACTUAL year (= actualsThrough), never a forecast ' +
    'year; headline.ebitdaPct and headline.patPositive must reflect that same year.\n' +
    '• Every financials.rows array must be the same length as financials.years; use null for blank cells.\n\n' +
    'FINANCIALS DEPTH (fill everything the model supports — this drives the whole Financials tab):\n' +
    '• Convert every money value to ₹ crore (if the model is in ₹ million ÷ 10, ₹ lakh ÷ 100, ₹ thousand ÷ 10000), keeping ONE decimal place (e.g. 214 mn → 21.4) so no precision is lost. Keep the model\'s full year span (often 6–10 years).\n' +
    '• COLUMN ALIGNMENT (critical — do not shift a row): every array (each financials.rows metric AND each segment/capacity row) must have EXACTLY as many entries as financials.years, and entry i must be the value under financials.years[i] in the source. If a row is blank for the first few years (a segment/line that did not exist yet, or a metric that only starts later), put a null in EACH of those leading positions — do NOT left-pack or slide the values into earlier columns. Verify one known cell: the number you place under the latest actual year must be the figure sitting in that exact year column in the model, and the last year must not come out blank if the source has a value there.\n' +
    '• financials.rows — populate each metric the model contains, as an array aligned to financials.years (null where blank): ' +
    'revenue, growthPct (YoY revenue growth %), grossMarginPct, ebitda, ebitdaPct, pat, patPct, capex, operatingCashflow (post working-capital), fcf (operating cash flow less capex), roePct, rocePct, nwcDays (net working-capital days), cash, netWorth, debt. ' +
    'All percentages are plain numbers (27 means 27%), not fractions. Negative values are allowed (losses, cash outflows).\n' +
    '• BALANCE SHEET — if the model has a balance sheet (often on a separate sheet named "BS" / "Balance Sheet"), DO fill it in: cash (cash & bank balances), netWorth (total shareholders\' equity / net worth) and debt (short-term borrowings + long-term borrowings, added together) for every year, and compute roePct (PAT ÷ net worth × 100) and rocePct where the inputs exist. These drive NET DEBT on the Returns tab, so do NOT leave cash or debt blank when a balance sheet is present. If the balance sheet is presented MONTHLY or QUARTERLY (many repeated period columns), take each fiscal year\'s YEAR-END (last period of the year) figure for cash, debt and net worth — never a mid-year column.\n' +
    '• financials.cagrCols — one or two period labels spanning the model (e.g. "FY19–24","FY24–28"); financials.cagr — { revenue:[…], ebitda:[…], pat:[…] } as FRACTIONS (0.66 = 66% CAGR), one per cagr column, null where the base year is zero/negative (shown as NM).\n' +
    '• financials.segments — { unit:"₹ cr", note:"one line on how the mix shifts", rows:[ { name, values:[… ONE value per year aligned to financials.years, null for years before the segment existed ], cagr:[…] } ] } — the revenue split by business segment/product over time, exactly as the model breaks it out. Self-check: in each year the segment values should add up to roughly that year\'s total revenue; if a year\'s segments sum to a different year\'s revenue, you have shifted the row — re-align it to the correct year columns.\n' +
    '• financials.capacity — include ONLY if the model has capacity/volume data: { unit, rows:[ { name, values:[…], utilPct:[…] } ] }.\n' +
    '• financials.revenueMix — { label, slices:[ {name, pct} ] } for the latest ACTUAL year (shares sum to ~100).\n\n' +
    'PEERS (only if the IM has a competition / benchmarking / peer section — otherwise OMIT "peers" entirely):\n' +
    '• peers = { metric, unit, note, self, rows }. Choose the ONE metric the IM benchmarks on: "EV/EBITDA" or "P/E" (unit "x") or "EBITDA margin" (unit "%").\n' +
    '• rows = [ { name, listed:true|false, ticker:"<NSE code>"|null, value:<number|null>, note:"short" } ] — list the named competitors, flag listed vs private, give the NSE ticker for listed Indian names if you know it, and fill value ONLY where the documents provide a figure (else null — NEVER invent a multiple).\n' +
    '• self = { name:"<the target>", value:<number|null>, listed:false } — the company\'s own value on that metric. note = one plain line on how it stacks up.\n\n' +
    'COMPS (build "comps" whenever the IM, banker notes or a Private Circle export names peers or past deals — otherwise OMIT "comps"). Three optional sub-blocks; include each only when you have real names/numbers, and NEVER invent a figure:\n' +
    '• comps.peerBenchmark = { asOf, note, self:{ name, listed:false, revenueCr, revenueGrowthPct, ebitdaPct, patPct }, rows:[ { name, listed, ticker|null, revenueCr, revenueGrowthPct, ebitdaPct, patPct, note } ] } — the OPERATING metrics of the named peers (latest year); null any figure the documents don\'t give. ALWAYS build peerBenchmark whenever the IM or notes name ANY competitors/peers — even if you only have their NAMES and a one-line qualitative note (leave every numeric field null). The Comps tab renders this block, so it must not be empty when peers are named; put the notes/positioning in each row\'s "note".\n' +
    '• comps.trading = { asOf, source, note, rows:[ { name, ticker|null, listed, marketCapCr, evCr, revenueCr, ebitdaPct, evEbitda, evRevenue, note } ] } — LISTED peers\' trading multiples. Give the NSE ticker for listed Indian names; leave marketCapCr/evCr null (they refresh live from Screener) and fill evEbitda/evRevenue only where a figure is provided.\n' +
    '• comps.transactions = { source, note, rows:[ { date:"YYYY" or "YYYY-MM", target, buyer, seller|null, dealType, stakePct, dealValue:"<as quoted, e.g. ₹340 cr or $34 mn>", evEbitda, evRevenue, note } ] } — past M&A / PE deals in the space and the multiples paid; null any multiple not disclosed.\n' +
    '• All money in ₹ crore except transaction dealValue (keep it as quoted). Percentages are plain numbers (18 = 18%). A peer, deal, multiple, market cap or margin counts as "in the documents" ONLY if it is in the IM, the banker notes or the Private Circle export — otherwise leave it null / omit the row.\n\n' +
    'IM DEEP-DIVE: do NOT include a "deepDive" key in this response — the visual IM unpacking is built in a separate, second pass so this memo stays fast and reliable. Focus here on a complete, accurate core memo.\n\n' +
    'FIT — judge INDEPENDENTLY and skeptically. The IM is a sell-side marketing document; do NOT accept its ' +
    'optimism at face value. Mark a fitChecklist item "yes" only when the documents clearly prove it, else "no" or ' +
    '"tbd". Weigh profitability, EBITDA margin, free cash flow, customer concentration and governance critically. ' +
    'Set fit.verdict: "go" only for a clearly strong, low-doubt fit; "watch" when there are material unresolved risks ' +
    '(thin margins, negative cash flow, concentration, governance) even if growth is high; "pass" when it fails core ' +
    'criteria. When in doubt, prefer "watch" over "go".\n\n' +
    'CHECKLISTS & QUESTIONS (produce Paragon\'s standard screening structure for EVERY deal):\n' +
    '• fitChecklist — the strategy screen; each item { label, status:"yes"|"no"|"tbd", note, group }. Cover, in group "Business": ' +
    'revenue above a materiality bar, revenue CAGR > ~20% (historical), profitable historically (PAT positive), cash generative (FCF positive), ' +
    'market leadership, low customer concentration. In group "Promoter": deep sector experience (>10 years), strong skin in the game (promoter stake > ~25%), ' +
    'raised institutional capital before, backed by known investors. Mark "tbd" when the documents don\'t settle it. Adapt to the sector but keep these core checks.\n' +
    '• integrity — the governance / diligence scan; each { area, status:"clear"|"flag"|"pending", finding }. ALWAYS include these five: ' +
    '"Google Search", "Private Circle", "CIBIL", "Rating", "Legal Search". These are EXTERNAL checks usually NOT in the IM itself — BUT if the partner attached a PRIVATE CIRCLE export or any governance / diligence / credit-rating document (look for it among the additional documents and the page images), READ IT and FILL each check from it rather than defaulting to pending: promoter/director background, shareholding and related parties (Private Circle); any default or credit history (CIBIL); the credit rating and outlook if stated (Rating); and any litigation, charges or MCA flags (Legal Search). Set status "clear" when that source shows a clean result, "flag" when it shows something to diligence, and only ' +
    '"pending" with finding "To be run" when NO attached source covers it. You MAY add extra rows (e.g. "Charges / MCA", "Directorships", "Related-party transactions") when the Private Circle export provides them. Never fabricate a clean result, a rating, or a finding that is not in the documents.\n' +
    '• questions — the meeting agenda; grouped { theme, items:[…] }. Use 4–7 themes that fit the deal (typically Strategy, Sourcing/Supply, Operations & capex, ' +
    'Customers/Distribution, Margins & financials, Peer benchmarking, IPO/exit timeline). Each item a sharp, specific question a partner would actually ask.\n\n' +
    'PEOPLE & OWNERSHIP: read the team / leadership / board slides in the PAGE IMAGES and list each promoter/manager with their EXACT name and title as shown (in the images or the text) — do not merge, ' +
    'rename, or swap roles between people, and do NOT supply names from general knowledge. If neither the images nor the text name any people, return an empty promoters/management list or a single "To be confirmed" entry — never invent a plausible name or title. Ownership percentages must sum to ~100% and only when the documents state them; otherwise use an ownershipNote.\n\n' +
    'RETURNS (ALWAYS include — this is the ONE illustrative block: the entry/exit assumptions for a base-case returns model. The app computes the money multiple and IRR itself by pulling EBITDA and net debt for entryYear/exitYear straight from the financials you output, so pick sensible YEARS and MULTIPLES rather than pre-computing proceeds):\n' +
    '• returns = { investmentCr:<number>, startEbitdaCr:<number>, startYear:"<FYxx>", entryYear:"<FYxx>", exitYear:"<FYxx>", defaults:{ entryX:<number>, exitX:<number>, growthPct:<number>, years:<number>, underdeliverPct:<number> } }. Every field is REQUIRED; numbers except the year strings. Never null, never omit.\n' +
    '• investmentCr = the equity cheque in ₹ cr. Use the IM\'s stated primary raise / fundraise ask if it gives one (the same figure as transaction.amountCr). If the IM states no amount, put a sensible round figure for a minority growth-equity stake scaled to the business — do NOT leave it null; this is the one place an assumption is expected.\n' +
    '• entryYear = a recent year with MEANINGFUL POSITIVE EBITDA to enter on (the latest actual, or the nearest forward year if the latest actual EBITDA is negligible/negative). startYear = entryYear and startEbitdaCr = that year\'s EBITDA in ₹ cr (positive, matching financials).\n' +
    '• exitYear = the LAST projected year in the model (the end of management\'s forecast horizon) — this is where the exit EBITDA comes from, so the model uses management\'s OWN projection for the exit, not a growth guess. Both entryYear and exitYear MUST be values that appear verbatim in financials.years.\n' +
    '• defaults = standard PE assumptions, illustrative not extracted: entryX = entry EV/EBITDA multiple (typically 10–16×, sector-appropriate); exitBasis = "ebitda" by default, or "pe" when the deal is naturally valued on earnings (consumer/retail/financials — e.g. the peers block benchmarks on P/E); exitX = the exit multiple on that basis (an EV/EBITDA multiple like ~10–16×, or a P/E like ~15–30× when exitBasis is "pe"); growthPct = a plausible EBITDA growth % anchored to the model (kept for reference); years = hold period; underdeliverPct = 0 (the default management-case haircut; the partner raises it to stress-test).\n\n' +
    'CONSISTENCY: returns.startYear/startEbitdaCr, the fit rationale and the checklist notes must all agree with the ' +
    'financials you output (same years, same actual-vs-forecast split).';

  const user = buildUserPrompt({ imText, excelText, sheetNames, notesText, basics, template });

  // A rich, vision-backed memo can take a few minutes — far longer than Cloudflare's ~100s edge
  // timeout (HTTP 524). So STREAM the response: return headers immediately and emit a keepalive
  // byte every few seconds while the model works, then write the final JSON. This keeps the client
  // connection alive for as long as generation needs. Final line is the JSON payload.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let finished = false;
  const ka = setInterval(() => { if (!finished) writer.write(enc.encode(' ')).catch(() => {}); }, 5000);   // keep the edge from idling out
  const run = (async () => {
    const jobMeta = { id: jobId, name: (basics.name || '').trim() || 'New deal', sector: (basics.sector || '').trim() };
    if (jobId) await setJob(env, { ...jobMeta, status: 'running', startedAt: Date.now(), finishedAt: null, error: null });
    let out;
    try {
      const company = await generateCompany({ system, user, imPages, basics, env });
      out = { company };
      // Stash the deal's source TEXT so the Deep Dive can be (re)built server-side later — from any
      // device, after a reload — without re-uploading the files. Text only (cheap); images aren't kept.
      try { await env.DEALS.put(`dealsrc:${company.id}`, JSON.stringify({ imText, excelText, notesText })); } catch { /* best-effort */ }
      // Mark done WITH the deal id (not just cleared) so a client that reloaded or lost its
      // connection mid-build can reconnect by polling and pick up the finished deal.
      if (jobId) await setJob(env, { ...jobMeta, status: 'done', companyId: company.id, finishedAt: Date.now(), error: null });
    } catch (e) {
      out = { error: (e && e.message) || 'The memo could not be built. Please try again.', status: e instanceof ApiError ? e.status : 500 };
      if (jobId) await setJob(env, { ...jobMeta, status: 'error', finishedAt: Date.now(), error: out.error });
    }
    finished = true; clearInterval(ka);
    try { await writer.write(enc.encode('\n' + JSON.stringify(out))); } catch (_) {}
    try { await writer.close(); } catch (_) {}
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(run);   // keep the worker alive until the stream is fully written
  return new Response(readable, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
}

// The heavy lifting: call the model (with one repair retry), validate, normalize, persist. Returns
// the finished company or throws an ApiError. Kept separate so handleGenerate can stream around it.
async function generateCompany({ system, user, imPages, basics, env }) {
  let ans = await callClaude({ system, user, images: imPages }, env);
  let obj = extractJson(ans.text);
  let problems = obj ? validateCompany(obj) : ['Response was not valid JSON.'];
  if (problems.length) {                                     // one repair pass to nudge the model
    const repair = `Your previous output had these problems: ${problems.join('; ')}. ` +
      `Return the corrected, COMPLETE JSON object only — same schema, all required keys present.`;
    const ans2 = await callClaude({ system, user: `${user}\n\n${repair}`, images: imPages }, env);
    const obj2 = extractJson(ans2.text);
    if (obj2) { ans = ans2; obj = obj2; problems = validateCompany(obj); }   // prefer a parseable retry
  }
  // Only a fundamentally unusable response fails; anything parseable with a financial backbone is
  // coerced into a usable memo (numeric strings, verdict casing, missing arrays are all recovered).
  if (!isObj(obj) || !isObj(obj.financials) || !Array.isArray(obj.financials.years) || !obj.financials.years.length) {
    throw new ApiError(502, "We couldn't pull a complete memo out of these documents — the financials were hard to read. Please try again (it usually works on a second run), or upload a clearer financial model.");
  }

  const base = slugify(basics.name || obj.name || obj.shortName || 'company');
  const id = await uniqueId(base, env);
  const company = normalizeCompany(obj, id, basics);
  company.generatedBy = ans.model;                          // which Bedrock model actually answered
  company.generatedAt = new Date().toISOString().slice(0, 10);

  // Governance sweep (web + court cases) fills the Integrity checks. Best-effort: never block the memo.
  try { await runGovernance(company, env); } catch (e) { console.error('governance sweep skipped:', e && e.message); }

  const index = await readIndex(env);
  await env.DEALS.put(`company:${id}`, JSON.stringify(company));
  await env.DEALS.put('index', JSON.stringify([id, ...index.filter(x => x !== id)]));
  return company;
}

/* ------------------------------------------------------------------ *
 * The AI call — Claude via Amazon Bedrock CONVERSE endpoint (Bearer key)
 * Tries a chain of model ids IN ORDER so we can prefer Sonnet 5 but fall back
 * safely. Fall through to the next id only on "can't use this model" errors
 * (HTTP 400/403/404); 429/5xx are retried on the SAME id (never fall through).
 * Returns { text, model } — model = the id that actually answered.
 * ------------------------------------------------------------------ */
const DEFAULT_MODEL_CHAIN = [
  'anthropic.claude-sonnet-5',                        // preferred (clean Bedrock id)
  'us.anthropic.claude-sonnet-5',                     // US cross-region inference profile
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0',    // proven fallback — keep last
];
function modelChain(env) {
  if (env.BEDROCK_MODEL_ID && env.BEDROCK_MODEL_ID.trim()) return [env.BEDROCK_MODEL_ID.trim()]; // single-id override
  const raw = env.BEDROCK_MODEL_IDS && env.BEDROCK_MODEL_IDS.trim();
  if (raw) { const list = raw.split(',').map(s => s.trim()).filter(Boolean); if (list.length) return list; }
  return DEFAULT_MODEL_CHAIN;
}

async function callClaude({ system, user, images = [], maxTokens = 16000 }, env) {   // rich memos are large; give the JSON room so the trailing keys never truncate
  // ⬇️ The real key plugs in here: BEDROCK_API_KEY is a Cloudflare secret (never in the repo).
  if (!env.BEDROCK_API_KEY) throw new ApiError(503, "The memo builder isn't switched on yet — please contact your administrator.");
  const region = env.AWS_REGION || 'us-east-1';
  const headers = {
    'Authorization': `Bearer ${env.BEDROCK_API_KEY}`,   // Bedrock API key (Bearer, not SigV4)
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  // The IM/deck is usually image-heavy (logo walls, org charts, infographics) — send the page
  // images alongside the text so the vision model reads what text extraction cannot.
  const content = [{ text: user }];
  for (const b64 of images) content.push({ image: { format: 'jpeg', source: { bytes: b64 } } });
  const body = JSON.stringify({
    system: [{ text: system }],
    messages: [{ role: 'user', content }],
    inferenceConfig: { temperature: 0, maxTokens },
  });

  const models = modelChain(env);
  const tried = [];
  let sawBusy = false;   // a model was throttled/overloaded (429/5xx/network) rather than simply unusable
  for (const modelId of models) {
    const endpoint = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`;
    let lastErr = '', unusable = false, timedOut = false;
    // A rich, vision-backed memo legitimately takes a few minutes to generate, so give it a
    // generous timeout. Retry only genuinely-transient failures (429/5xx, a dropped connection);
    // do NOT hammer a timed-out call — another few-minute wait won't help and only risks the
    // browser giving up. One slow-but-complete attempt beats four aborted ones.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500))); // ~1.5s, 3s (+jitter) — give a throttle window time to clear
      let res;
      try {
        res = await fetch(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(180_000) });   // fail a too-slow model cleanly (with an error record) before the Worker itself is killed
      } catch (e) {
        lastErr = `network error: ${e.message}`;
        if (e.name === 'TimeoutError') { timedOut = true; break; }  // too slow — stop; don't burn another few minutes
        continue;                                                    // transient blip — retry
      }

      if (res.status === 429 || res.status >= 500) {                 // retry on the same id
        lastErr = `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`;
        continue;
      }
      if ([400, 403, 404].includes(res.status)) {                    // "can't use this model" → try next id
        lastErr = `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`;
        unusable = true;
        break;
      }
      if (res.status !== 200) {                                      // any other non-200 → hard error
        console.error('memo-builder non-200', res.status, (await res.text().catch(() => '')).slice(0, 300));
        throw new ApiError(502, 'The memo builder hit a problem while writing your memo. Please try again in a moment.');
      }
      const data = await res.json();
      const parts = data && data.output && data.output.message && data.output.message.content;
      const text = Array.isArray(parts) ? parts.map(p => (p && p.text) || '').join('') : '';
      if (!text) throw new ApiError(502, 'The memo builder came back empty this time. Please try again.');
      return { text, model: modelId };                               // success — remember which id answered
    }
    tried.push(`${modelId} → ${lastErr}`);
    if (timedOut) throw new ApiError(504, 'The memo took too long to build (the documents may be very large). Please try again — it usually completes on a second run.');
    // 429/5xx/network exhausted on THIS model → DON'T give up: fall through to the next id in the
    // chain. A different model / inference profile usually has separate capacity when one is being
    // throttled or is overloaded (common on big vision payloads). We only surface "busy" once every
    // model has been tried.
    if (!unusable) { console.error('memo-builder model exhausted:', modelId, '→', lastErr); sawBusy = true; }
  }
  console.error('no usable model. tried:', tried.join(' | '));
  throw new ApiError(502, sawBusy
    ? 'The AI service is rate-limiting or overloaded right now — on every model we tried. Please wait a minute and try again (larger deals with many pages are more likely to hit this).'
    : 'The memo builder is temporarily unavailable. Please try again shortly, or contact your administrator if it persists.');
}

// Optional OCR fallback via Mistral (best-effort; only when a scanned PDF is sent).
async function mistralOcr(pdfBase64, env) {
  const res = await fetch('https://api.mistral.ai/v1/ocr', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.MISTRAL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'mistral-ocr-latest',
      document: { type: 'document_url', document_url: `data:application/pdf;base64,${pdfBase64}` },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) return '';
  const data = await res.json();
  return Array.isArray(data.pages) ? data.pages.map(p => p.markdown || p.text || '').join('\n\n') : '';
}

/* ------------------------------------------------------------------ *
 * Prompt building
 * ------------------------------------------------------------------ */
function buildUserPrompt({ imText, excelText, sheetNames, notesText, basics, template }) {
  const parts = [];
  parts.push('Produce a screening memo as a single JSON object that matches this schema EXACTLY (same keys and nesting). This is a real example to copy the shape of:\n');
  parts.push('```json\n' + template + '\n```\n');
  if (basics && Object.keys(basics).length) {
    parts.push('Partner-provided basics (use/override with these where given):\n' + JSON.stringify(basics) + '\n');
  }
  parts.push('=== INFORMATION MEMORANDUM (text) ===\n' + (imText || '(none)') + '\n');
  if (sheetNames && sheetNames.length) parts.push('=== EXCEL SHEET NAMES ===\n' + sheetNames.join(', ') + '\n');
  parts.push('=== EXCEL MODEL (CSV of the key sheets) ===\n' + (excelText || '(none)') + '\n');
  if (notesText && notesText.trim()) parts.push('=== BANKER NOTES ===\n' + notesText + '\n');
  parts.push('Before answering: copy the Excel year headers verbatim, set actualsThrough to the last ' +
    'ACTUAL (non-"E") year, make headline the latest ACTUAL year, and judge the fit skeptically (the IM is ' +
    'sell-side). Return ONLY the JSON object.');
  return parts.join('\n');
}

// The kusumgar seed entry, fetched from the static assets, is the schema template.
async function loadTemplate(request, env) {
  try {
    const res = await env.ASSETS.fetch(new Request(new URL('/data/companies.json', request.url)));
    const data = await res.json();
    const k = (data.companies || []).find(c => c.id === 'kusumgar');
    if (k) { const { deepDive, ...core } = k; return JSON.stringify(core, null, 2); }   // deepDive is a separate pass — keep it out of the core-memo schema
  } catch { /* fall through */ }
  return '{ "name": "", "shortName": "", "sector": "", "sectorTag": "", "oneLiner": "", "origination": {"date":"","banker":""}, "transaction": {"headline":"","amountCr":0,"type":"","coInvestment":"TBD"}, "fit": {"verdict":"watch","reason":""}, "revenueSpark": {"unit":"₹ cr","years":[],"values":[],"actualsThrough":""}, "headline": {"revenueLabel":"","revenueCr":0,"ebitdaPct":0,"patPositive":true}, "snapshot": {}, "financials": {"unit":"₹ cr","years":[],"actualsThrough":"","cagrCols":[],"rows":{"revenue":[],"growthPct":[],"grossMarginPct":[],"ebitda":[],"ebitdaPct":[],"pat":[],"patPct":[],"capex":[],"operatingCashflow":[],"fcf":[],"roePct":[],"rocePct":[],"nwcDays":[],"cash":[],"netWorth":[],"debt":[]},"cagr":{"revenue":[],"ebitda":[],"pat":[]},"segments":{"unit":"₹ cr","note":"","rows":[]},"revenueMix":{"label":"","slices":[]}}, "fitChecklist": [], "integrity": [], "questions": [], "thesis": [], "concerns": [], "returns": {"investmentCr":0,"startEbitdaCr":0,"startYear":"","defaults":{"entryX":12,"exitX":14,"growthPct":18,"years":5}} }';
}

/* ------------------------------------------------------------------ *
 * IM DEEP-DIVE — generated as a SECOND pass (POST /api/deepdive).
 * The core memo builds first and lands fast; this fills in the big visual IM
 * unpacking separately, so no single generation is long enough to be killed.
 * ------------------------------------------------------------------ */
const DEEP_DIVE_SPEC =
  'The deepDive is a COMPLETE, visual unpacking of the Information Memorandum so a partner NEVER has to open the PDF. Capture everything material the IM contains — miss nothing a partner would need — and present it as VISUAL blocks, not walls of text.\n' +
  '• SHAPE: { source:"<e.g. Company IM + management model>", summary:"<2–3 sentence executive nutshell>", sections:[ { title, icon?, summary?, blocks:[ … ] } ] }.\n' +
  '• SECTIONS ARE DYNAMIC — YOU decide them from THIS IM\'s own structure; there is NO fixed list and you must NOT force sections the IM does not cover. Include a section only when the IM has real content for it. Typical sections when present: Market & opportunity; Business model / how they make money; Products & segments; Financial trajectory; Unit economics; Customers & contracts; Competition & positioning; Growth strategy & roadmap; Use of proceeds; Capacity & operations; Supply chain; Management & organisation; ESG / compliance; Key risks. Add any other section the IM emphasises. Aim for genuine coverage — often 5–10 sections for a full IM.\n' +
  '• Each section: title = short and specific; summary = one plain-English takeaway line; icon (optional) ONE of: globe, factory, trendingUp, users, coins, target, briefcase, gauge, layers, wallet, mapPin, sparkles, shield, barChart.\n' +
  '• BLOCKS — pick the RIGHT visual for each piece of content, from this FIXED library (use the exact "type" strings and field names; unknown types are dropped):\n' +
  '   – kpis: { type:"kpis", title?, items:[ { label, value, sub?, unit?, delta? } ] } — headline numbers. value may be a number OR a formatted string ("₹2.4 lakh cr","23%").\n' +
  '   – bars: { type:"bars", title?, unit?, items:[ { label, value:<number>, note? } ] } — compare quantities. value MUST be numeric.\n' +
  '   – trend: { type:"trend", title?, caption?, x:[<labels>], series:[ { name, values:[<numbers|null> aligned to x] } ] } — anything over time.\n' +
  '   – donut: { type:"donut", title?, center?, centerSub?, items:[ { label, value:<number> } ] } — a share / mix breakdown.\n' +
  '   – funnel: { type:"funnel", title?, items:[ { label, value:<number>, unit?, note? } ] } — a narrowing sequence (TAM→SAM→SOM).\n' +
  '   – flow: { type:"flow", title?, steps:[ { label, note? } ] } — a process / value chain.\n' +
  '   – timeline: { type:"timeline", title?, items:[ { date, label, note? } ] } — history, milestones, roadmap.\n' +
  '   – table: { type:"table", title?, caption?, columns:[<strings>], rows:[ [<cells>] ] } — any grid. Cells are strings or numbers.\n' +
  '   – bullets: { type:"bullets", title?, items:[ "point" | { head, text } ] } — qualitative lists.\n' +
  '   – keyvalue: { type:"keyvalue", title?, items:[ { k, v } ] } — fact sheets.\n' +
  '   – callout: { type:"callout", tone:"info|good|warn|bad", title?, text } — a key insight, tailwind (good) or risk (warn/bad).\n' +
  '   – quote: { type:"quote", text, source? } — a management/customer quote actually printed in the IM.\n' +
  '   – text: { type:"text", title?, text } — a short narrative paragraph. Use SPARINGLY; prefer the visual blocks.\n' +
  '• PREFER VISUALS: every chart, table and number the IM shows should land in a kpis / bars / trend / donut / funnel / table block.\n' +
  '• Clean, not cluttered: group related blocks under the right section so each section tells one clear story.';

async function loadDeepDiveExample(request, env) {
  try {
    const res = await env.ASSETS.fetch(new Request(new URL('/data/companies.json', request.url)));
    const data = await res.json();
    const k = (data.companies || []).find(c => c.id === 'kusumgar');
    if (k && k.deepDive) return JSON.stringify(k.deepDive, null, 2);
  } catch { /* fall through */ }
  return '{ "source": "", "summary": "", "sections": [ { "title": "", "icon": "globe", "summary": "", "blocks": [ { "type": "kpis", "items": [ { "label": "", "value": "" } ] } ] } ] }';
}
// A compact view of the memo's financials so the deepDive's figures stay consistent with it.
function compactFinancials(c) {
  const f = (c && c.financials) || {}, rows = f.rows || {};
  const pick = k => Array.isArray(rows[k]) ? rows[k] : undefined;
  const o = { name: c && c.name, years: f.years, actualsThrough: f.actualsThrough, revenue: pick('revenue'), ebitda: pick('ebitda'), ebitdaPct: pick('ebitdaPct'), pat: pick('pat') };
  if (f.segments && Array.isArray(f.segments.rows)) o.segments = f.segments.rows.map(r => ({ name: r.name, values: r.values }));
  if (c && c.headline) o.headline = c.headline;
  if (c && c.transaction) o.ask = c.transaction.headline;
  try { return JSON.stringify(o); } catch { return '{}'; }
}

async function handleDeepDive(request, env, ctx) {
  if (!env.DEALS) throw new ApiError(503, "The memo builder's storage isn't set up yet.");
  let payload;
  try { payload = await request.json(); } catch { throw new ApiError(400, 'Invalid request body.'); }
  const id = String(payload.id || '').trim();
  if (!id) throw new ApiError(400, 'Missing deal id.');
  const raw = await env.DEALS.get(`company:${id}`);
  if (!raw) throw new ApiError(404, 'That deal is no longer available.');
  let company; try { company = JSON.parse(raw); } catch { throw new ApiError(500, 'The stored deal is unreadable.'); }

  let imText = String(payload.imText || '').trim().slice(0, 220000);
  let excelText = String(payload.excelText || '').slice(0, 120000);
  let notesText = String(payload.notesText || '');
  const imPages = (Array.isArray(payload.imPages) ? payload.imPages : []).filter(s => typeof s === 'string' && s).slice(0, 6);   // lighter than the core memo — the memo already did the heavy vision pass
  // Retry path: the client sent no text, so rebuild from the source we stashed when the memo was built.
  if (!imText) {
    try { const s = JSON.parse((await env.DEALS.get(`dealsrc:${id}`)) || 'null'); if (s) { imText = String(s.imText || '').slice(0, 220000); if (!excelText) excelText = String(s.excelText || '').slice(0, 120000); if (!notesText) notesText = String(s.notesText || ''); } } catch { /* none stored */ }
  }
  if (!imText && !imPages.length) throw new ApiError(400, 'This deal has no stored IM to rebuild the deep dive from — please re-upload it.');

  const example = await loadDeepDiveExample(request, env);
  const system =
    'You are a disciplined private-equity analyst. The core screening memo for this deal ALREADY EXISTS; you now produce ONLY its visual IM DEEP-DIVE. ' +
    'Return STRICT JSON: a single object { "source", "summary", "sections":[ … ] } and NOTHING else — no other keys, no markdown, no commentary.\n\n' +
    'WRITING: plain, non-technical English a busy partner can skim; all money in ₹ crore.\n' +
    'ACCURACY: every number, name, quote and label must come from the IM / banker notes / model provided — NEVER invent one to fill a chart. If a topic is only qualitative, use bullets / flow / keyvalue / timeline. Read the PAGE IMAGES for content not in the text (charts, market maps, logo walls).\n\n' +
    DEEP_DIVE_SPEC;
  const user =
    'Build the deepDive object. Copy this SHAPE exactly (a real example):\n```json\n' + example + '\n```\n' +
    'The core memo already computed these financials — any figures you show MUST match them (same years, same ₹ crore):\n' + compactFinancials(company) + '\n' +
    '=== INFORMATION MEMORANDUM (text) ===\n' + (imText || '(none)') + '\n' +
    '=== EXCEL MODEL (CSV of the key sheets) ===\n' + (excelText || '(none)') + '\n' +
    (notesText.trim() ? '=== BANKER NOTES ===\n' + notesText + '\n' : '') +
    'SCOPE: produce 6–9 well-chosen sections covering the most important parts of the IM, each with a few focused blocks — thorough but tight. Be sure to ALSO capture, whenever the IM contains them (these are high-value and easily missed): the FOUNDING TEAM and their pedigree / track record; any COMPARABLE or PRECEDENT company the IM benchmarks itself against and what it implies; named CUSTOMER / ISSUER TESTIMONIALS or quotes; named DISTRIBUTION / CHANNEL PARTNERS; flagship CASE STUDIES; and the PRODUCT / EXPANSION ROADMAP. ' +
    'Return ONLY the deepDive JSON object { source, summary, sections }.';

  // Stream keepalives (like /api/generate) so a multi-second build never trips the edge timeout.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter(); const enc = new TextEncoder();
  let finished = false;
  const ka = setInterval(() => { if (!finished) writer.write(enc.encode(' ')).catch(() => {}); }, 5000);
  const run = (async () => {
    let out;
    try {
      const ans = await callClaude({ system, user, images: imPages, maxTokens: 10000 }, env);
      const obj = extractJson(ans.text);
      const dd = coerceDeepDive(obj && (Array.isArray(obj.sections) ? obj : obj.deepDive));
      if (!dd) throw new ApiError(502, "We couldn't build the deep dive from these documents.");
      let cur = company; try { const r2 = await env.DEALS.get(`company:${id}`); if (r2) cur = JSON.parse(r2); } catch { /* keep the copy we have */ }
      cur.deepDive = dd;
      await env.DEALS.put(`company:${id}`, JSON.stringify(cur));
      out = { deepDive: dd };
    } catch (e) {
      out = { error: (e && e.message) || 'The deep dive could not be built.', status: e instanceof ApiError ? e.status : 500 };
    }
    finished = true; clearInterval(ka);
    try { await writer.write(enc.encode('\n' + JSON.stringify(out))); } catch (_) {}
    try { await writer.close(); } catch (_) {}
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(run);
  return new Response(readable, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
}

/* ------------------------------------------------------------------ *
 * JSON extraction + validation + normalisation
 * ------------------------------------------------------------------ */
// Pull the JSON object out of the model's text (handles ```json fences / stray prose).
function extractJson(text) {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
// Returns a list of problems ([] = valid). Checks the substantive containers the UI needs.
function validateCompany(o) {
  const p = [];
  if (!isObj(o)) return ['not an object'];
  for (const k of ['name', 'shortName', 'sector', 'sectorTag']) if (typeof o[k] !== 'string' || !o[k]) p.push(`missing "${k}"`);
  if (!isObj(o.transaction) || typeof o.transaction.headline !== 'string') p.push('missing "transaction.headline"');
  if (!isObj(o.fit) || !['go', 'watch', 'pass'].includes(o.fit.verdict)) p.push('fit.verdict must be go/watch/pass');
  if (!isObj(o.headline) || typeof o.headline.revenueCr !== 'number') p.push('missing "headline.revenueCr"');
  if (!isObj(o.revenueSpark) || !Array.isArray(o.revenueSpark.years) || !Array.isArray(o.revenueSpark.values)) p.push('missing "revenueSpark" arrays');
  if (!isObj(o.financials) || !Array.isArray(o.financials.years) || !isObj(o.financials.rows)) p.push('missing "financials.years/rows"');
  if (!isObj(o.snapshot)) p.push('missing "snapshot"');
  for (const k of ['fitChecklist', 'integrity', 'questions', 'thesis', 'concerns']) if (!Array.isArray(o[k])) p.push(`missing "${k}" array`);
  // NOTE: "returns" is intentionally NOT a hard requirement here — it is the illustrative
  // assumptions block, which normalizeCompany() always backfills into a valid shape. A good,
  // data-rich memo must never be thrown away just because the IM stated no deal size.
  return p;
}

// Coerce the model's output into the shapes the UI needs so a trivially-off response still yields
// a usable memo instead of a dead-end: numeric strings → numbers (handles ₹, commas, %, unicode
// minus, accounting parens), verdict synonyms/casing → go/watch/pass, missing containers → defaults.
function num(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const neg = /^\s*\(.*\)\s*$/.test(v);
  const c = v.replace(/[−–—]/g, '-').replace(/[^0-9.\-]/g, '');
  if (!c || c === '-' || c === '.' || c === '-.') return null;
  const n = parseFloat(c);
  return isFinite(n) ? (neg ? -Math.abs(n) : n) : null;
}
function coerceCompany(o, basics = {}) {
  const str = (v, d = '') => (typeof v === 'string' && v.trim()) ? v.trim() : (v == null ? d : String(v));
  o.name = str(o.name, basics.name || 'Company');
  o.shortName = str(o.shortName) || String(o.name).split(/[\s(]/)[0] || 'Company';
  o.sector = str(o.sector, basics.sector || 'Other');
  o.sectorTag = str(o.sectorTag, o.sector || 'Other');
  if (o.oneLiner != null) o.oneLiner = str(o.oneLiner);

  if (!isObj(o.fit)) o.fit = {};
  const V = String(o.fit.verdict || '').toLowerCase();
  o.fit.verdict = /\b(go|buy|proceed|invest|strong|attractive)\b/.test(V) ? 'go' : /\b(pass|reject|avoid|decline|drop|no-go)\b/.test(V) ? 'pass' : 'watch';
  o.fit.reason = str(o.fit.reason);

  if (!isObj(o.transaction)) o.transaction = {};
  o.transaction.headline = str(o.transaction.headline, basics.ask || 'TBD');
  if (o.transaction.amountCr != null) o.transaction.amountCr = num(o.transaction.amountCr);

  if (!isObj(o.headline)) o.headline = {};
  o.headline.revenueCr = num(o.headline.revenueCr);
  o.headline.ebitdaPct = num(o.headline.ebitdaPct);
  o.headline.revenueLabel = str(o.headline.revenueLabel);
  o.headline.patPositive = !!o.headline.patPositive;

  if (!isObj(o.snapshot)) o.snapshot = {};
  for (const k of ['fitChecklist', 'integrity', 'questions', 'thesis', 'concerns']) if (!Array.isArray(o[k])) o[k] = [];

  if (!isObj(o.financials)) o.financials = {};
  const fin = o.financials;
  fin.years = Array.isArray(fin.years) ? fin.years.map(y => str(y)) : [];
  if (!isObj(fin.rows)) fin.rows = {};
  for (const k of Object.keys(fin.rows)) if (Array.isArray(fin.rows[k])) fin.rows[k] = fin.rows[k].map(num);
  if (isObj(fin.segments) && Array.isArray(fin.segments.rows)) fin.segments.rows.forEach(r => { if (r && Array.isArray(r.values)) r.values = r.values.map(num); });
  if (isObj(fin.capacity) && Array.isArray(fin.capacity.rows)) fin.capacity.rows.forEach(r => { if (r) { if (Array.isArray(r.values)) r.values = r.values.map(num); if (Array.isArray(r.utilPct)) r.utilPct = r.utilPct.map(num); } });

  if (!isObj(o.revenueSpark)) o.revenueSpark = {};
  o.revenueSpark.years = Array.isArray(o.revenueSpark.years) ? o.revenueSpark.years.map(y => str(y)) : fin.years.slice();
  o.revenueSpark.values = Array.isArray(o.revenueSpark.values) ? o.revenueSpark.values.map(num) : (Array.isArray(fin.rows.revenue) ? fin.rows.revenue.slice() : []);

  if (o.headline.revenueCr == null && Array.isArray(fin.rows.revenue) && fin.rows.revenue.length) {
    const idx = fin.years.indexOf(fin.actualsThrough);
    o.headline.revenueCr = num(fin.rows.revenue[idx >= 0 ? idx : fin.rows.revenue.length - 1]);
  }
  if (o.headline.revenueCr == null) o.headline.revenueCr = 0;
  return o;
}

// Fill display-only fields the UI expects, set the id, and prefer partner basics.
function normalizeCompany(o, id, basics = {}) {
  coerceCompany(o, basics);       // make the model's types/enums UI-safe before anything reads them
  o.id = id;
  if (basics.name) o.name = basics.name;
  if (basics.sector) o.sector = basics.sector;
  if (basics.banker && isObj(o.origination)) o.origination.banker = basics.banker;
  if (basics.ask && isObj(o.transaction)) o.transaction.headline = basics.ask;
  if (!o.shortName) o.shortName = String(o.name || 'Company').split(/[\s(]/)[0];
  if (!o.monogram) o.monogram = initials(o.shortName || o.name);
  if (!o.project) o.project = 'Project ' + (o.shortName || 'New');
  if (!o.sectorTag) o.sectorTag = o.sector || 'Other';
  if (!o.oneLiner && o.snapshot && o.snapshot.whatTheyDo) o.oneLiner = o.snapshot.whatTheyDo;
  if (!isObj(o.origination)) o.origination = { date: '', banker: basics.banker || 'TBD' };
  if (!o.origination.date) o.origination.date = new Date().toISOString().slice(0, 10);
  o.returns = coerceReturns(o);   // guarantee a valid illustrative-returns block (the Returns tab depends on it)
  const comps = coerceComps(o.comps);   // optional comps block — keep only when it carries real rows
  if (comps) o.comps = comps; else delete o.comps;
  const dd = coerceDeepDive(o.deepDive);   // optional generic IM deep-dive — keep only when it has real blocks
  if (dd) o.deepDive = dd; else delete o.deepDive;
  o._uploaded = true;  // marker (UI can badge uploaded deals if desired)
  return o;
}

// The illustrative-returns block drives the Returns tab and returns math, so it must always be
// well-formed. Prefer the model's values; otherwise derive sensible ones from the financials and
// the transaction size. This is the one block where a reasonable assumption beats a dead-end error.
function coerceReturns(o) {
  const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
  const r   = isObj(o.returns) ? o.returns : {};
  const fin = isObj(o.financials) ? o.financials : {};
  const years  = Array.isArray(fin.years) ? fin.years : [];
  const rows   = isObj(fin.rows) ? fin.rows : {};
  const ebitda = Array.isArray(rows.ebitda)  ? rows.ebitda  : [];
  const revrow = Array.isArray(rows.revenue) ? rows.revenue : [];
  const posEbitda = i => typeof ebitda[i] === 'number' && ebitda[i] > 0;

  // defaults (entry/exit multiples, growth, hold) — keep the model's when sane, else PE-standard
  const din = isObj(r.defaults) ? r.defaults : {};
  const defaults = {
    entryX: num(din.entryX) > 0 ? din.entryX : 12,
    exitX:  num(din.exitX)  > 0 ? din.exitX  : 13,
    growthPct: num(din.growthPct) != null ? din.growthPct : 18,
    years:  num(din.years) > 0 ? Math.round(din.years) : 5,
    underdeliverPct: num(din.underdeliverPct) >= 0 ? din.underdeliverPct : 0,   // management-case haircut on exit earnings
    exitBasis: din.exitBasis === 'pe' ? 'pe' : 'ebitda',   // price the exit on EV/EBITDA (default) or P/E
  };

  // start year + starting EBITDA: prefer the model; else pick a year with meaningful positive EBITDA
  let startYear = (typeof r.startYear === 'string' && r.startYear) ? r.startYear : '';
  let startEbitdaCr = num(r.startEbitdaCr);
  if (!startYear || startEbitdaCr == null || startEbitdaCr <= 0) {
    let idx = years.indexOf(fin.actualsThrough);
    if (!(idx >= 0 && posEbitda(idx))) {              // latest actual EBITDA not usable → scan forward, then anywhere
      let found = -1;
      for (let i = Math.max(idx, 0); i < years.length; i++) if (posEbitda(i)) { found = i; break; }
      if (found < 0) for (let i = 0; i < years.length; i++) if (posEbitda(i)) { found = i; break; }
      idx = found;
    }
    if (idx >= 0) {
      if (!startYear) startYear = years[idx] || '';
      if (startEbitdaCr == null || startEbitdaCr <= 0) startEbitdaCr = num(ebitda[idx]);
    }
    if (startEbitdaCr == null || startEbitdaCr <= 0) {  // last resort: 15% of latest revenue
      const rev = num(revrow[years.indexOf(fin.actualsThrough)]) || num(revrow[revrow.length - 1]);
      if (rev > 0) startEbitdaCr = Math.round(rev * 0.15 * 10) / 10;
    }
    if (startEbitdaCr == null || startEbitdaCr <= 0) startEbitdaCr = 10;   // absolute floor so multiples stay finite
    if (!startYear) startYear = fin.actualsThrough || years[years.length - 1] || 'FY';
  }

  // investment cheque: model → transaction size → ~20% of entry enterprise value, rounded to a clean figure
  let investmentCr = num(r.investmentCr);
  if (investmentCr == null || investmentCr <= 0) {
    const txn = isObj(o.transaction) ? num(o.transaction.amountCr) : null;
    investmentCr = (txn > 0) ? txn : roundNice(Math.max(50, defaults.entryX * startEbitdaCr * 0.2));
  }

  // entry/exit years drive the returns bridge on the client (EBITDA + net debt come from the model
  // by year). entry = the start year; exit = the last projected year with meaningful positive EBITDA.
  const entryYear = (typeof r.entryYear === 'string' && years.includes(r.entryYear)) ? r.entryYear : startYear;
  let exitYear = (typeof r.exitYear === 'string' && years.includes(r.exitYear)) ? r.exitYear : '';
  if (!exitYear) { for (let i = years.length - 1; i >= 0; i--) if (posEbitda(i)) { exitYear = years[i]; break; } }
  if (!exitYear || (num(exitYear) != null && fyN(exitYear) <= fyN(entryYear))) exitYear = years[years.length - 1] || entryYear;

  return { investmentCr, startEbitdaCr, startYear, entryYear, exitYear, defaults };
}
// FY label → 2-digit number (for ordering entry vs exit). "FY26E" → 26, "FY2026" → 26.
function fyN(y) { const m = String(y == null ? '' : y).match(/(\d{2,4})/); if (!m) return null; let n = parseInt(m[1], 10); return n >= 1900 ? n - 2000 : n; }
function roundNice(n) {                                  // clean round figures for an illustrative cheque
  if (!(n > 0)) return 50;
  const step = n < 500 ? 25 : 50;
  return Math.round(n / step) * step;
}

// The optional comps block (peer benchmarking · trading · transactions). Purely additive: coerce the
// numeric fields to numbers and drop empty sub-blocks so the UI's "any rows?" checks stay simple.
// dealValue stays a string (IMs quote deals in mixed units). Returns undefined when there's nothing.
function coerceComps(k) {
  if (!isObj(k)) return undefined;
  const numRow = (r, keys) => { for (const key of keys) if (r[key] != null) r[key] = num(r[key]); return r; };
  const out = {};
  if (isObj(k.peerBenchmark) && Array.isArray(k.peerBenchmark.rows)) {
    const pb = k.peerBenchmark, f = ['revenueCr', 'revenueGrowthPct', 'ebitdaPct', 'patPct'];
    pb.rows = pb.rows.filter(isObj).map(r => numRow(r, f));
    if (isObj(pb.self)) numRow(pb.self, f);
    if (pb.rows.length) out.peerBenchmark = pb;
  }
  if (isObj(k.trading) && Array.isArray(k.trading.rows)) {
    const tr = k.trading;
    tr.rows = tr.rows.filter(isObj).map(r => numRow(r, ['marketCapCr', 'evCr', 'revenueCr', 'ebitdaPct', 'evEbitda', 'evRevenue']));
    if (tr.rows.length) out.trading = tr;
  }
  if (isObj(k.transactions) && Array.isArray(k.transactions.rows)) {
    const tx = k.transactions;
    tx.rows = tx.rows.filter(isObj).map(r => numRow(r, ['stakePct', 'evEbitda', 'evRevenue']));
    if (tx.rows.length) out.transactions = tx;
  }
  return Object.keys(out).length ? out : undefined;
}

// The generic IM deep-dive (dynamic sections of typed visual blocks). The frontend renderer is
// deliberately permissive — it ignores unknown fields and degrades gracefully — so here we only
// GUARANTEE STRUCTURE (sections[].blocks[].type) and CAP sizes so a runaway response can't bloat
// the memo. We keep every other field the model emits verbatim; kept only when it has real blocks.
const DD_ARRAY_KEYS = ['items', 'rows', 'steps', 'series', 'x', 'labels', 'categories', 'years', 'stages', 'events', 'milestones', 'points', 'columns', 'cols', 'headers', 'slices', 'segments', 'data', 'pairs', 'list', 'kpis', 'stats', 'metrics'];
function coerceDeepDive(dd) {
  if (!isObj(dd) || !Array.isArray(dd.sections)) return null;
  const sections = [];
  for (const s of dd.sections.slice(0, 16)) {
    if (!isObj(s) || !Array.isArray(s.blocks)) continue;
    const blocks = [];
    for (const b of s.blocks.slice(0, 24)) {
      if (!isObj(b) || typeof b.type !== 'string' || !b.type) continue;
      for (const key of DD_ARRAY_KEYS) if (Array.isArray(b[key])) b[key] = b[key].slice(0, 120);
      if (Array.isArray(b.series)) b.series.forEach(se => { if (isObj(se) && Array.isArray(se.values)) se.values = se.values.slice(0, 120); });
      if (Array.isArray(b.rows)) b.rows = b.rows.map(r => Array.isArray(r) ? r.slice(0, 24) : r);
      blocks.push(b);
    }
    if (!blocks.length) continue;
    const sec = { title: typeof s.title === 'string' ? s.title : '', blocks };
    if (typeof s.icon === 'string') sec.icon = s.icon;
    if (typeof s.summary === 'string') sec.summary = s.summary;
    sections.push(sec);
  }
  if (!sections.length) return null;
  const out = { sections };
  if (typeof dd.source === 'string') out.source = dd.source;
  if (typeof dd.summary === 'string') out.summary = dd.summary;
  return out;
}

/* ------------------------------------------------------------------ *
 * GOVERNANCE SWEEP — the pre-meeting red-flag checks that fill the Integrity tab.
 * A Worker-safe subset of the GCheck research agent: a web/news sweep (adverse press +
 * red-flag keywords) and a court-case lookup (Indian Kanoon), run on the company and its
 * promoters. PrivateCircle/CIBIL need a browser login (impossible in a Worker) and stay on
 * the uploaded-Private-Circle-report path. Best-effort: any failure leaves the model's
 * integrity finding untouched, and the memo never blocks on this.
 * ------------------------------------------------------------------ */
const GOV_KEYWORDS = ['lawsuit', 'legal', 'court', 'criminal', 'civil', 'cbi', 'eow', 'fraud', 'default', 'defaulter', 'wilful', 'police'];
const GOV_HARD_RED = ['fraud', 'wilful', 'defaulter', 'cbi', 'criminal', 'eow'];   // serious → red, else amber
const SEV_TO_STATUS = { red: 'risk', amber: 'flag', clear: 'clear', info: 'pending' };
const govMatched = text => { const t = String(text || '').toLowerCase(); return GOV_KEYWORDS.filter(k => t.includes(k)); };
const govStripTags = s => String(s).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
function govDdgUrl(href) { const m = href.match(/[?&]uddg=([^&]+)/); if (m) { try { return decodeURIComponent(m[1]); } catch { return href; } } return href.startsWith('//') ? 'https:' + href : href; }

// Web/news search — Munshot (Brave-backed) when MUNSHOT_TOKEN is set, else a keyless
// best-effort (often blocked from servers, in which case it returns []). [{title,url,snippet}]
async function govSearch(query, env, kind = 'web') {
  const token = pickSecret(env, 'MUNSHOT_TOKEN');
  if (token) {
    const url = kind === 'news'
      ? (pickSecret(env, 'MUNSHOT_NEWS_URL') || 'https://fastapi.muns.io/tools/news-search')
      : (pickSecret(env, 'MUNSHOT_SEARCH_URL') || 'https://fastapi.muns.io/tools/web-search');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, country: pickSecret(env, 'MUNSHOT_COUNTRY') || 'IN' }),
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) throw new Error(`search ${res.status}`);
    return govParseRows(await res.json());
  }
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; ParagonScreening/1.0)', accept: 'text/html' },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`ddg ${res.status}`);
  const html = await res.text();
  const out = []; const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g; let m;
  while ((m = re.exec(html)) && out.length < 8) out.push({ title: govStripTags(m[2]), url: govDdgUrl(m[1]) });
  return out;
}
function govParseRows(data) {
  let rows = [];
  if (Array.isArray(data)) rows = data;
  else if (isObj(data)) {
    if (data.data !== undefined) return govParseRows(data.data);
    if (isObj(data.web) && Array.isArray(data.web.results)) rows = data.web.results;
    else if (Array.isArray(data.results)) rows = data.results;
    else if (Array.isArray(data.web_results)) rows = data.web_results;
  }
  return rows.map(r => {
    const o = isObj(r) ? r : {};
    const snip = o.description || o.snippet || o.text || o.desc;
    return { title: govStripTags(String(o.title || o.name || '')), url: (o.url || o.link || o.href) ? String(o.url || o.link || o.href) : undefined, snippet: snip ? govStripTags(String(snip)) : undefined };
  }).filter(r => r.title || r.url);
}

// Court cases via Munshot site:indiankanoon.org (token) or public best-effort. [{title,url}]
async function govCourt(entity, env) {
  if (pickSecret(env, 'MUNSHOT_TOKEN')) {
    const rows = await govSearch(`site:indiankanoon.org "${entity}"`, env, 'web').catch(() => []);
    return rows.filter(r => /indiankanoon\.org\/doc\//.test(r.url || '')).slice(0, 5);
  }
  try {
    const res = await fetch(`https://indiankanoon.org/search/?formInput=${encodeURIComponent(entity)}`, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; ParagonScreening/1.0)' }, signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return [];
    const html = await res.text(); const out = []; const re = /<div class="result_title">\s*<a href="(\/doc\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g; let m;
    while ((m = re.exec(html)) && out.length < 5) out.push({ title: govStripTags(m[2]), url: 'https://indiankanoon.org' + m[1] });
    return out;
  } catch { return []; }
}

// Replace the first integrity row whose area name matches a keyword, else append.
function upsertIntegrity(arr, keys, item) {
  const i = arr.findIndex(x => x && typeof x.area === 'string' && keys.some(k => x.area.toLowerCase().includes(k)));
  if (i >= 0) arr[i] = { ...arr[i], ...item }; else arr.push(item);
}

// Run the sweep on the company + up to 2 promoters and merge findings into company.integrity.
async function runGovernance(company, env) {
  const promoters = (isObj(company.snapshot) && Array.isArray(company.snapshot.promoters) ? company.snapshot.promoters : [])
    .map(p => isObj(p) ? p.name : null);
  const entities = [company.name, ...promoters].map(s => String(s || '').trim()).filter(Boolean).slice(0, 3);
  if (!entities.length) return;
  if (!Array.isArray(company.integrity)) company.integrity = [];

  // Without a search token the server-side sweep isn't reliable (keyless engines are blocked from
  // datacenter IPs), so mark both checks honestly as "to be run" rather than risk a false "clear".
  if (!(pickSecret(env, 'MUNSHOT_TOKEN'))) {
    upsertIntegrity(company.integrity, ['google'], { area: 'Google Search', status: 'pending', finding: 'To be run — set the MUNSHOT_TOKEN secret for a reliable web search.' });
    upsertIntegrity(company.integrity, ['legal', 'court', 'mca', 'kanoon'], { area: 'Legal / Court cases', status: 'pending', finding: 'To be run — set the MUNSHOT_TOKEN secret for a reliable court-case search.' });
    return;
  }
  const kwClause = '(' + GOV_KEYWORDS.join(' OR ') + ')';

  // Web sweep — one keyword query per entity (concurrent, best-effort).
  const web = await Promise.allSettled(entities.map(e => govSearch(`"${e}" ${kwClause}`, env)));
  const flagged = [];
  web.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    for (const hit of r.value.slice(0, 8)) {
      const matched = govMatched(`${hit.title} ${hit.snippet || ''}`);
      if (matched.length) flagged.push({ entity: entities[i], title: hit.title, url: hit.url, matched });
    }
  });
  const webRan = web.some(r => r.status === 'fulfilled');

  // Court cases — company + promoters.
  const court = await Promise.allSettled(entities.map(e => govCourt(e, env)));
  const cases = [];
  court.forEach((r, i) => { if (r.status === 'fulfilled') for (const c of r.value) cases.push({ entity: entities[i], title: c.title, url: c.url }); });
  const courtRan = court.some(r => r.status === 'fulfilled');

  const allMatched = [...new Set(flagged.flatMap(f => f.matched))];
  const webSev = flagged.some(f => f.matched.some(k => GOV_HARD_RED.includes(k))) ? 'red' : flagged.length ? 'amber' : 'clear';

  upsertIntegrity(company.integrity, ['google'], webRan
    ? { area: 'Google Search', status: SEV_TO_STATUS[webSev],
        finding: flagged.length ? `${flagged.length} concerning result(s) — matched: ${allMatched.join(', ')}.` : 'No adverse coverage or red-flag keywords found.',
        links: flagged.slice(0, 4).map(f => ({ label: f.title, url: f.url })).filter(l => l.url) }
    : { area: 'Google Search', status: 'pending', finding: 'To be run — set the MUNSHOT_TOKEN secret for a reliable web search.' });

  upsertIntegrity(company.integrity, ['legal', 'court', 'mca', 'kanoon'], courtRan
    ? { area: 'Legal / Court cases', status: cases.length ? 'flag' : 'clear',
        finding: cases.length ? `${cases.length} litigation record(s) surfaced on Indian Kanoon — review before the meeting.` : 'No litigation records surfaced on Indian Kanoon.',
        links: cases.slice(0, 4).map(c => ({ label: c.title, url: c.url })).filter(l => l.url) }
    : { area: 'Legal / Court cases', status: 'pending', finding: 'To be run — set the MUNSHOT_TOKEN secret for a reliable court-case search.' });
}

function slugify(s) {
  return String(s).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'company';
}
async function uniqueId(base, env) {
  const index = await readIndex(env);
  const taken = new Set([...SEED_IDS, ...index]);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
function initials(name) {
  const parts = String(name).trim().split(/\s+/);
  return ((parts[0] || '')[0] || '' ) + ((parts[1] || '')[0] || '').toUpperCase() || 'CO';
}
