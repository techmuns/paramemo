// Paragon Partners — Screening Memo
// Cloudflare Worker entrypoint.
//
// Phase 1: the Worker only serves the static site from /public via the ASSETS
// binding (configured in wrangler.jsonc). A later phase adds a POST endpoint
// here that accepts the IM (PDF) + Excel model and runs the AI extraction that
// builds a company's memo. Keep that future route additive — branch on the
// request method/path before falling through to the static asset handler.
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
