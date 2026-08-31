# Starter prompt for the next session

Copy everything in the code block below and paste it as your **first message** in the new
Claude Code session on this repo (`techmuns/paramemo`). It points the fresh session at `HANDOFF.md`,
which carries the full context.

```
Before anything else, read HANDOFF.md in the repo root, top to bottom — it's the handoff from my
previous session and carries all the context (architecture, deploy model, data sources, Returns/Comps
logic, what's built, and what's pending). Then read section "9. OPEN / PENDING WORK".

Quick orientation so you know who I am and how we work:
- This is Paramemo, a screening-memo dashboard for Paragon Partners (PE). Live at
  https://paramemo.tech-441.workers.dev (flagship deal: Visit Health, #visit-health).
- Deploy = a merge to main (Cloudflare auto-deploys the Worker on push to main; NOT wrangler, NOT the
  generate.yml Action). Recent work lands via feature branch → PR → squash-merge to main; each PR gets a
  Cloudflare preview URL. Secrets live in GitHub Actions + Cloudflare env — never commit secret values.
- Generation and the three second passes (Deep Dive, Excel Analysis, Audit) run through GitHub Actions
  ("gha" mode) because Bedrock overloads on the inline path. Fallback to inline = POST /api/gen-mode {mode:"worker"}.

Current state (as of the last session): everything is merged to main and live through PR #9. The
dashboard has 11 tabs including Excel Analysis and the new on-demand Audit tab. There is NO pending
dev task — the "detailed Excel analysis" work is DONE (it shipped as the Excel Analysis tab). The only
things still open are (a) the "Full Excel breakdown" VIEW TOGGLE, which is GATED on the client (Faraz)
— do NOT build it until I relay his answer — and (b) a few optional deferred follow-ups from PR #9's
review (HANDOFF §9.4). So don't assume a task; ask me what to pick up.

Start by reading HANDOFF.md and then tell me: (1) a one-paragraph confirmation you've got the context
and the current state, and (2) ask me what I'd like to work on next (or, if I've already told you,
propose a short plan for it). Don't change any code until I confirm.
```

---

**Tip:** if you also want the new session to re-load the source docs (the IM PDF, the Excel, the banker
notes), re-upload them in that session — the previous session's copies were temporary and won't carry
over. `HANDOFF.md §5` already inlines the key Visit Health figures so the session isn't blind without them.
