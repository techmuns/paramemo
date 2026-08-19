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
      if (request.method === 'POST' && path.endsWith('/api/generate')) return await handleGenerate(request, env);
      if (request.method === 'GET'  && path.endsWith('/api/companies')) return await handleCompanies(env);
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
async function handleCompanies(env) {
  if (!env.DEALS) return json({ companies: [] });          // KV not bound yet → no uploads
  const index = await readIndex(env);
  const companies = [];
  for (const id of index) {
    const raw = await env.DEALS.get(`company:${id}`);
    if (raw) { try { companies.push(JSON.parse(raw)); } catch { /* skip corrupt */ } }
  }
  return json({ companies });
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

  // OCR fallback: if the PDF had no extractable text (scanned image) and Mistral is
  // configured, OCR the bytes the browser sent. Best-effort; failures fall through.
  if (!imText && imPdfBase64 && env.MISTRAL_API_KEY) {
    imText = (await mistralOcr(imPdfBase64, env).catch(() => '')) || '';
  }
  if (!imText && !String(excelText).trim()) {
    throw new ApiError(422, "Couldn't read the documents — the PDF may be a scanned image. Please paste the key details in the fields and try again.");
  }

  // Concrete schema example = the kusumgar seed entry (so the model matches the exact shape).
  const template = await loadTemplate(request, env);

  const system =
    'You are an investment analyst. You read a company\'s Information Memorandum and ' +
    'financial model and produce a screening memo as STRICT JSON only. Output must ' +
    'match the given schema exactly (same keys and nesting). Use plain, non-technical ' +
    'English a busy partner can skim. All money in ₹ crore, rounded. Be faithful to the ' +
    'documents; do not invent numbers. Where a value is genuinely unavailable use sensible ' +
    'empty/TBU values (checklist status "tbd", an ownershipNote instead of an ownership ' +
    'array, "TBD" strings). years / revenueSpark / financials must come from the Excel model. ' +
    'Compute fit.verdict (go/watch/pass) and the fitChecklist from the firm\'s screening rules. ' +
    'Return ONLY the JSON object — no markdown, no commentary.';

  const user = buildUserPrompt({ imText, excelText, sheetNames, notesText, basics, template });

  // First attempt, with one repair retry if the JSON is malformed/incomplete.
  let obj = extractJson(await callClaude({ system, user }, env));
  let problems = obj ? validateCompany(obj) : ['Response was not valid JSON.'];
  if (problems.length) {
    const repair = `Your previous output had these problems: ${problems.join('; ')}. ` +
      `Return the corrected, COMPLETE JSON object only — same schema, all required keys present.`;
    obj = extractJson(await callClaude({ system, user: `${user}\n\n${repair}` }, env));
    problems = obj ? validateCompany(obj) : ['Response was not valid JSON.'];
    if (problems.length) throw new ApiError(502, `The AI could not produce a valid memo (${problems[0]}). Please try again.`);
  }

  // Assign a unique id (never collide with a seed or an existing upload) and persist.
  const base = slugify(basics.name || obj.name || obj.shortName || 'company');
  const id = await uniqueId(base, env);
  const company = normalizeCompany(obj, id, basics);

  const index = await readIndex(env);
  await env.DEALS.put(`company:${id}`, JSON.stringify(company));
  await env.DEALS.put('index', JSON.stringify([id, ...index.filter(x => x !== id)]));

  return json({ company });
}

/* ------------------------------------------------------------------ *
 * The AI call — Claude via Amazon Bedrock CONVERSE endpoint (Bearer key)
 * Mirrors a proven working setup: single Bedrock API key as a Bearer token,
 * the /converse endpoint, and the Converse request/response shape.
 * ------------------------------------------------------------------ */
async function callClaude({ system, user, maxTokens = 8000 }, env) {
  // ⬇️ The real key plugs in here: BEDROCK_API_KEY is a Cloudflare secret (never in the repo).
  if (!env.BEDROCK_API_KEY) throw new ApiError(503, 'AI is not configured yet (secret BEDROCK_API_KEY is missing).');
  const region = env.AWS_REGION || 'us-east-1';
  const modelId = env.BEDROCK_MODEL_ID || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

  const endpoint = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`;
  const headers = {
    'Authorization': `Bearer ${env.BEDROCK_API_KEY}`,   // Bedrock API key (Bearer, not SigV4)
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  const body = JSON.stringify({
    system: [{ text: system }],
    messages: [{ role: 'user', content: [{ text: user }] }],
    inferenceConfig: { temperature: 0, maxTokens },
  });

  // Retry on 429 / >=500 (and transient network errors) with exponential backoff.
  let lastErr = 'The AI request failed.';
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1))); // 1s, 2s, 4s
    let res;
    try {
      res = await fetch(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(90_000) });
    } catch (e) {
      lastErr = `network error: ${e.message}`;
      continue; // transient — retry
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`;
      continue; // retryable
    }
    if (res.status !== 200) {
      throw new ApiError(502, `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }
    const data = await res.json();
    const parts = data && data.output && data.output.message && data.output.message.content;
    const text = Array.isArray(parts) ? parts.map(p => (p && p.text) || '').join('') : '';
    if (!text) throw new ApiError(502, 'The AI returned an empty response.');
    return text;
  }
  throw new ApiError(502, lastErr);   // exhausted retries
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
  parts.push('Return ONLY the JSON object.');
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
  return '{ "name": "", "shortName": "", "sector": "", "sectorTag": "", "oneLiner": "", "origination": {"date":"","banker":""}, "transaction": {"headline":"","amountCr":0,"type":"","coInvestment":"TBD"}, "fit": {"verdict":"watch","reason":""}, "revenueSpark": {"unit":"₹ cr","years":[],"values":[],"actualsThrough":""}, "headline": {"revenueLabel":"","revenueCr":0,"ebitdaPct":0,"patPositive":true}, "snapshot": {}, "financials": {"unit":"₹ cr","years":[],"actualsThrough":"","rows":{}}, "fitChecklist": [], "integrity": [], "questions": [], "thesis": [], "concerns": [], "returns": {"investmentCr":0,"startEbitdaCr":0,"startYear":"","defaults":{"entryX":12,"exitX":14,"growthPct":18,"years":5}} }';
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
  if (!isObj(o.returns) || typeof o.returns.investmentCr !== 'number' || !isObj(o.returns.defaults)) p.push('missing "returns"');
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
  o._uploaded = true;  // marker (UI can badge uploaded deals if desired)
  return o;
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
