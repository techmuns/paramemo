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
- Deploy = git push to main (Cloudflare auto-deploys the Worker; NOT wrangler, NOT GitHub Actions).
  Work on main. Secrets live in GitHub Actions + Cloudflare env — never commit secret values.
- Generation runs through GitHub Actions ("gha" mode) because Bedrock overloads on the inline path.
  Fallback to inline = POST /api/gen-mode {mode:"worker"}.

What I want to pick up now: the "detailed Excel analysis" work — surfacing the rich data that's in the
uploaded Excel/CIM but not yet wired into the dashboard (opex structure, unit economics, revenue-by-BU,
clinic ramp, fund use — all listed in HANDOFF §9.1). Note: the "Full Excel breakdown" VIEW TOGGLE is
still waiting on the client (Faraz) — don't build the toggle until I tell you his answer, but we can
work on surfacing the unused data itself.

Start by reading HANDOFF.md and then tell me: (1) a one-paragraph confirmation you've got the context,
and (2) a short proposed plan for the detailed-Excel-analysis work, so I can point you at the first piece.
Don't change any code until I confirm the plan.
```

---

**Tip:** if you also want the new session to re-load the source docs (the IM PDF, the Excel, the banker
notes), re-upload them in that session — the previous session's copies were temporary and won't carry
over. `HANDOFF.md §5` already inlines the key Visit Health figures so the session isn't blind without them.
