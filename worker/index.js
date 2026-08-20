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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      // endsWith keeps the routes working even if the app is served under a sub-path.
      if (request.method === 'POST'   && path.endsWith('/api/generate'))      return await handleGenerate(request, env);
      if (request.method === 'GET'    && path.endsWith('/api/companies'))     return await handleCompanies(env);
      if (request.method === 'GET'    && path.endsWith('/api/peer-multiple')) return await handlePeerMultiple(request, env);
      if (request.method === 'DELETE' && path.includes('/api/companies/'))    return await handleDelete(request, env);
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
async function handleCompanies(env) {
  const peerLiveEnabled = !!(env.SCRAPEDO_API_KEY && env.SCRAPEDO_API_KEY.trim());
  if (!env.DEALS) return json({ companies: [], hiddenSeeds: [], peerLiveEnabled });   // KV not bound yet → no uploads
  const index = await readIndex(env);
  const companies = [];
  for (const id of index) {
    const raw = await env.DEALS.get(`company:${id}`);
    if (raw) { try { companies.push(JSON.parse(raw)); } catch { /* skip corrupt */ } }
  }
  return json({ companies, hiddenSeeds: await readHiddenSeeds(env), peerLiveEnabled });
}

// GET /api/peer-multiple?ticker=XXX — live P/E + market cap via scrape.do → screener.in.
// Purely additive: returns {} on any failure or when no key is configured.
async function handlePeerMultiple(request, env) {
  const key = env.SCRAPEDO_API_KEY && env.SCRAPEDO_API_KEY.trim();
  if (!key) return json({});
  const ticker = (new URL(request.url).searchParams.get('ticker') || '').trim().toUpperCase();
  if (!/^[A-Z0-9&.-]{1,20}$/.test(ticker)) return json({});
  try {
    const target = `https://www.screener.in/company/${encodeURIComponent(ticker)}/`;
    const url = `https://api.scrape.do/?token=${encodeURIComponent(key)}&url=${encodeURIComponent(target)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return json({});
    const html = await res.text();
    // screener.in renders "Stock P/E" and "Market Cap" as label/number pairs
    const grab = label => {
      const re = new RegExp(label + '[\\s\\S]{0,160}?<span[^>]*class="number"[^>]*>\\s*([\\d,]+(?:\\.\\d+)?)', 'i');
      const m = html.match(re);
      return m ? parseFloat(m[1].replace(/,/g, '')) : null;
    };
    const pe = grab('Stock P/E');
    const marketCapCr = grab('Market Cap');
    const out = {};
    if (pe != null && !isNaN(pe)) out.pe = pe;
    if (marketCapCr != null && !isNaN(marketCapCr)) out.marketCapCr = marketCapCr;
    return json(out);
  } catch (_) {
    return json({});
  }
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
  const index = await readIndex(env);
  await env.DEALS.put('index', JSON.stringify(index.filter(x => x !== id)));
  return json({ ok: true, id });
}

/* ------------------------------------------------------------------ *
 * POST /api/generate — the upload → AI → memo flow
 * ------------------------------------------------------------------ */
async function handleGenerate(request, env) {
  if (!env.DEALS) throw new ApiError(503, 'Storage is not configured yet (KV namespace "DEALS" is missing).');

  let payload;
  try { payload = await request.json(); } catch { throw new ApiError(400, 'Invalid request body.'); }
  const { excelText = '', sheetNames = [], notesText = '', basics = {}, imPdfBase64 = '' } = payload || {};
  let imText = String(payload.imText || '').trim();
  // The browser also renders the IM/deck pages to JPEGs so the vision model can read logo walls,
  // org charts and infographics that never appear in the extracted text. Cap defensively.
  const imPages = (Array.isArray(payload.imPages) ? payload.imPages : []).filter(s => typeof s === 'string' && s).slice(0, 28);

  // OCR fallback: if the PDF had no extractable text (scanned image) and Mistral is
  // configured, OCR the bytes the browser sent. Best-effort; failures fall through.
  if (!imText && imPdfBase64 && env.MISTRAL_API_KEY) {
    imText = (await mistralOcr(imPdfBase64, env).catch(() => '')) || '';
  }
  if (!imText && !imPages.length && !String(excelText).trim()) {
    throw new ApiError(422, "Couldn't read the documents — the PDF may be a scanned image. Please paste the key details in the fields and try again.");
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
    'READ THE PAGE IMAGES CAREFULLY. Company decks put critical facts inside images that are NOT in the extracted text — ' +
    'management & promoter names/titles (team & leadership slides), customer/partner names (logo walls), plant locations, ' +
    'the fundraise / deal terms, and charts. Look at every page image and read these out: promoters, management, customers/' +
    'clients/partners (transcribe the names shown on logos), segments, capacity and any deal/ask details. The page images ARE part of the documents.\n\n' +
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
    '• BALANCE SHEET — if the model has a balance sheet, DO fill it in: cash, netWorth (total shareholders\' equity / net worth) and debt (short-term borrowings + long-term borrowings, added together) for every year, and compute roePct (PAT ÷ net worth × 100) and rocePct where the inputs exist. Do not leave these blank when a balance sheet is present in the model.\n' +
    '• financials.cagrCols — one or two period labels spanning the model (e.g. "FY19–24","FY24–28"); financials.cagr — { revenue:[…], ebitda:[…], pat:[…] } as FRACTIONS (0.66 = 66% CAGR), one per cagr column, null where the base year is zero/negative (shown as NM).\n' +
    '• financials.segments — { unit:"₹ cr", note:"one line on how the mix shifts", rows:[ { name, values:[… ONE value per year aligned to financials.years, null for years before the segment existed ], cagr:[…] } ] } — the revenue split by business segment/product over time, exactly as the model breaks it out. Self-check: in each year the segment values should add up to roughly that year\'s total revenue; if a year\'s segments sum to a different year\'s revenue, you have shifted the row — re-align it to the correct year columns.\n' +
    '• financials.capacity — include ONLY if the model has capacity/volume data: { unit, rows:[ { name, values:[…], utilPct:[…] } ] }.\n' +
    '• financials.revenueMix — { label, slices:[ {name, pct} ] } for the latest ACTUAL year (shares sum to ~100).\n\n' +
    'PEERS (only if the IM has a competition / benchmarking / peer section — otherwise OMIT "peers" entirely):\n' +
    '• peers = { metric, unit, note, self, rows }. Choose the ONE metric the IM benchmarks on: "EV/EBITDA" or "P/E" (unit "x") or "EBITDA margin" (unit "%").\n' +
    '• rows = [ { name, listed:true|false, ticker:"<NSE code>"|null, value:<number|null>, note:"short" } ] — list the named competitors, flag listed vs private, give the NSE ticker for listed Indian names if you know it, and fill value ONLY where the documents provide a figure (else null — NEVER invent a multiple).\n' +
    '• self = { name:"<the target>", value:<number|null>, listed:false } — the company\'s own value on that metric. note = one plain line on how it stacks up.\n\n' +
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
    '"Google Search", "Private Circle", "CIBIL", "Rating", "Legal Search". These are EXTERNAL checks usually NOT in the IM — mark them ' +
    '"pending" with finding "To be run" UNLESS the documents give a real result (e.g. a disclosed credit rating, or a lawsuit). Never fabricate a clean result.\n' +
    '• questions — the meeting agenda; grouped { theme, items:[…] }. Use 4–7 themes that fit the deal (typically Strategy, Sourcing/Supply, Operations & capex, ' +
    'Customers/Distribution, Margins & financials, Peer benchmarking, IPO/exit timeline). Each item a sharp, specific question a partner would actually ask.\n\n' +
    'PEOPLE & OWNERSHIP: read the team / leadership / board slides in the PAGE IMAGES and list each promoter/manager with their EXACT name and title as shown (in the images or the text) — do not merge, ' +
    'rename, or swap roles between people, and do NOT supply names from general knowledge. If neither the images nor the text name any people, return an empty promoters/management list or a single "To be confirmed" entry — never invent a plausible name or title. Ownership percentages must sum to ~100% and only when the documents state them; otherwise use an ownershipNote.\n\n' +
    'RETURNS (ALWAYS include — this is the ONE illustrative block: a base-case returns sketch that is explicitly assumptions, not extracted facts, so here you MUST fill numbers rather than leave nulls):\n' +
    '• returns = { investmentCr:<number>, startEbitdaCr:<number>, startYear:"<FYxx>", defaults:{ entryX:<number>, exitX:<number>, growthPct:<number>, years:<number> } }. Every field is REQUIRED; all are numbers except startYear. Never null, never omit.\n' +
    '• investmentCr = the equity cheque in ₹ cr. Use the IM\'s stated primary raise / fundraise ask if it gives one (the same figure as transaction.amountCr). If the IM states no amount, put a sensible round figure for a minority growth-equity stake scaled to the business — do NOT leave it null; this is the one place an assumption is expected.\n' +
    '• startYear = a recent year that has MEANINGFUL POSITIVE EBITDA (the latest actual year, or the nearest forward year if the latest actual EBITDA is negligible or negative). startEbitdaCr = that year\'s EBITDA in ₹ cr, a positive number matching financials.\n' +
    '• defaults = standard PE assumptions, illustrative not extracted: entryX / exitX = entry & exit EV/EBITDA multiples (typically 10–16×, sector-appropriate), growthPct = a plausible EBITDA growth % over the hold anchored to the model\'s trajectory, years = hold period (4–6).\n\n' +
    'CONSISTENCY: returns.startYear/startEbitdaCr, the fit rationale and the checklist notes must all agree with the ' +
    'financials you output (same years, same actual-vs-forecast split).';

  const user = buildUserPrompt({ imText, excelText, sheetNames, notesText, basics, template });

  // First attempt, with one repair retry if the JSON is malformed/incomplete.
  // callClaude returns { text, model } — model = whichever id in the chain answered.
  let ans = await callClaude({ system, user, images: imPages }, env);
  let obj = extractJson(ans.text);
  let problems = obj ? validateCompany(obj) : ['Response was not valid JSON.'];
  if (problems.length) {
    const repair = `Your previous output had these problems: ${problems.join('; ')}. ` +
      `Return the corrected, COMPLETE JSON object only — same schema, all required keys present.`;
    ans = await callClaude({ system, user: `${user}\n\n${repair}`, images: imPages }, env);
    obj = extractJson(ans.text);
    problems = obj ? validateCompany(obj) : ['Response was not valid JSON.'];
    if (problems.length) throw new ApiError(502, `The AI could not produce a valid memo (${problems[0]}). Please try again.`);
  }

  // Assign a unique id (never collide with a seed or an existing upload) and persist.
  const base = slugify(basics.name || obj.name || obj.shortName || 'company');
  const id = await uniqueId(base, env);
  const company = normalizeCompany(obj, id, basics);
  company.generatedBy = ans.model;                          // which Bedrock model actually answered
  company.generatedAt = new Date().toISOString().slice(0, 10);

  const index = await readIndex(env);
  await env.DEALS.put(`company:${id}`, JSON.stringify(company));
  await env.DEALS.put('index', JSON.stringify([id, ...index.filter(x => x !== id)]));

  return json({ company });
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
  if (!env.BEDROCK_API_KEY) throw new ApiError(503, 'AI is not configured yet (secret BEDROCK_API_KEY is missing).');
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
  for (const modelId of models) {
    const endpoint = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`;
    let lastErr = '', unusable = false;
    // Retry 429/5xx (and transient network errors) on THIS id with exponential backoff.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1))); // 1s, 2s, 4s
      let res;
      try {
        res = await fetch(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(90_000) });
      } catch (e) { lastErr = `network error: ${e.message}`; continue; }

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
        throw new ApiError(502, `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      }
      const data = await res.json();
      const parts = data && data.output && data.output.message && data.output.message.content;
      const text = Array.isArray(parts) ? parts.map(p => (p && p.text) || '').join('') : '';
      if (!text) throw new ApiError(502, 'The AI returned an empty response.');
      return { text, model: modelId };                               // success — remember which id answered
    }
    tried.push(`${modelId} → ${lastErr}`);
    // Only 400/403/404 falls through to the next id; exhausted 429/5xx/network errors stop here.
    if (!unusable) throw new ApiError(502, lastErr || 'The AI request failed.');
  }
  throw new ApiError(502, `No usable Bedrock model. Tried: ${tried.join(' | ')}`);
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
    if (k) return JSON.stringify(k, null, 2);
  } catch { /* fall through */ }
  return '{ "name": "", "shortName": "", "sector": "", "sectorTag": "", "oneLiner": "", "origination": {"date":"","banker":""}, "transaction": {"headline":"","amountCr":0,"type":"","coInvestment":"TBD"}, "fit": {"verdict":"watch","reason":""}, "revenueSpark": {"unit":"₹ cr","years":[],"values":[],"actualsThrough":""}, "headline": {"revenueLabel":"","revenueCr":0,"ebitdaPct":0,"patPositive":true}, "snapshot": {}, "financials": {"unit":"₹ cr","years":[],"actualsThrough":"","cagrCols":[],"rows":{"revenue":[],"growthPct":[],"grossMarginPct":[],"ebitda":[],"ebitdaPct":[],"pat":[],"patPct":[],"capex":[],"operatingCashflow":[],"fcf":[],"roePct":[],"rocePct":[],"nwcDays":[],"cash":[],"netWorth":[],"debt":[]},"cagr":{"revenue":[],"ebitda":[],"pat":[]},"segments":{"unit":"₹ cr","note":"","rows":[]},"revenueMix":{"label":"","slices":[]}}, "fitChecklist": [], "integrity": [], "questions": [], "thesis": [], "concerns": [], "returns": {"investmentCr":0,"startEbitdaCr":0,"startYear":"","defaults":{"entryX":12,"exitX":14,"growthPct":18,"years":5}} }';
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

// Fill display-only fields the UI expects, set the id, and prefer partner basics.
function normalizeCompany(o, id, basics = {}) {
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
  return { investmentCr, startEbitdaCr, startYear, defaults };
}
function roundNice(n) {                                  // clean round figures for an illustrative cheque
  if (!(n > 0)) return 50;
  const step = n < 500 ? 25 : 50;
  return Math.round(n / step) * step;
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
