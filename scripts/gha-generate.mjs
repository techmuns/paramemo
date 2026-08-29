// Runs INSIDE GitHub Actions (Node 20). The Worker has already built the full prompt and stashed it;
// this runner just fetches that prompt, calls Bedrock with PATIENT retries (GitHub Actions has no
// 14-minute wall, so it can wait out a rate-limited/overloaded model for as long as it takes), then
// posts the raw model output back to the Worker, which validates + stores it exactly like an inline run.
//
// Secrets/vars (set on the repo): WORKER_URL, GHA_SECRET, BEDROCK_API_KEY, AWS_REGION, BEDROCK_MODEL_IDS.
// JOB_ID comes from the repository_dispatch client_payload.

const WORKER = (process.env.WORKER_URL || '').replace(/\/+$/, '');
const SECRET = process.env.GHA_SECRET || '';
const BKEY   = process.env.BEDROCK_API_KEY || '';
const REGION = process.env.AWS_REGION || 'us-east-1';
const MODELS = (process.env.BEDROCK_MODEL_IDS ||
  'anthropic.claude-sonnet-5,us.anthropic.claude-sonnet-5,us.anthropic.claude-sonnet-4-5-20250929-v1:0')
  .split(',').map(s => s.trim()).filter(Boolean);
const JOB_ID = process.env.JOB_ID || '';

const auth = { Authorization: `Bearer ${SECRET}` };

async function main() {
  if (!WORKER || !SECRET || !BKEY || !JOB_ID) throw new Error('missing WORKER_URL / GHA_SECRET / BEDROCK_API_KEY / JOB_ID');

  // 1) Pull the pre-built prompt the Worker stashed for this job.
  const pr = await fetch(`${WORKER}/api/gha-payload?jobId=${encodeURIComponent(JOB_ID)}`, { headers: auth });
  // A 404 means the payload was already consumed — a sibling run (same jobId, serialized by the
  // concurrency group) built this deal and deleted the one-shot stash. That's success, not failure:
  // exit cleanly so we don't report an error over a deal that already built.
  if (pr.status === 404) { console.log('payload already consumed — job handled by a sibling run; exiting cleanly.'); return; }
  if (!pr.ok) throw new Error(`payload fetch failed: HTTP ${pr.status} ${(await pr.text()).slice(0, 200)}`);
  const { system, user, images = [] } = await pr.json();
  if (!system || !user) throw new Error('payload missing system/user prompt');

  // 2) Call Bedrock — patiently. This is the whole point of moving to Actions.
  const { text, model } = await callBedrock(system, user, images);

  // 3) Hand the raw output back to the Worker to validate + store (same path as an inline run).
  const rr = await fetch(`${WORKER}/api/gha-result`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: JOB_ID, text, model }),
  });
  const body = await rr.text();
  if (!rr.ok) throw new Error(`result post failed: HTTP ${rr.status} ${body.slice(0, 300)}`);
  console.log('stored:', body.slice(0, 300));
}

// Bedrock Converse with a long, patient retry loop across the model fallback chain.
async function callBedrock(system, user, images) {
  const content = [{ text: user }, ...images.map(b64 => ({ image: { format: 'jpeg', source: { bytes: b64 } } }))];
  const body = JSON.stringify({ system: [{ text: system }], messages: [{ role: 'user', content }], inferenceConfig: { temperature: 0, maxTokens: 16000 } });
  let lastErr = '';
  const ROUNDS = 15;                          // ~15 waves; with the 60s wait that's up to ~15+ min of patience
  for (let round = 0; round < ROUNDS; round++) {
    for (const model of MODELS) {
      try {
        const res = await fetch(`https://bedrock-runtime.${REGION}.amazonaws.com/model/${encodeURIComponent(model)}/converse`, {
          method: 'POST',
          headers: { ...{ Authorization: `Bearer ${BKEY}` }, 'content-type': 'application/json', accept: 'application/json' },
          body,
          signal: AbortSignal.timeout(300_000),   // 5 min per attempt — GH Actions can afford it
        });
        if (res.status === 429 || res.status >= 500) { lastErr = `HTTP ${res.status} (busy)`; continue; }         // busy → try next model / next wave
        if ([400, 403, 404].includes(res.status)) { lastErr = `HTTP ${res.status} ${(await res.text()).slice(0, 160)}`; continue; }  // model unusable → next id
        if (res.status !== 200) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        const data = await res.json();
        const parts = data && data.output && data.output.message && data.output.message.content;
        const text = Array.isArray(parts) ? parts.map(p => (p && p.text) || '').join('') : '';
        if (text) return { text, model };
        lastErr = 'empty response';
      } catch (e) { lastErr = `network: ${e.message}`; }
    }
    console.log(`round ${round + 1}/${ROUNDS}: all models busy (${lastErr}); waiting 60s and retrying…`);
    await new Promise(r => setTimeout(r, 60_000));
  }
  throw new Error(`Bedrock exhausted after ${ROUNDS} waves — last: ${lastErr}`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
