'use strict';

/* =============================================================================
   Paragon Partners — Screening Memo
   app.js  ·  Phases 1–3 (app shell + Pipeline + Company view: Snapshot, Financials)

   HOW THIS IS ORGANISED (so later phases slot in cleanly)
   -----------------------------------------------------------------------------
   1. Design tokens   – JS mirror of the CSS/Tailwind theme, so charts match.
   2. Utilities       – formatting, tiny DOM + icon helpers, tooltip, toast.
   3. State + data    – single source of truth is /data/companies.json.
   4. Router          – hash-based (#companyId/tab); pipeline ⇄ company view.
   5. Header          – company dropdown, brand→home, export placeholder.
   6. Pipeline screen – heading, Cards/Table toggle, cards, table, add-a-deal.
   7. Company view    – identity strip, tab bar, Snapshot, Financials, Coming soon.
   8. Charts          – sparklines, bars, lines, doughnuts (Chart.js).
   9. Overlays        – add-a-deal modal, skeleton, empty + error states.
   10. Boot           – init().

   HOUSE RULES
   - Never hardcode company data here; everything comes from companies.json.
   - CHART RULE: tiny sparklines may be shape-scaled (min–max); every full chart
     (bars/lines) is ZERO-BASED and honest. See buildSparkline vs cartesianBase.
   - Later phases add the Fit/Integrity/Questions/Thesis/Returns tabs — they are
     already in the tab bar as "Coming soon"; fill in renderTabPanel() for them.
   ============================================================================= */

/* -----------------------------------------------------------------------------
 * 1. Design tokens (mirror index.html's theme)
 * ---------------------------------------------------------------------------*/
const BRAND = {
  navy: '#0C3078', navyDark: '#0a2660', gold: '#B4924C',
  ink: '#111827', muted: '#6B7280', hint: '#9CA3AF', border: '#E7EAF1',
};

// Harmonised categorical palette — use in this order for categories.
const CHART_PALETTE = ['#0C3078', '#2E6FD6', '#14B8A6', '#10B981', '#B4924C', '#8B5CF6', '#F43F5E'];
const POS = '#10B981', NEG = '#F43F5E'; // positive / negative pair

// Fit verdict → label + colours (the "fit light").
const FIT = {
  go:    { label: 'Go',    color: '#10B981', tint: 'rgba(16,185,129,.12)' },
  watch: { label: 'Watch', color: '#F59E0B', tint: 'rgba(245,158,11,.14)' },
  pass:  { label: 'Pass',  color: '#E11D48', tint: 'rgba(225,29,72,.12)' },
};
const FIT_RANK = { go: 0, watch: 1, pass: 2 }; // screening priority (Go first)

// Stable sector-tag → colour mapping (falls back deterministically for new tags).
const SECTOR_COLOR = { Manufacturing: '#2E6FD6', Recycling: '#14B8A6', Consumer: '#8B5CF6' };
function sectorColor(tag) {
  if (SECTOR_COLOR[tag]) return SECTOR_COLOR[tag];
  let hsh = 0;
  for (const ch of String(tag || '')) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
  return CHART_PALETTE[hsh % CHART_PALETTE.length];
}

/* -----------------------------------------------------------------------------
 * 2. Utilities
 * ---------------------------------------------------------------------------*/
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// "798" → "₹798 cr" (rounded, Indian digit grouping). Numbers stay plain-language.
function fmtCr(n)  { return '₹' + Math.round(Number(n)).toLocaleString('en-IN') + ' cr'; }
// Grouped integer, keeps sign: -14 → "-14", 1014 → "1,014".
function fmtNum(n) { return Math.round(Number(n)).toLocaleString('en-IN'); }
// ISO date → "24 May 2025"
function fmtDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d) ? String(iso)
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
// Escape values interpolated into template-string HTML.
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Translucent version of a hex colour, for tinted chips/badges/bars.
function tint(hex, a) {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
// Build a DOM node from an HTML string (returns the first element).
function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
// Initials from a person's name: "Yogesh Kusumgar" → "YK".
function initials(name) {
  const p = String(name).trim().split(/\s+/);
  return ((p[0] || '')[0] || '' ) + ((p[1] || '')[0] || '');
}
// Team slides often describe a person by ROLE + background but never print a personal
// name (e.g. "Co-Founder & CEO — BITS Pilani, ex-MediBuddy"). In that case the role IS the
// identity — so we must NEVER show a "To be confirmed" placeholder when we actually have the
// role. personName() returns a real personal name, or '' when the name field is just a
// placeholder (or merely mirrors the role, as the management list often does).
const PERSON_PLACEHOLDER = /^(to be confirmed\.?|to be received\.?|tbc|tbd|tba|n\/?a|na|unknown|not disclosed|not available|not provided|—|-|\.)$/i;
function personName(p) {
  const n = String((p && p.name) || '').trim();
  if (!n || PERSON_PLACEHOLDER.test(n)) return '';
  if (n === String((p && p.role) || '').trim()) return '';
  return n;
}
// Avatar initials that ignore non-word tokens ("Co-Founder & CEO" → "CC", not "C&").
function personAvatar(s) {
  const w = String(s || '').split(/\s+/).filter(x => /[a-z]/i.test(x));
  return ((w[0] || '')[0] || '') + ((w[1] || '')[0] || '');
}
// Turn a Bedrock model id into a friendly name, e.g.
// Built-in demo deals (Kusumgar/Attero/Style Union) have no generatedBy; real
// uploads always do. Used to badge samples so they're never mistaken for uploads.
// NOTE: generatedBy/generatedAt are kept in the saved JSON for our own debugging
// but are NEVER shown to the client (these memos get emailed out) — do not render them.
function isSample(c) { return !!c && !c.generatedBy; }
const SAMPLE_TAG = '<span class="sample-tag" data-tip="Built-in example — not one of your uploads">Sample</span>';

// Inline Lucide-style icons (24×24, currentColor stroke). Small, tasteful set.
const ICONS = {
  grid:       '<rect width="7" height="7" x="3" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="3" rx="1.5"/><rect width="7" height="7" x="3" y="14" rx="1.5"/><rect width="7" height="7" x="14" y="14" rx="1.5"/>',
  table:      '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M12 3v18"/>',
  plus:       '<path d="M5 12h14"/><path d="M12 5v14"/>',
  chevronDown:'<path d="m6 9 6 6 6-6"/>',
  sort:       '<path d="m8 9 4-4 4 4"/><path d="m16 15-4 4-4-4"/>',
  arrowUp:    '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  arrowDown:  '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  arrowLeft:  '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  download:   '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  building:   '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M16 6h.01M8 10h.01M16 10h.01M8 14h.01M16 14h.01"/>',
  briefcase:  '<rect width="20" height="14" x="2" y="7" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  calendar:   '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M8 2v4"/><path d="M16 2v4"/>',
  trendingUp: '<path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/>',
  upload:     '<path d="M12 13v8"/><path d="m8 17 4-4 4 4"/><path d="M20 16.2A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"/>',
  x:          '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  info:       '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  fileText:   '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5"/><path d="M16 13H8M16 17H8M10 9H8"/>',
  sheet:      '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  inbox:      '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  alert:      '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  // Company-view additions
  clipboard:  '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6"/><path d="M9 16h4"/>',
  barChart:   '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><rect x="7" y="10" width="3" height="7" rx="1"/><rect x="12" y="6" width="3" height="11" rx="1"/><rect x="17" y="13" width="3" height="4" rx="1"/>',
  target:     '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  shield:     '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  help:       '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  lightbulb:  '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.8.8 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  users:      '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  star:       '<path d="M11.5 2.6a.6.6 0 0 1 1 0l2.6 5.3 5.8.8a.6.6 0 0 1 .3 1l-4.2 4 1 5.8a.6.6 0 0 1-.9.6L12 17.3l-5.2 2.8a.6.6 0 0 1-.9-.6l1-5.8-4.2-4a.6.6 0 0 1 .3-1l5.8-.8z"/>',
  check:      '<path d="M20 6 9 17l-5-5"/>',
  pieChart:   '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
  layers:     '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.57 3.9a2 2 0 0 0 1.66 0l8.57-3.9a1 1 0 0 0 0-1.83z"/><path d="m2 12.5 9.17 4.17a2 2 0 0 0 1.66 0L22 12.5"/><path d="m2 17.5 9.17 4.17a2 2 0 0 0 1.66 0L22 17.5"/>',
  clock:      '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  percent:    '<line x1="19" x2="5" y1="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
  wallet:     '<path d="M17 14h.01"/><path d="M7 7h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>',
  // Phases 4–5 additions
  minus:      '<path d="M5 12h14"/>',
  search:     '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  scale:      '<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>',
  gauge:      '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  award:      '<path d="m15.477 12.89 1.515 8.526a.5.5 0 0 1-.81.47l-3.58-2.687a1 1 0 0 0-1.197 0l-3.586 2.686a.5.5 0 0 1-.81-.469l1.514-8.526"/><circle cx="12" cy="8" r="6"/>',
  circle:     '<circle cx="12" cy="12" r="9"/>',
  thumbsUp:   '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>',
  sliders:    '<line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/>',
  coins:      '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
  sparkles:   '<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>',
  trash:      '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  bell:       '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  loader:     '<path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/>',
  refreshCw:  '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  bookOpen:   '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  mapPin:     '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
  factory:    '<path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"/><path d="M17 18h1"/><path d="M12 18h1"/><path d="M7 18h1"/>',
  globe:      '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
};
function icon(name, cls = 'w-4 h-4', sw = 2) {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

/* ---- Floating tooltip (data-tip="…") — positioned in <body> so it is never
 *      clipped by a card or a scroll container. Works on hover + focus. */
let _tipTarget = null, _tipEl = null;
function showTip(target) {
  const text = target.getAttribute('data-tip');
  if (!text) return;
  removeTipEl();                      // never hideTip() here — that would clear the target we're about to set
  _tipEl = h('<div class="tipbox" role="tooltip"></div>');
  _tipEl.textContent = text;
  document.body.appendChild(_tipEl);
  const r = target.getBoundingClientRect();
  const tr = _tipEl.getBoundingClientRect();
  let top = r.top - tr.height - 10, place = 'above';
  if (top < 8) { top = r.bottom + 10; place = 'below'; }             // flip if no room above
  let left = r.left + r.width / 2 - tr.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8)); // keep on-screen
  _tipEl.style.top = `${top}px`;
  _tipEl.style.left = `${left}px`;
  _tipEl.dataset.place = place;
  _tipEl.style.setProperty('--arrow', `${Math.max(10, Math.min(tr.width - 10, r.left + r.width / 2 - left))}px`);
  _tipTarget = target;                // set LAST: showTip is the only thing that owns a live target
  requestAnimationFrame(() => _tipEl && _tipEl.classList.add('show'));
}
function removeTipEl() { if (_tipEl) { _tipEl.remove(); _tipEl = null; } }
function hideTip() { removeTipEl(); _tipTarget = null; }
// Any mouseover tells us where the cursor now is: on the same target (keep), on a
// different one (swap), or on nothing tipped (hide). That last case is what makes
// the tip disappear the moment the cursor leaves the pill — mouseout alone misses
// fast exits, re-renders and elements that get removed while hovered.
document.addEventListener('mouseover', e => {
  const t = e.target.closest('[data-tip]');
  if (t === _tipTarget) return;
  if (t) showTip(t); else hideTip();
});
document.addEventListener('mouseout', e => {
  const t = e.target.closest('[data-tip]');
  if (t && t === _tipTarget && !t.contains(e.relatedTarget)) hideTip();
});
document.addEventListener('mousedown', hideTip, true);
document.addEventListener('focusin',  e => { const t = e.target.closest('[data-tip]'); if (t) showTip(t); });
document.addEventListener('focusout', hideTip);
window.addEventListener('scroll', hideTip, true);
window.addEventListener('blur', hideTip);

/* ---- Toast (small, transient confirmation) ---- */
function toast(msg) {
  const root = $('#toast-root');
  const el = h(`<div class="toast">${icon('info', 'w-4 h-4 shrink-0', 2)}<span></span></div>`);
  el.style.setProperty('color', '#fff');
  el.querySelector('svg').style.color = BRAND.gold;
  el.querySelector('span').textContent = msg;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 260); }, 2600);
}

/* ---- In-app confirm dialog ----------------------------------------------
 * A styled replacement for window.confirm(). The native dialog shows the raw
 * worker domain and — critically — is silently blocked when the dashboard is
 * embedded in a cross-origin iframe, so the action would never fire. This is a
 * normal DOM overlay, so it works the same standalone or embedded. Returns a
 * Promise<boolean>. */
function confirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return new Promise(resolve => {
    const root = $('#modal-root');
    const overlay = h(`
      <div class="modal-overlay" role="alertdialog" aria-modal="true">
        <div class="modal confirm-modal" style="max-width:412px">
          <div class="px-6 pt-5 pb-1">
            <h2 class="font-display text-[17px] font-semibold text-ink"></h2>
            <p class="text-[13.5px] text-ink-muted mt-1.5 leading-relaxed"></p>
          </div>
          <div class="flex items-center justify-end gap-2.5 px-6 pb-5 pt-4">
            <button data-cancel class="hdr-btn" style="color:${BRAND.ink};background:#F2F5FB;border-color:${BRAND.border}"></button>
            <button data-confirm class="hdr-btn"></button>
          </div>
        </div>
      </div>`);
    overlay.querySelector('h2').textContent = title;
    overlay.querySelector('p').textContent = message;
    overlay.querySelector('[data-cancel]').textContent = cancelLabel;
    const okBtn = overlay.querySelector('[data-confirm]');
    okBtn.textContent = confirmLabel;
    okBtn.style.cssText = danger
      ? 'color:#fff;background:#E11D48;border-color:#E11D48'
      : `color:#fff;background:${BRAND.navy};border-color:${BRAND.navy}`;

    let done = false;
    const finish = val => {
      if (done) return; done = true;
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 200);
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = e => { if (e.key === 'Escape') finish(false); else if (e.key === 'Enter') finish(true); };
    overlay.addEventListener('click', e => { if (e.target === overlay) finish(false); });
    overlay.querySelector('[data-cancel]').addEventListener('click', () => finish(false));
    okBtn.addEventListener('click', () => finish(true));
    document.addEventListener('keydown', onKey);
    root.appendChild(overlay);
    requestAnimationFrame(() => { overlay.classList.add('show'); okBtn.focus(); });
  });
}

/* -----------------------------------------------------------------------------
 * 3. State + data loading
 * ---------------------------------------------------------------------------*/
const state = {
  meta: null,
  companies: [],
  view: 'table',                     // pipeline: 'table' | 'cards' — tables are the default view everywhere
  sort: { key: 'fit', dir: 'asc' },  // default: Fit (Go→Watch→Pass), tie-break by deal size
  jobs: [],                          // in-flight / finished upload jobs (background processing)
};

// Company-view UI state (persists across company switches).
const ui = {
  companyId: null,
  tab: 'snapshot',
  fin: { forecast: true, view: 'table', segPct: false }, // financials: show forecast? · Table|Charts · segment ₹|%
};

// Anchor data + API URLs to THIS script's own URL (captured while
// document.currentScript is valid). app.js has already loaded, so its URL is a
// known-good anchor — robust whether served from root, a sub-path, or a preview.
const SCRIPT_URL = document.currentScript && document.currentScript.src;
const DATA_URL = (() => {
  try { return SCRIPT_URL ? new URL('../data/companies.json', SCRIPT_URL).href : 'data/companies.json'; }
  catch (_) { return 'data/companies.json'; }
})();
const API_BASE = (() => {
  try { return SCRIPT_URL ? new URL('../api/', SCRIPT_URL).href : 'api/'; }
  catch (_) { return 'api/'; }
})();
const apiUrl = p => { try { return new URL(p, API_BASE).href; } catch (_) { return 'api/' + p; } };

// CDN libraries for the upload flow, lazy-loaded on first use (see ensureUploadLibs).
const PDFJS_SRC    = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
const XLSX_SRC     = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

async function loadCompanies() {
  // Seed data (script-anchored URL first, then a plain document-relative path).
  let seed = null, status = 0;
  for (const url of [DATA_URL, 'data/companies.json']) {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (res.ok) { seed = await res.json(); break; }
      status = res.status;
    } catch (_) { /* try next candidate */ }
  }
  if (!seed) throw new Error(`Could not load companies.json${status ? ` (HTTP ${status})` : ''}`);

  // Uploaded deals from the Worker's KV (may be [] or unavailable on a static-only host).
  let uploaded = [], hiddenSeeds = [], peerLiveEnabled = false, peerLiveProxy = false, jobs = [];
  try {
    const res = await fetch(apiUrl('companies'), { cache: 'no-cache' });
    if (res.ok) { const d = await res.json(); if (Array.isArray(d.companies)) uploaded = d.companies; if (Array.isArray(d.hiddenSeeds)) hiddenSeeds = d.hiddenSeeds; if (Array.isArray(d.jobs)) jobs = d.jobs; peerLiveEnabled = !!d.peerLiveEnabled; peerLiveProxy = !!d.peerLiveProxy; }
  } catch (_) { /* no API (static preview) — seeds only */ }

  const hidden = new Set(hiddenSeeds);
  const seeds = (Array.isArray(seed.companies) ? seed.companies : []).filter(c => !hidden.has(c.id));   // sample can be hidden
  const seedIds = new Set(seeds.map(c => c.id));
  const companies = [...seeds, ...uploaded.filter(c => c && !seedIds.has(c.id))].map(prepCompany);
  return { meta: seed.meta || null, peerLiveEnabled, peerLiveProxy, companies, jobs };
}

// Indian PE deals run on fiscal years; some Excel models label the columns as bare calendar
// years ("2025") while our memos and CAGR labels use "FY25". Normalise every year label to the
// FY__ form for display so all views agree. Idempotent: "FY24E", "FY21–25" and non-year labels
// pass through unchanged. Purely cosmetic — cell values keep their positions.
function fyLabel(y) {
  if (typeof y !== 'string') return y;
  const m = y.trim().match(/^(?:FY)?\s*((?:19|20)\d{2}|\d{2})\s*([A-Za-z]{0,4})$/);
  if (!m) return y;                                        // leave anything unusual untouched (e.g. "FY21–25", "1Q25")
  const yr = m[1].length === 4 ? m[1].slice(2) : m[1];
  return 'FY' + yr + (m[2] || '');
}
function normalizeYears(c) {
  const f = c && c.financials;
  if (f && Array.isArray(f.years)) f.years = f.years.map(fyLabel);
  if (f && f.actualsThrough) f.actualsThrough = fyLabel(f.actualsThrough);
  const rs = c && c.revenueSpark;
  if (rs && Array.isArray(rs.years)) rs.years = rs.years.map(fyLabel);
  if (rs && rs.actualsThrough) rs.actualsThrough = fyLabel(rs.actualsThrough);
  if (c && c.returns && c.returns.startYear) c.returns.startYear = fyLabel(c.returns.startYear);
  return c;
}
// Defence-in-depth for rendering: guarantee the containers/arrays every tab and export reads, so a
// seed with a gap, older stored data, or an odd model shape can never white-screen a tab or export.
// (New uploads are already coerced server-side; this protects everything else at the render edge.)
const _o = v => v && typeof v === 'object' && !Array.isArray(v);
function hardenCompany(c) {
  if (!_o(c)) return c;
  if (!_o(c.transaction)) c.transaction = {};
  if (!_o(c.origination)) c.origination = {};
  if (!_o(c.headline)) c.headline = {};
  if (!_o(c.snapshot)) c.snapshot = {};
  if (!_o(c.fit)) c.fit = { verdict: 'watch', reason: '' };
  for (const k of ['fitChecklist', 'integrity', 'questions', 'thesis', 'concerns']) if (!Array.isArray(c[k])) c[k] = [];
  c.questions.forEach(t => { if (_o(t) && !Array.isArray(t.items)) t.items = []; });
  if (!_o(c.financials)) c.financials = {};
  const f = c.financials;
  if (!Array.isArray(f.years)) f.years = [];
  if (!_o(f.rows)) f.rows = {};
  if (_o(f.segments) && !Array.isArray(f.segments.rows)) f.segments.rows = [];
  if (_o(f.capacity) && !Array.isArray(f.capacity.rows)) f.capacity.rows = [];
  if (!_o(c.revenueSpark)) c.revenueSpark = {};
  if (!Array.isArray(c.revenueSpark.years)) c.revenueSpark.years = f.years.slice();
  if (!Array.isArray(c.revenueSpark.values)) c.revenueSpark.values = Array.isArray(f.rows.revenue) ? f.rows.revenue.slice() : [];
  if (!_o(c.returns)) c.returns = {};
  if (!_o(c.returns.defaults)) c.returns.defaults = { entryX: 12, exitX: 13, growthPct: 18, years: 5 };
  if (!(Number(c.returns.investmentCr) > 0)) c.returns.investmentCr = Number(c.returns.investmentCr) || 0;
  if (!(Number(c.returns.startEbitdaCr) > 0)) c.returns.startEbitdaCr = 10;   // avoid /0 in the returns math
  return c;
}
// Prepare any company entering state: harden its shape, then normalise year labels to FY__.
const prepCompany = c => normalizeYears(hardenCompany(c));

// Add or replace a company in local state + the dropdown (used after an upload).
function addCompany(company) {
  if (!company || !company.id) return;
  company = prepCompany(company);
  state.companies = state.companies.filter(c => c.id !== company.id);
  state.companies.push(company);
  populateCompanyDropdown();
}

// Remove a deal from the pipeline. Uploads are deleted from storage; the built-in
// samples are hidden (they live in a static file) — both persist server-side.
async function removeCompany(c) {
  const sample = isSample(c);
  const okToRemove = await confirmDialog({
    title: `${sample ? 'Remove sample' : 'Remove'} ${c.shortName || c.name}?`,
    message: sample
      ? 'This hides the built-in sample from your pipeline. It stays hidden across sessions.'
      : 'This deletes the deal and its memo from the pipeline. This can’t be undone.',
    confirmLabel: sample ? 'Remove sample' : 'Remove deal',
    cancelLabel: 'Keep it',
    danger: true,
  });
  if (!okToRemove) return;
  try {
    const res = await fetch(apiUrl('companies/' + encodeURIComponent(c.id)), { method: 'DELETE' });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Failed (${res.status})`); }
    state.companies = state.companies.filter(x => x.id !== c.id);
    populateCompanyDropdown();
    toast(`${c.shortName || c.name} removed`);
    goHome();
  } catch (err) {
    toast(err.message || 'Could not remove the deal');
  }
}

/* ---- Background job engine — a memo builds even if the modal is closed -------
 * startGeneration() kicks off extraction + AI in the background and returns a
 * job. The pipeline shows a "Processing…" card and the header bell announces it
 * when it's ready — so a partner can keep working instead of waiting. ---------*/
let _jobSeq = 0;
const _jobSubs = new Set();                 // modal working-screen subscribers
function onJobs(fn) { _jobSubs.add(fn); return () => _jobSubs.delete(fn); }
function emitJobs() {
  _jobSubs.forEach(fn => { try { fn(); } catch (e) { /* view may be gone */ } });
  updateBell();
  if (!ui.companyId && $('#pipeline-content')) renderView();   // refresh processing cards on the pipeline
}
function jobElapsed(job) {
  const ms = (job.finishedAt || Date.now()) - job.startedAt;
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function startGeneration(payload) {   // payload: { files:{im,excel,notes}, basics }
  const job = {
    // Globally-unique id (time + counter + random) so the server's build record can be
    // matched back to this job even after a reload or on another device.
    id: 'job_' + Date.now().toString(36) + '_' + (++_jobSeq).toString(36) + Math.random().toString(36).slice(2, 6),
    _abort: (typeof AbortController !== 'undefined') ? new AbortController() : null,   // lets the partner cancel the build
    name: (payload.basics.name || '').trim() || 'New deal',
    sector: (payload.basics.sector || '').trim(), status: 'running', stageIdx: 0,
    startedAt: Date.now(), finishedAt: null, company: null, error: null, seen: false,
  };
  state.jobs.push(job);
  emitJobs();
  ensureJobPolling();                 // watch it server-side too, so a reload can't orphan it
  runJob(job, payload);               // fire and forget — survives modal close
  return job;
}

// POST to /api/generate and read the streamed response. The worker emits keepalive spaces while it
// works (so Cloudflare never 524s a long build) and a final JSON line; we read to the end, parse the
// last line, and throw an error carrying its HTTP status so the caller can decide whether to retry.
async function callGenerate(bodyObj, signal, path = 'generate') {
  let res, buf = '';
  try {
    res = await fetch(apiUrl(path), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bodyObj), signal,
    });
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader(), dec = new TextDecoder();
      for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); }
      buf += dec.decode();
    } else {
      buf = await res.text();                                // fallback for environments without a readable body
    }
  } catch { const e = new Error('The connection dropped while building your memo. Please check your internet and try again.'); e.status = 0; throw e; }
  const lastLine = (buf.split('\n').pop() || '').trim();
  let data;
  try { data = JSON.parse(lastLine); }
  catch { const e = new Error('The memo builder didn\'t respond properly this time. Please try again.'); e.status = res.status || 0; throw e; }
  if (data.error) { const e = new Error(data.error); e.status = data.status || res.status; e.serverReported = true; throw e; }   // the worker finished and reported a failure — definitive
  if (!data.company) { const e = new Error('The memo builder didn\'t return a finished memo. Please try again.'); e.status = 502; throw e; }
  return data;
}

async function runJob(job, payload) {
  const stage = i => { if (job.status === 'running') { job.stageIdx = i; emitJobs(); } };
  let writeTO = null;
  job._streaming = true;   // this tab is driving the live build → the poller leaves this job alone
  try {
    stage(0);
    try { await ensureUploadLibs(); }
    catch { throw new Error("We couldn't load the file readers — please check your internet connection and try again."); }
    const extras = (payload.files.extra || []).filter(Boolean);
    const imName = (payload.files.im && payload.files.im.name) || 'the IM';
    let imText;
    try { imText = await extractPdfText(payload.files.im); }
    catch { throw new Error(`We couldn't open "${imName}". It looks corrupted or password-protected — please re-save it as a normal PDF and upload it again.`); }
    // Pull text from any extra supporting documents the partner added (more IMs, term sheets,
    // management decks, notes, extra spreadsheets). Images contribute through the vision path below.
    for (const xf of extras) {
      const nm = xf.name || 'document';
      try {
        if (/pdf$/i.test(nm) || (xf.type || '').includes('pdf')) imText += `\n\n===== Additional document: ${nm} =====\n` + await extractPdfText(xf, 40000);
        else if (/\.eml$/i.test(nm) || (xf.type || '').includes('rfc822')) imText += `\n\n===== Additional email: ${nm} =====\n` + await extractEmlText(xf, 40000);
        else if (/\.msg$/i.test(nm) || (xf.type || '').includes('outlook')) imText += `\n\n===== Additional email: ${nm} =====\n` + await extractMsgText(xf, 40000);
        else if (/\.docx$/i.test(nm) || /wordprocessingml/.test(xf.type || '')) imText += `\n\n===== Additional Word document: ${nm} =====\n` + await extractDocxText(xf);
        else if (/\.(xlsx|xls)$/i.test(nm)) { const r = await parseExcel(xf); imText += `\n\n===== Additional spreadsheet: ${nm} =====\n` + (r.excelText || ''); }
        else if (/\.(txt|md|csv|json)$/i.test(nm) || (xf.type || '').startsWith('text')) imText += `\n\n===== Additional notes: ${nm} =====\n` + (await xf.text()).slice(0, 40000);
      } catch (_) { /* skip an unreadable extra doc, never block the memo */ }
    }
    imText = imText.trim();
    const imPages = await renderAllDocImages([payload.files.im, ...extras]);   // let Claude SEE every doc (logos, org charts, teams)
    let imPdfBase64 = '';
    if (!imText && !imPages.length) imPdfBase64 = await fileToBase64(payload.files.im);   // scanned PDF → OCR fallback

    stage(1);
    const xlName = (payload.files.excel && payload.files.excel.name) || 'the Excel model';
    let excelText = '', sheetNames = [];
    try { ({ excelText, sheetNames } = await parseExcel(payload.files.excel)); }
    catch { throw new Error(`We couldn't read the Excel model "${xlName}". Please make sure it opens in Excel (and isn't password-protected), then upload it again.`); }

    let notesText = '';
    if (payload.files.notes) {
      const n = payload.files.notes, nn = n.name || '', nt = n.type || '';
      try {
        if (/\.eml$/i.test(nn) || nt.includes('rfc822'))          notesText = await extractEmlText(n, 20000);
        else if (/\.msg$/i.test(nn) || nt.includes('outlook'))    notesText = await extractMsgText(n, 20000);
        else if (/pdf$/i.test(nn) || nt.includes('pdf'))          notesText = await extractPdfText(n, 20000);
        else                                                      notesText = (await n.text()).slice(0, 20000);
      } catch { notesText = ''; }   // banker notes are optional — never fail the memo over them
    }

    stage(2);
    writeTO = setTimeout(() => stage(3), 7000);   // light up "writing" partway through the AI wait
    const bodyObj = { imText, excelText, sheetNames, notesText, basics: payload.basics, imPdfBase64, imPages, jobId: job.id };
    // No-interruption layer: the worker streams (so a multi-minute build never trips the edge
    // timeout), and we automatically retry once on a transient/server failure before surfacing it.
    let data = null, lastErr = null;
    for (let attempt = 0; attempt < 2 && job.status === 'running'; attempt++) {
      try { data = await callGenerate(bodyObj, job._abort && job._abort.signal); lastErr = null; break; }
      catch (e) {
        lastErr = e;
        const retriable = !e.status || e.status >= 500;   // network / stream / 5xx → retry; 4xx (bad input) → don't
        if (attempt === 0 && retriable) { await new Promise(r => setTimeout(r, 1500)); continue; }
        break;
      }
    }
    clearTimeout(writeTO);
    if (job._cancelled) return;   // the partner cancelled — stop quietly (the card is already gone)
    if (!data) {
      // The worker streamed back an explicit failure (bad input, or "busy"/overloaded) — the build
      // is genuinely over, so surface the reason right away instead of waiting on the poller.
      if (lastErr && lastErr.serverReported) throw lastErr;
      const st = lastErr && lastErr.status;
      if (st && st >= 400 && st < 500) throw lastErr;
      // Anything else (dropped stream, network blip) does NOT mean the build died: the
      // worker keeps generating after a dropped connection and records the result. Hand the job
      // to the poller, which reconciles the real outcome from the server — don't kill it here.
      job._streaming = false;   // release it to the poller
      job._awaitServer = true;
      emitJobs();
      ensureJobPolling();
      return;
    }

    job.stageIdx = 3;
    job.company = data.company;
    job.status = 'done';
    job._streaming = false;
    job.finishedAt = Date.now();
    addCompany(data.company);
    // The core memo is in — now fill in the visual Deep Dive as a SEPARATE, lighter pass so the
    // deal lands fast and no single build is long enough to be killed. Best-effort and additive.
    const stored = companyById(data.company.id);
    const ddInputs = { imText, imPages: [], excelText, sheetNames, notesText, basics: payload.basics };   // Deep Dive is TEXT-ONLY — the core memo already did the heavy vision pass; this keeps it fast enough to finish
    const xaInputs = { excelText, sheetNames };   // Excel Analysis reads only the spreadsheet
    if (stored) { stored._deepDivePending = true; stored._ddInputs = ddInputs; stored._excelPending = true; stored._xaInputs = xaInputs; stored._xaAutoTried = true; }   // cache inputs so both passes can be retried this session
    emitJobs();
    startDeepDive(data.company.id, ddInputs);
    startExcelAnalysis(data.company.id, xaInputs);
  } catch (err) {
    clearTimeout(writeTO);
    if (job._cancelled) return;   // cancelled mid-build — no error to show
    console.error(err);
    job._streaming = false;
    job.status = 'error';
    job.error = (err && err.message) || 'Something went wrong — please try again.';
    job.finishedAt = Date.now();
    emitJobs();
  }
}

// ---- Attach report(s) to an EXISTING deal and rebuild its memo in place -------------------------
// The deal's source text is stored server-side, so the browser only extracts the NEW report(s) and
// posts them to /api/regenerate, which rebuilds the memo under the SAME deal id (replacing it, not
// duplicating). Shows as a normal pipeline job; the existing Deep Dive is preserved server-side.
function startRegeneration(company, files) {
  const job = {
    id: 'regen_' + Date.now().toString(36) + '_' + (++_jobSeq).toString(36) + Math.random().toString(36).slice(2, 6),
    _abort: (typeof AbortController !== 'undefined') ? new AbortController() : null,
    name: (company.shortName || company.name || 'Deal'), sector: company.sector || '',
    status: 'running', stageIdx: 0, startedAt: Date.now(), finishedAt: null, company: null, error: null, seen: false,
    _regen: true, _regenId: company.id,
  };
  state.jobs.push(job);
  emitJobs();
  ensureJobPolling();
  runRegenJob(job, company, files);
  return job;
}

async function runRegenJob(job, company, files) {
  const stage = i => { if (job.status === 'running') { job.stageIdx = i; emitJobs(); } };
  let writeTO = null;
  job._streaming = true;
  try {
    stage(0);
    try { await ensureUploadLibs(); }
    catch { throw new Error("We couldn't load the file readers — please check your internet connection and try again."); }
    // Pull text from every attached report (a valuation-comps / Private Circle export, an updated deck…).
    let extraText = '';
    for (const f of files) {
      const nm = f.name || 'report';
      try {
        if (/pdf$/i.test(nm) || (f.type || '').includes('pdf'))                    extraText += `\n\n----- ${nm} -----\n` + await extractPdfText(f, 60000);
        else if (/\.(xlsx|xls)$/i.test(nm))                                        { const r = await parseExcel(f); extraText += `\n\n----- ${nm} -----\n` + (r.excelText || ''); }
        else if (/\.eml$/i.test(nm) || (f.type || '').includes('rfc822'))          extraText += `\n\n----- ${nm} -----\n` + await extractEmlText(f, 40000);
        else if (/\.msg$/i.test(nm) || (f.type || '').includes('outlook'))         extraText += `\n\n----- ${nm} -----\n` + await extractMsgText(f, 40000);
        else if (/\.docx$/i.test(nm) || /wordprocessingml/.test(f.type || ''))     extraText += `\n\n----- ${nm} -----\n` + await extractDocxText(f);
        else if (/\.(txt|md|csv|json)$/i.test(nm) || (f.type || '').startsWith('text')) extraText += `\n\n----- ${nm} -----\n` + (await f.text()).slice(0, 60000);
      } catch (_) { /* skip an unreadable report, never block the rebuild */ }
    }
    extraText = extraText.trim();
    stage(1);
    const extraImages = await renderAllDocImages(files, { maxImages: 5 });   // let Claude SEE the report pages (tables, charts)
    if (!extraText && !extraImages.length) throw new Error("We couldn't read anything from that file. Please export it as a PDF or Excel and try again.");

    stage(2);
    const body = { id: company.id, jobId: job.id, extraText, extraImages };
    writeTO = setTimeout(() => stage(3), 7000);
    let data = null, lastErr = null;
    for (let attempt = 0; attempt < 2 && job.status === 'running'; attempt++) {
      try { data = await callGenerate(body, job._abort && job._abort.signal, 'regenerate'); lastErr = null; break; }
      catch (e) {
        lastErr = e;
        const retriable = !e.status || e.status >= 500;
        if (attempt === 0 && retriable) { await new Promise(r => setTimeout(r, 1500)); continue; }
        break;
      }
    }
    clearTimeout(writeTO);
    if (job._cancelled) return;
    if (!data) {
      // GA mode returns before the memo is built (no company) and long builds can drop the stream —
      // both surface here as a non-fatal miss. Hand the job to the poller, which reconciles the real
      // outcome server-side (same id) and refreshes the deal. A definitive 4xx is surfaced instead.
      if (lastErr && lastErr.serverReported) throw lastErr;
      const st = lastErr && lastErr.status;
      if (st && st >= 400 && st < 500 && st !== 404) throw lastErr;   // 404 = mid-flight id race; let the poller settle it
      job._streaming = false;
      job._awaitServer = true;
      emitJobs();
      ensureJobPolling();
      return;
    }

    job.stageIdx = 3;
    job.company = data.company;
    job.status = 'done';
    job._streaming = false;
    job.finishedAt = Date.now();
    if (data.company) {
      addCompany(data.company);
      if (ui.companyId === data.company.id) renderView();   // the deal is open → refresh it with the new comps
      toast(`${job.name} updated with the report`);
    }
    emitJobs();
  } catch (err) {
    clearTimeout(writeTO);
    if (job._cancelled) return;
    console.error(err);
    job._streaming = false;
    job.status = 'error';
    job.error = (err && err.message) || 'Something went wrong — please try again.';
    job.finishedAt = Date.now();
    emitJobs();
  }
}

// Re-run the Deep Dive pass for a deal. Uses this session's cached inputs if present (richest —
// includes page images); otherwise sends nothing and the worker rebuilds from the IM text it
// stored when the memo was built — so this works after a reload / on another device too.
function retryDeepDive(id) {
  const c = companyById(id);
  if (!c) return;
  c._deepDivePending = true; c._deepDiveFailed = false;
  if (ui.companyId === id && parseHash().tab === 'deepdive') renderTabPanel(c, 'deepdive');
  startDeepDive(id, c._ddInputs || {});
}

// Second pass: build the visual Deep Dive for a freshly-created deal and merge it in. Runs in the
// background; if it fails or is interrupted the deal is unaffected (it just has no Deep Dive yet).
async function startDeepDive(id, payload) {
  try {
    const res = await fetch(apiUrl('deepdive'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, ...payload }) });
    let buf = '';
    if (res.body && res.body.getReader) { const rd = res.body.getReader(), dec = new TextDecoder(); for (;;) { const { done, value } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); } buf += dec.decode(); }
    else buf = await res.text();
    let d = {}; try { d = JSON.parse((buf.split('\n').pop() || '').trim()); } catch { /* leave as {} */ }
    const c = companyById(id);
    if (!c) return;
    if (d && d.queued && d.deepdive) {
      // GA mode: the deep dive builds in GitHub Actions (patiently waiting out Bedrock). Keep it
      // pending; the poller merges it in when the worker stores it on the company.
      c._deepDivePending = true; c._deepDiveFailed = false; c._ddPendingSince = Date.now();
      ensureJobPolling();
      if (ui.companyId === id && parseHash().tab === 'deepdive') renderTabPanel(c, 'deepdive');
      return;
    }
    delete c._deepDivePending;
    if (d && d.deepDive) { c.deepDive = d.deepDive; c._deepDiveFailed = false; }
    else c._deepDiveFailed = (d && d.error) || true;
    if (ui.companyId === id && parseHash().tab === 'deepdive') renderTabPanel(c, 'deepdive');   // live-refresh if they're watching it
  } catch (_) {
    const c = companyById(id); if (c) { delete c._deepDivePending; c._deepDiveFailed = true; }
  }
}

// Kick off the Deep Dive for a deal that finished WITHOUT this tab running the build itself —
// i.e. a GitHub-Actions (or any server-side) job we only saw complete via polling. The core memo
// stored its IM text server-side, so startDeepDive({}) lets the worker rebuild the inputs. Best-
// effort and idempotent: skips samples, deals that already have a Deep Dive, or one already running.
function maybeAutoDeepDive(c) {
  if (!c || isSample(c) || c.deepDive || c._deepDivePending || c._deepDiveFailed) return;
  startDeepDive(c.id, c._ddInputs || {});
}

/* ---- Excel Analysis pass — a twin of the Deep Dive, pointed at the EXCEL model instead of the IM.
 * Reuses the exact same background-build plumbing (GA-aware, poller-merged) and the same block
 * renderer. Everything mirrors the deep-dive trio above; the only differences are the endpoint,
 * the flags (_excelPending/_excelFailed/_xaPendingSince) and the stored field (c.excelAnalysis). */
function retryExcelAnalysis(id) {
  const c = companyById(id);
  if (!c) return;
  c._excelPending = true; c._excelFailed = false; c._xaAutoTried = true;
  if (ui.companyId === id && parseHash().tab === 'excel') renderTabPanel(c, 'excel');
  startExcelAnalysis(id, c._xaInputs || {});
}

async function startExcelAnalysis(id, payload) {
  try {
    const res = await fetch(apiUrl('excel-analysis'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, ...payload }) });
    let buf = '';
    if (res.body && res.body.getReader) { const rd = res.body.getReader(), dec = new TextDecoder(); for (;;) { const { done, value } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); } buf += dec.decode(); }
    else buf = await res.text();
    let d = {}; try { d = JSON.parse((buf.split('\n').pop() || '').trim()); } catch { /* leave as {} */ }
    const c = companyById(id);
    if (!c) return;
    if (d && d.queued && d.excel) {
      // GA mode: the analysis builds in GitHub Actions (patiently waiting out Bedrock). Keep it
      // pending; the poller merges it in when the worker stores it on the company.
      c._excelPending = true; c._excelFailed = false; c._xaPendingSince = Date.now();
      ensureJobPolling();
      if (ui.companyId === id && parseHash().tab === 'excel') renderTabPanel(c, 'excel');
      return;
    }
    delete c._excelPending;
    if (d && d.excelAnalysis) { c.excelAnalysis = d.excelAnalysis; c._excelFailed = false; }
    else c._excelFailed = (d && d.error) || true;
    if (ui.companyId === id && parseHash().tab === 'excel') renderTabPanel(c, 'excel');   // live-refresh if they're watching it
  } catch (_) {
    const c = companyById(id); if (c) { delete c._excelPending; c._excelFailed = true; }
  }
}

function maybeAutoExcelAnalysis(c) {
  if (!c || isSample(c) || c.excelAnalysis || c._excelPending || c._excelFailed) return;
  c._xaAutoTried = true;
  startExcelAnalysis(c.id, c._xaInputs || {});
}

// Cancel a build in progress: abort this tab's request, drop the card, and clear the server record.
// (The server may still finish a build already in flight — if a deal lands anyway, it's removable.)
function cancelJob(id) {
  const job = state.jobs.find(j => j.id === id);
  if (!job) return;
  job._cancelled = true; job.status = 'cancelled'; job._streaming = false;
  try { job._abort && job._abort.abort(); } catch (_) {}
  state.jobs = state.jobs.filter(j => j.id !== id);
  emitJobs();
  try { fetch(apiUrl('jobs/' + encodeURIComponent(id)), { method: 'DELETE' }).catch(() => {}); } catch (_) {}
  toast('Build cancelled');
}

// Discard a finished/failed job card from the pipeline (does not touch the memo).
function dismissJob(id) {
  const job = state.jobs.find(j => j.id === id);
  state.jobs = state.jobs.filter(j => j.id !== id);
  emitJobs();
  // Best-effort remove the durable server record so a dismissed failure doesn't reappear on reload.
  // (A successful build has no server record, so this is a harmless no-op for 'done' jobs.)
  if (job && job.status !== 'done') { try { fetch(apiUrl('jobs/' + encodeURIComponent(id)), { method: 'DELETE' }).catch(() => {}); } catch (_) {} }
}

// On load, bring the server's build records into the in-memory job list so a build's outcome
// (failed, or still in flight) is visible after a reload or on another device — the pipeline cards
// and the 🔔 render straight from state.jobs. A "running" record with no live tab driving it (older
// than 15 min) is treated as stopped, so a dead build never spins forever.
function hydrateServerJobs(list) {
  if (!Array.isArray(list)) return;
  const now = Date.now(), STALE = 15 * 60 * 1000;
  list.forEach(sj => {
    if (!sj || !sj.id || sj.status === 'done' || state.jobs.some(j => j.id === sj.id)) return;   // 'done' → the deal already shows; never duplicate
    let status = sj.status === 'running' ? 'running' : 'error';
    let error = sj.error || 'The build didn’t finish — please try again.';
    if (status === 'running' && (now - (sj.startedAt || now)) > STALE) {
      status = 'error'; error = 'The build was interrupted before it finished (the tab may have been closed) — please try again.';
    }
    state.jobs.push({
      id: sj.id, name: sj.name || 'New deal', sector: sj.sector || '',
      status, stageIdx: 3, startedAt: sj.startedAt || now, finishedAt: sj.finishedAt || null,
      company: null, error, seen: true, fromServer: true,
    });
  });
  ensureJobPolling();   // a hydrated "running" build keeps being watched until it resolves
}

/* ---- No-interruption layer ------------------------------------------------------
 * A build runs SERVER-SIDE: the worker keeps generating even after this tab's
 * connection drops (reload, tab switch, sleep, flaky network), and records the
 * outcome. So instead of depending on one live connection staying open, whenever a
 * build is in flight we POLL the server and reconcile — the finished deal and its
 * pass/fail come from the server's record. Close the tab mid-build, come back, and
 * the card is still there and completes on its own. ------------------------------- */
let _jobPollTO = null;
const anyJobRunning = () => state.jobs.some(j => j.status === 'running') || state.companies.some(c => c && (c._deepDivePending || c._excelPending));
function ensureJobPolling() { if (!_jobPollTO && anyJobRunning()) _jobPollTO = setTimeout(pollJobsOnce, 4000); }
async function pollJobsOnce() {
  _jobPollTO = null;
  if (!anyJobRunning()) return;
  try {
    const res = await fetch(apiUrl('companies'), { cache: 'no-cache' });
    if (res.ok) { const d = await res.json(); if (reconcileJobsFromServer(d)) emitJobs(); }
  } catch (_) { /* transient — keep watching */ }
  if (anyJobRunning()) _jobPollTO = setTimeout(pollJobsOnce, 4000);   // single owner of the timer
}
// Fold the server's truth into the local job list: pull in any newly-finished deals and
// flip each in-flight job to done / error based on its server record.
// IMPORTANT: KV is eventually consistent — a build's record can take up to ~a minute to become
// visible to these reads. So we NEVER fail a job just because its record isn't visible yet; a
// running job only ends on a decisive signal (an 'error'/'done' record, or the finished deal
// itself appearing), the reload staleness check, or a long hard cap. And a job whose live stream
// is still running in THIS tab is owned by that stream — the poller won't race it.
function reconcileJobsFromServer(d) {
  let changed = false;
  const scById = {}; if (Array.isArray(d.companies)) d.companies.forEach(sc => { if (sc && sc.id) scById[sc.id] = sc; });
  if (Array.isArray(d.companies)) d.companies.forEach(sc => {
    if (!sc || !sc.id) return;
    const local = companyById(sc.id);
    if (!local) { addCompany(sc); changed = true; return; }
    // A GA deep dive that finished server-side → merge it into the open dashboard and stop waiting.
    if (local._deepDivePending && sc.deepDive) {
      local.deepDive = sc.deepDive; delete local._deepDivePending; delete local._ddPendingSince; local._deepDiveFailed = false; changed = true;
      if (ui.companyId === sc.id && parseHash().tab === 'deepdive') renderTabPanel(local, 'deepdive');
    }
    // Same for a GA Excel analysis that finished server-side.
    if (local._excelPending && sc.excelAnalysis) {
      local.excelAnalysis = sc.excelAnalysis; delete local._excelPending; delete local._xaPendingSince; local._excelFailed = false; changed = true;
      if (ui.companyId === sc.id && parseHash().tab === 'excel') renderTabPanel(local, 'excel');
    }
  });
  // A deep dive / Excel analysis that never lands (e.g. Bedrock down for a long time) shouldn't spin forever.
  state.companies.forEach(c => {
    if (c && c._deepDivePending && c._ddPendingSince && Date.now() - c._ddPendingSince > 16 * 60 * 1000) {
      delete c._deepDivePending; delete c._ddPendingSince; c._deepDiveFailed = true; changed = true;
      if (ui.companyId === c.id && parseHash().tab === 'deepdive') renderTabPanel(c, 'deepdive');
    }
    if (c && c._excelPending && c._xaPendingSince && Date.now() - c._xaPendingSince > 16 * 60 * 1000) {
      delete c._excelPending; delete c._xaPendingSince; c._excelFailed = true; changed = true;
      if (ui.companyId === c.id && parseHash().tab === 'excel') renderTabPanel(c, 'excel');
    }
  });
  const byId = {}; (Array.isArray(d.jobs) ? d.jobs : []).forEach(j => { if (j && j.id) byId[j.id] = j; });
  const norm = s => String(s || '').trim().toLowerCase();
  const now = Date.now();
  const claimed = new Set(state.jobs.map(j => j.company && j.company.id).filter(Boolean));
  state.jobs.forEach(j => {
    if (j.status !== 'running' || j._streaming) return;   // a live stream in this tab owns its own job
    const sj = byId[j.id];
    if (sj && sj.status === 'error') { j.status = 'error'; j.error = sj.error || 'The build failed — please try again.'; j.finishedAt = sj.finishedAt || now; changed = true; return; }
    if (sj && sj.status === 'done') {
      j.status = 'done'; j.error = null; j.finishedAt = sj.finishedAt || now;
      // A regenerate rebuilds an EXISTING deal in place — the local copy is now stale, so pull the
      // server's fresh version in and re-render it if the partner is looking at it.
      const fresh = scById[sj.companyId];
      if (j._regen && fresh) { addCompany(fresh); if (ui.companyId === fresh.id) renderView(); }
      j.company = companyById(sj.companyId) || j.company; maybeAutoDeepDive(j.company); maybeAutoExcelAnalysis(j.company); changed = true; return;
    }
    // No decisive record yet. If the finished deal itself has shown up (matched by the name the
    // partner typed), treat it as done — otherwise keep waiting (do NOT fail on a missing record).
    // Skip this for a regenerate: its deal ALREADY exists by that name, so a name-match would falsely
    // complete it against the stale copy — a regen only finishes on a decisive done/error record.
    if (!j._regen && j.name && j.name !== 'New deal') {
      const m = state.companies.find(c => !isSample(c) && !claimed.has(c.id) && (norm(c.name) === norm(j.name) || norm(c.shortName) === norm(j.name)));
      if (m) { j.status = 'done'; j.error = null; j.finishedAt = now; j.company = m; claimed.add(m.id); maybeAutoDeepDive(m); maybeAutoExcelAnalysis(m); changed = true; return; }
    }
    // Only a build well past the worker's own limits (record never resolved) is treated as stuck.
    if (now - (j.startedAt || now) > 16 * 60 * 1000) { j.status = 'error'; j.error = 'This build ran too long — please try again.'; j.finishedAt = now; changed = true; }
  });
  return changed;
}

/* ---- Lazy-load pdf.js + SheetJS the first time a partner uploads ---- */
let _libsPromise = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some(s => s.src === src)) return resolve();
    const el = document.createElement('script');
    el.src = src; el.onload = () => resolve(); el.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(el);
  });
}
function ensureUploadLibs() {
  if (!_libsPromise) {
    _libsPromise = Promise.all([loadScript(PDFJS_SRC), loadScript(XLSX_SRC)])
      .then(() => { if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; })
      .catch(err => { _libsPromise = null; throw err; });   // let a retry re-attempt
  }
  return _libsPromise;
}

const companyById = id => state.companies.find(c => c.id === id);

/* -----------------------------------------------------------------------------
 * 4. Router — hash drives which screen shows (deep-link + refresh friendly)
 *    ''                 → pipeline
 *    '#attero'          → company, Snapshot
 *    '#attero/financials' → company, Financials tab
 * ---------------------------------------------------------------------------*/
const TABS = [
  { key: 'snapshot',   label: 'Snapshot',   icon: 'clipboard'  },
  { key: 'deepdive',   label: 'Deep Dive',  icon: 'bookOpen'   },
  { key: 'financials', label: 'Financials', icon: 'barChart'   },
  { key: 'excel',      label: 'Excel Analysis', icon: 'gauge'  },
  { key: 'fit',        label: 'Fit',        icon: 'target'     },
  { key: 'integrity',  label: 'Integrity',  icon: 'shield'     },
  { key: 'questions',  label: 'Questions',  icon: 'help'       },
  { key: 'thesis',     label: 'Thesis',     icon: 'lightbulb'  },
  { key: 'comps',      label: 'Comps',      icon: 'scale'      },
  { key: 'returns',    label: 'Returns',    icon: 'trendingUp' },
];
// All tabs are built; none carry a "coming soon" dot.
// (renderComingSoon remains as a harmless fallback for any unknown tab key.)
const LIVE_TABS = ['snapshot', 'deepdive', 'financials', 'excel', 'fit', 'integrity', 'questions', 'thesis', 'comps', 'returns'];
const TAB_KEYS = TABS.map(t => t.key);
const TAB_META = Object.fromEntries(TABS.map(t => [t.key, t]));

function parseHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, '')).trim();
  if (!raw) return { screen: 'pipeline' };
  const [id, tab] = raw.split('/');
  return { screen: 'company', id, tab: tab || 'snapshot' };
}

function route() {
  hideTip();
  const r = parseHash();
  const c = r.screen === 'company' ? companyById(r.id) : null;
  if (!c) { showPipeline(); return; }                     // unknown/empty → home
  const tab = TAB_KEYS.includes(r.tab) ? r.tab : 'snapshot';
  showCompany(c, tab);
}

function navigate(hash) {
  if (location.hash === hash) route();   // same hash won't fire hashchange → force
  else location.hash = hash;             // fires hashchange → route()
}
function openCompany(id) { if (companyById(id)) navigate('#' + id); }   // pipeline card / dropdown hook
function goHome() { if (location.hash) location.hash = ''; else route(); }

/* -----------------------------------------------------------------------------
 * 5. Header wiring (company dropdown + brand-home + export placeholder)
 * ---------------------------------------------------------------------------*/
function initHeaderIcons() {
  $('#company-dd-ico').innerHTML = icon('building', 'w-4 h-4');
  $('#company-dd-chev').innerHTML = icon('chevronDown', 'w-4 h-4');
  $('#export-ico').innerHTML = icon('download', 'w-4 h-4');
  const ec = $('#export-chev'); if (ec) ec.innerHTML = icon('chevronDown', 'w-4 h-4');
  const bi = $('#bell-ico'); if (bi) bi.innerHTML = icon('bell', 'w-[18px] h-[18px]', 1.9);
}

/* ---- Notifications bell — announces memos finished in the background ---- */
let _bellLastDone = 0;
function bellNotifs() {
  // newest first; running jobs also listed so the partner sees progress here too
  return [...state.jobs].reverse();
}
function updateBell() {
  const badge = $('#bell-badge'), btn = $('#bell-btn');
  if (!badge || !btn) return;
  const unseenDone = state.jobs.filter(j => (j.status === 'done' || j.status === 'error') && !j.seen).length;
  const running = state.jobs.filter(j => j.status === 'running').length;
  const n = unseenDone;
  badge.textContent = n;
  badge.classList.toggle('hidden', n === 0);
  // ring the bell once when a new memo finishes
  const doneCount = state.jobs.filter(j => j.status === 'done').length;
  if (doneCount > _bellLastDone) { btn.classList.remove('ring'); void btn.offsetWidth; btn.classList.add('ring'); }
  _bellLastDone = doneCount;
  if (!badge.classList.contains('hidden') || running) btn.setAttribute('data-active', '1'); else btn.removeAttribute('data-active');
  // keep an open panel fresh
  if (!$('#bell-menu').classList.contains('hidden')) renderBellPanel();
}
function renderBellPanel() {
  const menu = $('#bell-menu');
  const list = bellNotifs();
  if (!list.length) { menu.innerHTML = '<div class="bell-empty">No memos in progress.<br>Upload a deal and it builds here.</div>'; return; }
  menu.innerHTML = list.map(j => {
    if (j.status === 'running') {
      return `<div class="notif click" data-watch-job="${j.id}"><span class="notif-ic" style="color:#fff;background:linear-gradient(140deg,#2E6FD6,#0C3078)">${icon('loader', 'w-4 h-4')}</span>
        <div class="notif-body"><div class="notif-title">${esc(j.name)}</div><div class="notif-sub">Building your memo… <span class="job-el" data-el="${j.id}">${jobElapsed(j)}</span></div><div class="notif-cta">${icon('trendingUp', 'w-3.5 h-3.5')} View progress</div></div>
        <button class="notif-x" data-cancel="${j.id}" aria-label="Cancel build">${icon('x', 'w-4 h-4')}</button></div>`;
    }
    if (j.status === 'error') {
      return `<div class="notif"><span class="notif-ic" style="color:#fff;background:#F43F5E">${icon('alert', 'w-4 h-4')}</span>
        <div class="notif-body"><div class="notif-title">${esc(j.name)}</div><div class="notif-sub">Couldn't build the memo. ${esc(j.error || '')}</div><button class="notif-cta" data-retry="${j.id}" type="button">${icon('refreshCw', 'w-3.5 h-3.5')} Try again</button></div>
        <button class="notif-x" data-dismiss="${j.id}" aria-label="Dismiss">${icon('x', 'w-4 h-4')}</button></div>`;
    }
    return `<div class="notif click" data-view-job="${j.company ? j.company.id : ''}"><span class="notif-ic" style="color:#fff;background:linear-gradient(140deg,#14B8A6,#10B981)">${icon('check', 'w-4 h-4', 3)}</span>
      <div class="notif-body"><div class="notif-title">${esc(j.name)} — memo ready</div><div class="notif-sub">Built in ${jobElapsed(j)}</div><div class="notif-cta">${icon('trendingUp', 'w-3.5 h-3.5')} View memo</div></div>
      <button class="notif-x" data-dismiss="${j.id}" aria-label="Dismiss">${icon('x', 'w-4 h-4')}</button></div>`;
  }).join('');
  menu.querySelectorAll('[data-view-job]').forEach(el => el.addEventListener('click', e => {
    if (e.target.closest('[data-dismiss]')) return;
    const id = el.dataset.viewJob; closeBell(); if (id) openCompany(id);
  }));
  menu.querySelectorAll('[data-dismiss]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); dismissJob(b.dataset.dismiss); }));
  menu.querySelectorAll('[data-retry]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); const id = b.dataset.retry; closeBell(); dismissJob(id); openAddDealModal(); }));
  menu.querySelectorAll('[data-watch-job]').forEach(el => el.addEventListener('click', e => {
    if (e.target.closest('[data-dismiss]') || e.target.closest('[data-cancel]')) return;
    const j = state.jobs.find(x => x.id === el.dataset.watchJob); closeBell(); if (j) openAddDealModal({ watchJob: j });
  }));
  menu.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); cancelJob(b.dataset.cancel); }));
}
function openBell() {
  $('#bell-menu').classList.remove('hidden');
  $('#bell-btn').setAttribute('aria-expanded', 'true');
  state.jobs.forEach(j => { if (j.status !== 'running') j.seen = true; });   // opening acknowledges finished ones
  renderBellPanel();
  updateBell();
}
function closeBell() { $('#bell-menu').classList.add('hidden'); $('#bell-btn').setAttribute('aria-expanded', 'false'); }

function populateCompanyDropdown() {
  const menu = $('#company-dd-menu');
  menu.innerHTML =
    `<div class="dd-head">Jump to a company</div>` +
    state.companies.map(c => `
      <button class="dd-item" role="menuitem" type="button" data-company="${esc(c.id)}">
        <span class="monogram-mini" style="width:32px;height:32px;font-size:11px">${esc(c.monogram || '')}</span>
        <span class="min-w-0">
          <span class="block text-[13.5px] font-semibold text-ink truncate">${esc(c.shortName || c.name)}</span>
          <span class="block text-[11.5px] text-ink-hint truncate">${esc(c.project)} · ${esc(c.sector)}</span>
        </span>
      </button>`).join('');

  menu.querySelectorAll('.dd-item').forEach(btn =>
    btn.addEventListener('click', () => { closeDropdown(); openCompany(btn.dataset.company); }));
}

// Highlight the company currently open (if any) in the dropdown.
function updateDropdownActive() {
  $$('#company-dd-menu .dd-item').forEach(it =>
    it.classList.toggle('is-current', it.dataset.company === ui.companyId));
}

function openDropdown()  { $('#company-dd-menu').classList.remove('hidden'); $('#company-dd-btn').setAttribute('aria-expanded', 'true');  $('#company-dd-chev').style.transform = 'rotate(180deg)'; }
function closeDropdown() { $('#company-dd-menu').classList.add('hidden');    $('#company-dd-btn').setAttribute('aria-expanded', 'false'); $('#company-dd-chev').style.transform = ''; }

function initHeader() {
  initHeaderIcons();
  const btn = $('#company-dd-btn');
  btn.addEventListener('click', e => {
    e.stopPropagation();
    $('#company-dd-menu').classList.contains('hidden') ? openDropdown() : closeDropdown();
  });
  document.addEventListener('click', e => { if (!e.target.closest('#company-dd')) closeDropdown(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDropdown(); });

  // Notifications bell.
  const bell = $('#bell-btn');
  bell.addEventListener('click', e => { e.stopPropagation(); $('#bell-menu').classList.contains('hidden') ? openBell() : closeBell(); });
  document.addEventListener('click', e => { if (!e.target.closest('#bell')) closeBell(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeBell(); });
  updateBell();
  // one shared 1s ticker keeps every "elapsed" label live (bell panel + pipeline cards)
  setInterval(() => {
    if (!state.jobs.some(j => j.status === 'running')) return;
    $$('[data-el]').forEach(el => { const j = state.jobs.find(x => x.id === el.dataset.el); if (j) el.textContent = jobElapsed(j); });
  }, 1000);

  // Brand acts as a "home" link back to the pipeline.
  const brand = $('#brand-home');
  brand.addEventListener('click', goHome);
  brand.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goHome(); } });

  // Export → the Full report (comprehensive, every tab in one document). This is now a single
  // one-click action. The Memo replica (renderMemoExact) is kept in the code but no longer offered
  // in the UI — to bring it back, restore the two-item dropdown menu here and re-wire openEx/closeEx.
  const exportBtn = $('#export-btn');
  exportBtn.classList.remove('is-disabled');
  exportBtn.removeAttribute('data-tip');
  exportBtn.removeAttribute('aria-disabled');
  exportBtn.removeAttribute('aria-haspopup');
  const exMenu = $('#export-menu');
  if (exMenu) { exMenu.innerHTML = ''; exMenu.classList.add('hidden'); }   // no dropdown any more
  const exChev = $('#export-chev'); if (exChev) exChev.style.display = 'none';   // single action → drop the caret
  exportBtn.addEventListener('click', e => { e.stopPropagation(); exportPdf('report'); });
}

/* ---- Export ---------------------------------------------------------------
 * Chrome IGNORES window.print() inside a sandboxed iframe ("the document is
 * sandboxed and the 'allow-modals' keyword is not set") — it does not throw, so
 * the old try/catch never saw it and Export looked dead when the dashboard is
 * embedded. Three routes, tried in order, so one of them always works:
 *   1. a new top-level tab holding a self-contained copy that prints itself
 *      (the whole point: a fresh top-level document is never sandboxed by us),
 *   2. this document's own print dialog — watched via `beforeprint`, which is
 *      the only reliable way to tell that a print() was swallowed,
 *   3. an in-app preview the partner can read, print, download or pop out.
 * ---------------------------------------------------------------------------*/
const isEmbedded = () => { try { return window.self !== window.top; } catch (_) { return true; } };
const PRINT_KEY = () => (/Mac|iP(hone|ad)/.test(navigator.platform || '') ? '⌘P' : 'Ctrl+P');

// A standalone HTML document carrying the same styles, so the memo looks identical
// in a new tab or a downloaded file. <base> keeps the logo's relative src working.
function exportDocHtml(c, doc, body) {
  const css = $$('style').map(s => s.textContent).join('\n');
  const links = $$('link[rel="stylesheet"]').map(l => l.outerHTML).join('\n');
  const title = `${c.shortName || c.name} — ${doc === 'report' ? 'Screening report' : 'Screening memo'}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<base href="${esc(document.baseURI)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${links}
<style>${css}</style>
<style>
  body { background:#fff; margin:0; padding:18px 16px 44px; }
  .xp-bar { display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap;
            max-width:190mm; margin:0 auto 18px; padding-bottom:12px; border-bottom:1px solid #E7EAF1; }
  .xp-hint { font:500 12.5px Inter,system-ui,sans-serif; color:#6B7280; }
  .xp-print { font:600 13.5px Inter,system-ui,sans-serif; color:#fff; background:#0C3078; border:0;
              border-radius:9px; padding:9px 16px; cursor:pointer; }
  @media print { .xp-bar { display:none !important; } body { padding:0; } }
</style></head>
<body>
  <div class="xp-bar">
    <span class="xp-hint">Choose <b>Save as PDF</b> in the print dialog. If it didn't open, use the button.</span>
    <button class="xp-print" type="button" onclick="window.print()">Print / Save as PDF</button>
  </div>
  ${body}
  <script>window.addEventListener('load',function(){setTimeout(function(){try{window.focus();window.print();}catch(e){}},400);});<\/script>
</body></html>`;
}

// Route 1 — a new top-level tab. Returns false when the browser blocked it.
function openPrintWindow(html) {
  let w = null;
  try { w = window.open('', '_blank'); } catch (_) { w = null; }
  if (!w || !w.document) return false;
  try { w.document.open(); w.document.write(html); w.document.close(); w.focus(); return true; }
  catch (_) { try { w.close(); } catch (__) {} return false; }
}

// Route 2 — print this document. `beforeprint` fires synchronously before the
// dialog, so if it hasn't fired shortly after the call, the print was swallowed.
function printSelf(onBlocked) {
  let fired = false;
  const mark = () => { fired = true; };
  let mql = null;
  const onMql = e => { if (e.matches) fired = true; };
  window.addEventListener('beforeprint', mark);
  try { mql = window.matchMedia('print'); if (mql.addEventListener) mql.addEventListener('change', onMql); } catch (_) { mql = null; }
  try { window.print(); } catch (_) { /* swallowed below */ }
  setTimeout(() => {
    window.removeEventListener('beforeprint', mark);
    if (mql && mql.removeEventListener) mql.removeEventListener('change', onMql);
    if (!fired && onBlocked) onBlocked();
  }, 700);
}

// Route 3 — read it right here, with every escape hatch on the bar.
function openPrintPreview(c, doc, body, html) {
  const name = `${(c.shortName || c.name || 'memo').replace(/[^\w.-]+/g, '-')}-${doc}.html`;
  const overlay = h(`
    <div class="modal-overlay pv-overlay" role="dialog" aria-modal="true" aria-label="Document preview">
      <div class="pv">
        <div class="pv-bar">
          <div class="pv-title">${esc(doc === 'report' ? 'Full report' : 'Memo')} · ${esc(c.shortName || c.name)}</div>
          <div class="pv-actions">
            <button class="pv-btn primary" type="button" data-pv="print">${icon('download', 'w-4 h-4')}<span>Print / Save as PDF</span></button>
            <button class="pv-btn" type="button" data-pv="tab">Open in a new tab</button>
            <button class="pv-btn" type="button" data-pv="download">Download</button>
            <button class="pv-btn" type="button" data-pv="close" aria-label="Close">${icon('x', 'w-4 h-4')}</button>
          </div>
        </div>
        <div class="pv-page"><div class="pv-sheet">${body}</div></div>
      </div>
    </div>`);

  const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 200); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  const act = {
    close,
    print: () => printSelf(() => toast(`Your browser blocked printing here — try “Open in a new tab”, or press ${PRINT_KEY()}`)),
    tab: () => { if (!openPrintWindow(html)) toast('Your browser blocked the new tab — allow pop-ups for this page'); },
    download: () => {
      try {
        const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        const a = document.createElement('a');
        a.href = url; a.download = name; a.rel = 'noopener';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        toast('Saved — open the file and print it to PDF');
      } catch (_) { toast('Download blocked here — try “Open in a new tab”'); }
    },
  };
  overlay.querySelectorAll('[data-pv]').forEach(b => b.addEventListener('click', () => act[b.dataset.pv]()));
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  $('#modal-root').appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
}

function exportPdf(kind) {
  const c = companyById(ui.companyId);
  if (!c) { toast('Open a company first, then export it'); return; }
  const doc = kind === 'report' ? 'report' : 'memo';
  const body = doc === 'report' ? renderFullReport(c) : renderMemoExact(c);

  // Keep #print-root loaded either way: it's what a plain Ctrl+P prints.
  const root = $('#print-root');
  root.setAttribute('data-doc', doc);
  root.innerHTML = body;

  const html = exportDocHtml(c, doc, body);
  const preview = () => openPrintPreview(c, doc, body, html);
  if (isEmbedded()) {
    if (openPrintWindow(html)) return;      // best route when the app sits in an iframe
    printSelf(preview);
  } else {
    printSelf(preview);                     // standalone: the native dialog is the nicest path
  }
}

/* -----------------------------------------------------------------------------
 * PDF export — a print-optimised 2-page screening memo (no PDF library).
 * Reads the same company object; the whole layout lives in #print-root and is
 * only visible under @media print (see index.html print CSS).
 * ---------------------------------------------------------------------------*/
/* ======================= MEMO — exact replica of Paragon's template ========
 * Their memo is in INR mn with bordered label/content rows, navy-header tables
 * and table-style checklists. Faithful to Screening_Memo_Attero. ============ */
const toMn = v => (v == null ? null : Math.round(v * 10));    // our data is ₹ cr → INR mn
const MEMO_FIN_ROWS = [
  { key: 'revenue',           label: 'Revenue',                     kind: 'mn' },
  { key: 'growthPct',         label: 'YoY growth',                  kind: 'pct',  sub: true },
  { key: 'grossMarginPct',    label: 'Gross Margin',                kind: 'pct',  sub: true },
  { key: 'ebitda',            label: 'EBITDA',                      kind: 'mn' },
  { key: 'ebitdaPct',         label: 'EBITDA %',                    kind: 'pct',  sub: true },
  { key: 'pat',               label: 'PAT',                         kind: 'mn' },
  { key: 'patPct',            label: 'PAT %',                       kind: 'pct',  sub: true },
  { key: 'capex',             label: 'Capex',                       kind: 'mn' },
  { key: 'operatingCashflow', label: 'Operating Cashflow (post WC)', kind: 'mn' },
  { key: 'fcf',               label: 'FCF (OCF less Capex)',        kind: 'mn' },
  { key: 'roePct',            label: 'RoE',                         kind: 'pct' },
  { key: 'rocePct',           label: 'RoCE (pre tax)',              kind: 'pct' },
  { key: 'nwcDays',           label: 'NWC Days (on sales)',         kind: 'days' },
  { key: 'cash',              label: 'Cash',                        kind: 'mn' },
  { key: 'netWorth',          label: 'Net-worth',                   kind: 'mn' },
  { key: 'debt',              label: 'Debt',                        kind: 'mn' },
];
function mxCell(v, kind) {
  if (v == null) return '<td>-</td>';
  if (kind === 'pct')  return `<td class="${v < 0 ? 'neg' : ''}">${v}%</td>`;
  if (kind === 'days') return `<td>${fmtNum(v)}</td>`;
  const mn = toMn(v);
  return `<td class="${mn < 0 ? 'neg' : ''}">${fmtNum(mn)}</td>`;
}
function memoFinTable(c) {
  const fin = c.financials;
  if (!fin || !Array.isArray(fin.years)) return '';
  const years = fin.years, cagr = fin.cagr || {}, cagrCols = Array.isArray(fin.cagrCols) ? fin.cagrCols : [];
  const head = '<tr><th class="lft">Financials <i>(INR mn)</i></th>' + years.map(y => `<th>${esc(y)}</th>`).join('') +
    cagrCols.map(cc => `<th class="cg"><i>CAGR ${esc(cc)}</i></th>`).join('') + '</tr>';
  const body = MEMO_FIN_ROWS.filter(r => Array.isArray(fin.rows[r.key])).map(r => {
    const arr = fin.rows[r.key];
    const cells = years.map((_, i) => mxCell(arr[i], r.kind)).join('');
    const cg = cagrCols.map((_, ci) => (r.kind === 'mn' && cagr[r.key]) ? `<td class="cg">${cagr[r.key][ci] == null ? 'NM' : Math.round(cagr[r.key][ci] * 100) + '%'}</td>` : '<td class="cg"></td>').join('');
    return `<tr class="${r.sub ? 'it' : ''}"><td class="lft">${esc(r.label)}</td>${cells}${cg}</tr>`;
  }).join('');
  return `<table class="mx-tbl"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}
function memoSegTable(c, mode) {   // mode: 'mn' | 'pct'
  const seg = c.financials && c.financials.segments;
  if (!seg || !Array.isArray(seg.rows) || !seg.rows.length) return '';
  const years = c.financials.years;
  const totals = years.map((_, i) => seg.rows.reduce((s, r) => s + (Number(r.values && r.values[i]) || 0), 0));
  const title = mode === 'pct' ? 'Segment revenue <i>(%)</i>' : 'Segment revenue <i>(INR mn)</i>';
  const head = `<tr><th class="lft">${title}</th>` + years.map(y => `<th>${esc(y)}</th>`).join('') + '</tr>';
  const body = seg.rows.map(r => {
    const cells = years.map((_, i) => {
      const v = r.values && r.values[i];
      if (v == null) return '<td>-</td>';
      return mode === 'pct' ? `<td>${totals[i] ? Math.round(v / totals[i] * 100) : 0}%</td>` : `<td>${fmtNum(toMn(v))}</td>`;
    }).join('');
    return `<tr><td class="lft">${esc(r.name)}</td>${cells}</tr>`;
  }).join('');
  const tot = `<tr class="tot"><td class="lft">Total revenue</td>${years.map((_, i) => `<td>${mode === 'pct' ? '100%' : fmtNum(toMn(totals[i]))}</td>`).join('')}</tr>`;
  return `<table class="mx-tbl" style="margin-top:10px"><thead>${head}</thead><tbody>${body}${tot}</tbody></table>`;
}
function memoCapacity(c) {
  const cap = c.financials && c.financials.capacity;
  if (!cap || !Array.isArray(cap.rows) || !cap.rows.length) return '';
  const years = c.financials.years;
  const head = `<tr><th class="lft">Capacity <i>(${esc(cap.unit || 'MT')})</i></th>` + years.map(y => `<th>${esc(y)}</th>`).join('') + '</tr>';
  const body = cap.rows.map(r => {
    let tr = `<tr><td class="lft">${esc(r.name)}</td>${years.map((_, i) => { const v = r.values && r.values[i]; return v == null ? '<td>-</td>' : `<td>${fmtNum(v)}</td>`; }).join('')}</tr>`;
    if (Array.isArray(r.utilPct)) tr += `<tr class="it"><td class="lft">Utilisation %</td>${years.map((_, i) => { const u = r.utilPct[i]; return u == null ? '<td>-</td>' : `<td>${u}%</td>`; }).join('')}</tr>`;
    return tr;
  }).join('');
  return `<table class="mx-tbl" style="margin-top:10px"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}
function memoQuestions(c) {
  if (!Array.isArray(c.questions) || !c.questions.length) return '';
  return c.questions.map(q => `<div class="mx-q"><div class="mx-q-h">${esc(q.theme)}</div><ul>${(q.items || []).map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>`).join('');
}
function memoGov(c) {
  const rows = (c.integrity || []).map(it => {
    const mk = it.status === 'clear' ? '✓' : it.status === 'flag' ? '⚠' : '○';
    return `<tr><td class="lft">${esc(it.area)}</td><td class="ctr">${mk}</td><td class="lft">- ${esc(it.finding)}</td></tr>`;
  }).join('');
  return `<table class="mx-tbl mx-chk"><thead><tr><th>Area</th><th>Outcome</th><th>Key Findings</th></tr></thead><tbody>${rows}</tbody></table>`;
}
function memoStrategy(c) {
  const list = c.fitChecklist || [];
  const yn = s => s === 'yes' ? 'Yes' : s === 'no' ? 'No' : '';
  let body = '';
  ['Business', 'Promoter'].forEach(g => {
    const rows = list.filter(x => x.group === g);
    if (!rows.length) return;
    body += `<tr class="cat"><td class="lft" colspan="3">${esc(g)}</td></tr>`;
    body += rows.map(x => `<tr><td class="lft">${esc(x.label)}</td><td class="ctr">${yn(x.status)}</td><td class="lft">- ${esc(x.note || '')}</td></tr>`).join('');
  });
  const fit = FIT[c.fit && c.fit.verdict] || FIT.watch;
  body += `<tr class="cat"><td class="lft">Overall Fitment to the Strategy</td><td class="ctr">${esc(fit.label)}</td><td class="lft">- ${esc(c.fit ? c.fit.reason : '')}</td></tr>`;
  return `<table class="mx-tbl mx-chk"><thead><tr><th>Area</th><th>Yes/No</th><th>Comments</th></tr></thead><tbody>${body}</tbody></table>`;
}
function memoThesis(c) {
  const rows = (c.thesis && c.thesis.length ? c.thesis : [{}, {}, {}]).map(x =>
    `<tr><td class="lft">${x.point ? esc(x.point) : ''}</td><td class="lft">${x.detail ? '- ' + esc(x.detail) : ''}</td></tr>`).join('');
  return `<table class="mx-tbl mx-chk"><thead><tr><th>Thesis</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table>`;
}
function memoIssues(c) {
  const rows = (c.concerns && c.concerns.length ? c.concerns : [{}, {}, {}]).map(x =>
    `<tr><td class="lft">${x.issue ? esc(x.issue) : ''}</td><td class="lft">${x.detail ? '- ' + esc(x.detail) : ''}</td><td class="lft">${x.mitigant ? '- ' + esc(x.mitigant) : ''}</td></tr>`).join('');
  return `<table class="mx-tbl mx-chk"><thead><tr><th>Issue</th><th>Description</th><th>Possible Mitigants</th></tr></thead><tbody>${rows}</tbody></table>`;
}
// Comps + returns for the Paragon MEMO replica (mx-tbl style).
function memoReturns(c) {
  if (!c.returns) return '';
  const v = returnsInputs(c), out = computeReturns(c, v);
  const cr = n => (n == null || isNaN(n)) ? '—' : fmtCr(Math.round(n));
  const hc = Number(v.underdeliverPct) > 0 ? ` (−${v.underdeliverPct}%)` : '';
  const eB = retBasis(v.entryBasis), xB = retBasis(v.exitBasis);
  const rows = [
    ['Our cheque (primary)', cr(out.investment)],
    ['Enter → exit', `${v.entryYear} → ${v.exitYear} (${out.years} yr${out.years === 1 ? '' : 's'})`],
    [`Entry ${eB.mult}`, `${v.entryX}× on ${cr(out.entryMetric)} ${eB.label}`],
    ['Our stake', (out.stakePct * 100).toFixed(1) + '%'],
    [`Exit ${xB.mult}`, `${v.exitX}× on ${cr(out.exitMetric)} ${xB.label}${hc}`],
    ['Our proceeds', cr(out.proceeds)],
    ['Money multiple (MoIC)', out.moneyBack.toFixed(1) + '×'],
    ['Annual return (IRR)', Math.round(out.yearlyReturn) + '%'],
  ].map(([k, val]) => `<tr><td class="lft">${esc(k)}</td><td class="lft">${esc(val)}</td></tr>`).join('');
  return `<table class="mx-tbl mx-chk"><thead><tr><th class="lft">Returns — base case (management projections)</th><th class="lft">Value</th></tr></thead><tbody>${rows}</tbody></table>`;
}
function memoComps(c) {
  if (!hasComps(c)) return '';
  const k = compsData(c);
  const cr = v => (v == null || isNaN(v)) ? '—' : fmtCr(v);
  const pct = v => (v == null || isNaN(v)) ? '—' : v + '%';
  const mult = v => (v == null || isNaN(v)) ? '—' : (Math.round(v * 10) / 10) + '×';
  let out = '';
  const pb = k.peerBenchmark;
  if (pb && hasRows(pb.rows)) {
    const self = (pb.self && pb.self.name) ? `<tr class="tot"><td class="lft">${esc(pb.self.name)} (the deal)</td><td>${cr(pb.self.revenueCr)}</td><td>${pct(pb.self.revenueGrowthPct)}</td><td>${pct(pb.self.ebitdaPct)}</td><td>${pct(pb.self.patPct)}</td></tr>` : '';
    const rows = pb.rows.map(r => `<tr><td class="lft">${esc(r.name)}</td><td>${cr(r.revenueCr)}</td><td>${pct(r.revenueGrowthPct)}</td><td>${pct(r.ebitdaPct)}</td><td>${pct(r.patPct)}</td></tr>`).join('');
    out += `<div class="mx-h3">Peer benchmarking — operating metrics</div><table class="mx-tbl"><thead><tr><th class="lft">Company</th><th>Revenue</th><th>Growth</th><th>EBITDA %</th><th>PAT %</th></tr></thead><tbody>${self}${rows}</tbody></table>`;
  }
  const tr = k.trading;
  if (tr && hasRows(tr.rows)) {
    const medE = peerMedian(tr.rows.map(r => r.evEbitda)), medR = peerMedian(tr.rows.map(r => r.evRevenue)), medP = peerMedian(tr.rows.map(r => r.pe));
    const rows = tr.rows.map(r => `<tr><td class="lft">${esc(r.name)}${r.ticker ? ` (${esc(r.ticker)})` : ''}</td><td>${cr(r.marketCapCr)}</td><td>${cr(r.revenueCr)}</td><td>${pct(r.ebitdaPct)}</td><td>${mult(r.evEbitda)}</td><td>${mult(r.evRevenue)}</td><td>${mult(r.pe)}</td></tr>`).join('');
    const med = (medE != null || medR != null || medP != null) ? `<tr class="tot"><td class="lft">Median</td><td></td><td></td><td></td><td>${mult(medE)}</td><td>${mult(medR)}</td><td>${mult(medP)}</td></tr>` : '';
    out += `<div class="mx-h3">Trading comps — listed peers (valuation)</div><table class="mx-tbl"><thead><tr><th class="lft">Company</th><th>Mkt cap</th><th>Revenue</th><th>EBITDA %</th><th>EV/EBITDA</th><th>EV/Rev</th><th>P/E</th></tr></thead><tbody>${rows}${med}</tbody></table>`;
  }
  const tx = k.transactions;
  if (tx && hasRows(tx.rows)) {
    const medE = peerMedian(tx.rows.map(r => r.evEbitda)), medR = peerMedian(tx.rows.map(r => r.evRevenue));
    const rows = tx.rows.map(r => `<tr><td>${esc(r.date || '—')}</td><td class="lft">${esc(r.target || '—')}</td><td class="lft">${esc(r.buyer || '—')}</td><td class="lft">${esc(r.seller || '—')}</td><td>${esc(r.dealType || '—')}</td><td>${r.stakePct != null ? r.stakePct + '%' : '—'}</td><td>${esc(r.dealValue || '—')}</td><td>${mult(r.evEbitda)}</td><td>${mult(r.evRevenue)}</td></tr>`).join('');
    const med = (medE != null || medR != null) ? `<tr class="tot"><td></td><td class="lft">Median</td><td></td><td></td><td></td><td></td><td></td><td>${mult(medE)}</td><td>${mult(medR)}</td></tr>` : '';
    out += `<div class="mx-h3">Transaction comps — past deals (valuation)</div><table class="mx-tbl"><thead><tr><th>Date</th><th class="lft">Target</th><th class="lft">Buyer</th><th class="lft">Seller</th><th>Type</th><th>Sought</th><th>Deal value</th><th>EV/EBITDA</th><th>EV/Rev</th></tr></thead><tbody>${rows}${med}</tbody></table>`;
  }
  return out;
}
function renderMemoExact(c) {
  const s = c.snapshot || {}, t = c.transaction || {}, o = c.origination || {};
  const memoDate = c.generatedAt ? fmtDate(c.generatedAt) : (fmtDate(o.date) || '');
  const coInv = (t.coInvestment && t.coInvestment !== 'TBD') ? t.coInvestment : 'Yes / No';
  const li = arr => (arr || []).map(x => `<li>${x}</li>`).join('');
  const overviewBul = [];
  if (s.whatTheyDo) overviewBul.push(esc(s.whatTheyDo));
  (s.businessBullets || []).forEach(b => overviewBul.push(esc(b)));
  const personLi = p => {
    const nm = personName(p), role = esc(p.role || ''), note = p.note ? ' — ' + esc(p.note) : '';
    return nm ? `<b>${esc(nm)}</b>${role ? ` (${role})` : ''}${note}` : `<b>${role || 'To be confirmed'}</b>${note}`;
  };
  const promoters = (s.promoters || []).map(personLi);
  const mgmt = (s.management || []).map(personLi);
  const row = (label, body) => `<div class="mx-row"><div class="mx-row-l">${esc(label)}</div><div class="mx-row-b">${body}</div></div>`;

  return `
    <div class="mx">
      <div class="mx-head">
        <img src="assets/paragon-logo.png" class="mx-logo" alt="Paragon Partners"/>
        <div class="mx-title">${esc(c.name)}${memoDate ? ` <span>(${esc(memoDate)})</span>` : ''}</div>
        <div style="width:150px"></div>
      </div>

      ${row('Company', esc(c.name))}
      ${row('Sector', esc(c.sector || '-'))}
      ${row('Transaction Overview', `${esc(t.headline || '-')}<div>Co-Investment: <span class="mx-hl">${esc(coInv)}</span></div>`)}
      ${row('Origination', `<ul class="tight"><li>Date: ${esc(fmtDate(o.date) || 'TBU')}</li>${o.banker ? `<li>Source: ${esc(o.banker)}</li>` : ''}${o.advisors ? `<li>Advisors: ${esc(o.advisors)}</li>` : ''}</ul>`)}
      ${overviewBul.length ? row('Company Overview', `<ul>${li(overviewBul)}</ul>`) : ''}
      ${promoters.length ? row('Promoter Overview', `<ul>${li(promoters)}</ul>`) : ''}
      ${mgmt.length ? row('Mgmt Overview', `<ul>${li(mgmt)}</ul>`) : ''}

      <div class="mx-grp">
        ${memoFinTable(c)}
        ${memoSegTable(c, 'mn')}
        ${memoSegTable(c, 'pct')}
        ${memoCapacity(c)}
      </div>

      <div class="mx-grp">
        ${Array.isArray(c.questions) && c.questions.length ? `<div class="mx-h2">Key Questions</div>${memoQuestions(c)}` : ''}
        <div class="mx-h2">Governance Checklist</div>
        ${memoGov(c)}
        <div class="mx-h2">Strategy Checklist</div>
        ${memoStrategy(c)}
      </div>

      <div class="mx-grp">
        <div class="mx-h2 center">Section II – After First Management Meeting</div>
        <div class="mx-h3">Investment Thesis</div>
        ${memoThesis(c)}
        <div class="mx-h3">Issues for Consideration</div>
        ${memoIssues(c)}
      </div>

      ${(hasComps(c) || c.returns) ? `
      <div class="mx-grp">
        ${hasComps(c) ? `<div class="mx-h2">Peers &amp; Comparables</div>${memoComps(c)}` : ''}
        ${c.returns ? `<div class="mx-h2">Illustrative Returns</div>${memoReturns(c)}` : ''}
      </div>` : ''}

      <div class="mx-foot">Private &amp; Confidential</div>
    </div>`;
}

/* ======================= FULL REPORT — comprehensive branded document ======= */
function frReturns(c) {
  if (!c.returns) return '';
  const v = returnsInputs(c);
  const out = computeReturns(c, v);
  const cr = n => n == null ? '—' : fmtCr(Math.round(n));
  const hc = Number(v.underdeliverPct) > 0 ? ` (−${v.underdeliverPct}%)` : '';
  const eB = retBasis(v.entryBasis), xB = retBasis(v.exitBasis);
  const entryBuild = eB.equity
    ? `${cr(out.entryMetric)} × ${v.entryX}× = ${cr(out.preMoney)} equity`
    : `${cr(out.entryMetric)} × ${v.entryX}× = ${cr(out.entryEV)} EV`;
  const exitBuild = xB.equity
    ? `${cr(out.exitMetric)} × ${v.exitX}× = ${cr(out.exitEquity)} equity`
    : `${cr(out.exitMetric)} × ${v.exitX}× = ${cr(out.exitEV)} EV`;
  const rows = [
    [`Our cheque (primary)`, cr(out.investment)],
    [`Enter in / exit in`, `${esc(v.entryYear)} → ${esc(v.exitYear)} (${out.years} yr${out.years === 1 ? '' : 's'})`],
    [`Entry ${eB.label} × ${eB.mult}`, entryBuild],
    [`Pre-money / post-money equity`, `${cr(out.preMoney)} / ${cr(out.postMoney)}`],
    [`Our stake`, (out.stakePct * 100).toFixed(1) + '%'],
    [`Exit ${xB.label} × ${xB.mult}${hc}`, exitBuild],
    [`Our proceeds`, cr(out.proceeds)],
  ].map(([k, val]) => `<tr><td>${esc(k)}</td><td class="num">${esc(val)}</td></tr>`).join('');
  const tiles = `
    <div class="fr-ret-tiles">
      <div class="fr-ret-tile hero"><span class="k">Money multiple</span><span class="v">${out.moneyBack > 0 ? out.moneyBack.toFixed(1) + '×' : '—'}</span></div>
      <div class="fr-ret-tile hero"><span class="k">Annual return (IRR)</span><span class="v">${out.yearlyReturn > -100 ? Math.round(out.yearlyReturn) + '%' : '—'}</span></div>
      <div class="fr-ret-tile"><span class="k">Hold</span><span class="v">${out.years} yr${out.years === 1 ? '' : 's'}<small> ${esc(v.entryYear)}→${esc(v.exitYear)}</small></span></div>
      <div class="fr-ret-tile"><span class="k">Our stake</span><span class="v">${(out.stakePct * 100).toFixed(1)}%<small> for ${cr(out.investment)}</small></span></div>
    </div>`;
  const impl = `<div class="fr-cap" style="margin-top:12px">Implied entry multiples vs. the trading-comps median:</div><div class="peer-scroll">${impliedMultiplesHTML(c, out)}</div>`;
  const sens = `
    <div class="fr-cap" style="margin-top:12px">Sensitivity — all scenarios (entry multiple × exit / under-delivery):</div>
    <div class="sens-stack">
      <div><div class="sens-h">1 · MoIC — entry × exit</div><div class="peer-scroll">${sensiGridHTML(c, v, 'exit', 'moic')}</div></div>
      <div><div class="sens-h">2 · IRR — entry × exit</div><div class="peer-scroll">${sensiGridHTML(c, v, 'exit', 'irr')}</div></div>
      <div><div class="sens-h">3 · IRR — entry × management under-delivery</div><div class="peer-scroll">${sensiGridHTML(c, v, 'under', 'irr')}</div></div>
    </div>`;
  return `${tiles}<div class="fr-cap">How the money multiple is built (entry on ${eB.mult}, exit on ${xB.mult}):</div><table class="fr-facts">${rows}</table>${impl}${sens}`;
}
// Peer comps for the FULL REPORT only (never the memo/Word-replica). Small 3-col
// table, target highlighted, peer-median line. Empty string when no peers.
function hasPeers(c) { return !!(c.peers && Array.isArray(c.peers.rows) && c.peers.rows.length); }
function frPeerComps(c) {
  if (!hasPeers(c)) return '';
  const p = c.peers, unit = p.unit || '';
  const fmtVal = v => v == null ? '—' : (unit === '%' ? v + '%' : v + (unit || ''));
  const median = peerMedian(p.rows.map(r => r.value));
  const metricHdr = esc(p.metric) + (unit === 'x' ? ' (×)' : unit === '%' ? ' (%)' : '');
  const tag = l => `<span class="fr-peer-tag ${l ? 'lst' : 'prv'}">${l ? 'Listed' : 'Private'}</span>`;
  const selfRow = (p.self && p.self.name)
    ? `<tr class="fr-peer-self"><td>${esc(p.self.name)} <span class="fr-peer-you">the deal</span></td><td>${tag(!!p.self.listed)}</td><td class="num">${fmtVal(p.self.value)}</td></tr>` : '';
  const rows = p.rows.map(r => `<tr><td>${esc(r.name)}${r.ticker ? ` <span class="fr-peer-tick">${esc(r.ticker)}</span>` : ''}</td><td>${tag(!!r.listed)}</td><td class="num">${fmtVal(r.value)}</td></tr>`).join('');
  const medRow = median != null ? `<tr class="fr-peer-med"><td>Peer median</td><td></td><td class="num">${fmtVal(median)}</td></tr>` : '';
  return `${p.note ? `<p class="fr-cap">${esc(p.note)}</p>` : ''}
    <table class="fr-peer-tbl"><thead><tr><th>Company</th><th>Type</th><th class="num">${metricHdr}</th></tr></thead><tbody>${selfRow}${rows}${medRow}</tbody></table>`;
}
// Comps for the FULL REPORT — peer benchmarking + trading + transaction tables (print style).
function frComps(c) {
  if (!hasComps(c)) return '';
  const k = compsData(c);
  const cr = v => (v == null || isNaN(v)) ? '—' : fmtCr(v);
  const pct = v => (v == null || isNaN(v)) ? '—' : v + '%';
  const mult = v => (v == null || isNaN(v)) ? '—' : (Math.round(v * 10) / 10) + '×';
  let out = '';
  const pb = k.peerBenchmark;
  if (pb && hasRows(pb.rows)) {
    const self = (pb.self && pb.self.name) ? `<tr class="fr-peer-self"><td>${esc(pb.self.name)} <span class="fr-peer-you">the deal</span></td><td class="num">${cr(pb.self.revenueCr)}</td><td class="num">${pct(pb.self.revenueGrowthPct)}</td><td class="num">${pct(pb.self.ebitdaPct)}</td><td class="num">${pct(pb.self.patPct)}</td></tr>` : '';
    const rows = pb.rows.map(r => `<tr><td>${esc(r.name)}${r.ticker ? ` <span class="fr-peer-tick">${esc(r.ticker)}</span>` : ''}</td><td class="num">${cr(r.revenueCr)}</td><td class="num">${pct(r.revenueGrowthPct)}</td><td class="num">${pct(r.ebitdaPct)}</td><td class="num">${pct(r.patPct)}</td></tr>`).join('');
    out += `<h3>Peer benchmarking — operating metrics</h3>${pb.note ? `<p class="fr-cap">${esc(pb.note)}</p>` : ''}<table class="fr-peer-tbl"><thead><tr><th>Company</th><th class="num">Revenue</th><th class="num">Growth</th><th class="num">EBITDA %</th><th class="num">PAT %</th></tr></thead><tbody>${self}${rows}</tbody></table>`;
  }
  const tr = k.trading;
  if (tr && hasRows(tr.rows)) {
    const medE = peerMedian(tr.rows.map(r => r.evEbitda)), medR = peerMedian(tr.rows.map(r => r.evRevenue)), medP = peerMedian(tr.rows.map(r => r.pe));
    const rows = tr.rows.map(r => `<tr><td>${esc(r.name)}${r.ticker ? ` <span class="fr-peer-tick">${esc(r.ticker)}</span>` : ''}</td><td class="num">${cr(r.marketCapCr)}</td><td class="num">${cr(r.revenueCr)}</td><td class="num">${pct(r.ebitdaPct)}</td><td class="num">${mult(r.evEbitda)}</td><td class="num">${mult(r.evRevenue)}</td><td class="num">${mult(r.pe)}</td></tr>`).join('');
    const med = (medE != null || medR != null || medP != null) ? `<tr class="fr-peer-med"><td>Peer median</td><td></td><td></td><td></td><td class="num">${mult(medE)}</td><td class="num">${mult(medR)}</td><td class="num">${mult(medP)}</td></tr>` : '';
    out += `<h3 style="margin-top:10px">Trading comps — listed peers (valuation)</h3>${tr.note ? `<p class="fr-cap">${esc(tr.note)}</p>` : ''}<table class="fr-peer-tbl"><thead><tr><th>Company</th><th class="num">Mkt cap</th><th class="num">Revenue</th><th class="num">EBITDA %</th><th class="num">EV/EBITDA</th><th class="num">EV/Rev</th><th class="num">P/E</th></tr></thead><tbody>${rows}${med}</tbody></table>`;
  }
  const tx = k.transactions;
  if (tx && hasRows(tx.rows)) {
    const medE = peerMedian(tx.rows.map(r => r.evEbitda)), medR = peerMedian(tx.rows.map(r => r.evRevenue));
    const rows = tx.rows.map(r => `<tr><td class="nowrap">${esc(r.date || '—')}</td><td>${esc(r.target || '—')}</td><td>${esc(r.buyer || '—')}</td><td>${esc(r.seller || '—')}</td><td>${esc(r.dealType || '—')}</td><td class="num">${r.stakePct != null ? r.stakePct + '%' : '—'}</td><td class="num">${esc(r.dealValue || '—')}</td><td class="num">${mult(r.evEbitda)}</td><td class="num">${mult(r.evRevenue)}</td></tr>`).join('');
    const med = (medE != null || medR != null) ? `<tr class="fr-peer-med"><td></td><td>Deal median</td><td></td><td></td><td></td><td></td><td></td><td class="num">${mult(medE)}</td><td class="num">${mult(medR)}</td></tr>` : '';
    out += `<h3 style="margin-top:10px">Transaction comps — past deals (valuation)</h3>${tx.note ? `<p class="fr-cap">${esc(tx.note)}</p>` : ''}<table class="fr-peer-tbl"><thead><tr><th>Date</th><th>Target</th><th>Buyer</th><th>Seller</th><th>Type</th><th class="num">% Sought</th><th class="num">Deal value</th><th class="num">EV/EBITDA</th><th class="num">EV/Rev</th></tr></thead><tbody>${rows}${med}</tbody></table>`;
  }
  return out;
}
// Figures-audit block for the printed report — only shown when there's something to flag.
function frFiguresAudit(c) {
  const a = buildFiguresAudit(c);
  const warns = a.items.filter(i => i.level === 'warn');
  if (!warns.length) return '';
  return `<div class="fr-audit warn"><b>⚠ Figures to verify before circulating:</b><ul>${warns.map(i => `<li>${esc(i.text)}</li>`).join('')}</ul></div>`;
}
function renderFullReport(c) {
  const fit = FIT[c.fit && c.fit.verdict] || FIT.watch;
  const s = c.snapshot || {}, t = c.transaction || {}, o = c.origination || {};
  const fy = (c.headline && c.headline.revenueLabel || '');
  const bullets = (s.businessBullets || []).map(b => `<li>${esc(b)}</li>`).join('');
  const people = arr => (arr || []).map(p => {
    const nm = personName(p), role = esc(p.role || ''), note = p.note ? `<span class="nt">${esc(p.note)}</span>` : '';
    const head = nm ? `<b>${esc(nm)}</b><span>${role}</span>` : `<b>${role || 'To be confirmed'}</b>`;
    return `<div class="fr-person">${head}${note}</div>`;
  }).join('');
  const own = (s.ownership || []).map(x => `<tr><td>${esc(x.holder)}</td><td class="num">${x.pct}%</td></tr>`).join('');
  // Auto-numbered so conditional sections (deep-dive, questions, comps, returns)
  // never leave a gap; template `${}` expressions evaluate in source order.
  let _sn = 0;
  const sec = (title, body, cls) => `<section class="fr-sec${cls ? ' ' + cls : ''}"><h2><span class="fr-n">${++_sn}</span>${esc(title)}</h2>${body}</section>`;

  return `
    <div class="fr">
      <div class="fr-cover">
        <div class="fr-cover-top">
          <img src="assets/paragon-logo.png" class="fr-logo" alt="Paragon Partners"/>
          <div class="fr-eyebrow">Screening Report · Private &amp; Confidential</div>
        </div>
        <h1>${esc(c.name)}</h1>
        <div class="fr-sub">${esc(c.project || '')}${c.project ? ' · ' : ''}${esc(c.sector || '')}</div>
        <div class="fr-verdict fr-${esc(c.fit ? c.fit.verdict : 'watch')}"><span class="dot"></span>${fit.label}</div>
        <p class="fr-lede">${esc(c.fit ? c.fit.reason : (c.oneLiner || ''))}</p>
        <div class="fr-stats">
          <div><span class="k">Deal</span><span class="v">${esc(dealHeadline(c))}</span></div>
          <div><span class="k">Origination</span><span class="v">${esc(o.banker || '—')} · ${esc(fmtDate(o.date) || '')}</span></div>
          <div><span class="k">${esc(fy || 'Latest revenue')}</span><span class="v">${fmtCr(c.headline ? c.headline.revenueCr : 0)}</span></div>
          <div><span class="k">EBITDA margin</span><span class="v">${c.headline ? c.headline.ebitdaPct : '—'}%</span></div>
        </div>
      </div>

      ${sec('Business overview', `
        <p>${esc(s.whatTheyDo || c.oneLiner || '')}</p>
        ${bullets ? `<ul class="fr-ul">${bullets}</ul>` : ''}
        <div class="fr-people-grid">
          <div><h3>Promoters</h3>${people(s.promoters)}</div>
          <div><h3>Management</h3>${people(s.management)}</div>
        </div>
        ${own ? `<h3 style="margin-top:12px">Ownership</h3><table class="fr-facts">${own}</table>` : (s.ownershipNote ? `<p class="fr-note">${esc(s.ownershipNote)}</p>` : '')}
      `)}

      ${sec('The deal', `<table class="fr-facts">
        <tr><td>Ask</td><td class="num">${esc(t.headline || '—')}</td></tr>
        <tr><td>Type</td><td class="num">${esc(t.type || '—')}</td></tr>
        <tr><td>Co-investment</td><td class="num">${esc(t.coInvestment || 'TBU')}</td></tr>
        <tr><td>Origination source</td><td class="num">${esc(o.banker || '—')}</td></tr>
        ${o.advisors ? `<tr><td>Advisors (IM)</td><td class="num">${esc(o.advisors)}</td></tr>` : ''}
        <tr><td>Origination date</td><td class="num">${esc(fmtDate(o.date) || '—')}</td></tr>
      </table>`)}

      ${hasDeepDive(c) ? sec('From the Information Memorandum — full briefing', frDeepDive(c), 'fr-sec-dd') : ''}
      ${hasExcelAnalysis(c) ? sec('From the Excel model — analysis', frExcelAnalysis(c), 'fr-sec-dd') : ''}

      ${sec('Financials', `
        <div class="fr-cap">All figures in ₹ crore; tinted columns are forecast.</div>
        ${printFinTable(c)}
        ${printSegments(c)}
      `)}

      ${sec('Fit assessment', `
        <div class="fr-fitline"><span class="fr-verdict sm fr-${esc(c.fit ? c.fit.verdict : 'watch')}"><span class="dot"></span>${fit.label}</span><span>${esc(c.fit ? c.fit.reason : '')}</span></div>
        ${printChecklist(c)}
      `)}

      ${sec('Integrity & governance', printIntegrity(c))}

      ${Array.isArray(c.questions) && c.questions.length ? sec('Key questions', memoQuestions(c).replace(/mx-q/g, 'fr-q')) : ''}

      ${sec('Investment thesis & risks', `
        <div class="fr-cols">
          <div><h3>Why we'd invest</h3>${(c.thesis || []).map(x => `<div class="fr-point"><b>${esc(x.point)}</b><span>${esc(x.detail)}</span></div>`).join('') || '<p class="fr-note">TBU</p>'}</div>
          <div><h3>What worries us</h3>${(c.concerns || []).map(x => `<div class="fr-point"><b>${esc(x.issue)}</b><span>${esc(x.detail)}</span><span class="mit">Mitigant: ${esc(x.mitigant)}</span></div>`).join('') || '<p class="fr-note">TBU</p>'}</div>
        </div>
      `)}

      ${hasComps(c) ? sec('Peers & comparables', frComps(c))
        : (hasPeers(c) ? sec('Peers & comparables', frPeerComps(c)) : '')}

      ${c.returns ? sec('Illustrative returns',
        `<div class="fr-cap">Base case built on management’s own projections — illustrative, not a recommendation.</div>${frReturns(c)}`) : ''}

      <div class="fr-foot">Paragon Partners · Screening Report · Private &amp; Confidential</div>
    </div>`;
}

// Compact segment-revenue table for print (only if segments exist).
function printSegments(c) {
  const seg = c.financials && c.financials.segments;
  if (!seg || !Array.isArray(seg.rows) || !seg.rows.length) return '';
  const fin = c.financials, years = fin.years, cut = years.indexOf(fin.actualsThrough) + 1;
  const totals = years.map((_, i) => seg.rows.reduce((sum, r) => sum + (Number(r.values && r.values[i]) || 0), 0));
  const head = '<tr><th>Segment revenue</th>' + years.map((y, i) => `<th class="${i >= cut ? 'fc' : ''}">${esc(y)}</th>`).join('') + '</tr>';
  const body = seg.rows.map(r => {
    const cells = years.map((y, i) => { const v = r.values && r.values[i], fc = i >= cut ? 'fc' : ''; return v == null ? `<td class="${fc}">—</td>` : `<td class="${fc}">${fmtNum(v)}</td>`; }).join('');
    return `<tr><td>${esc(r.name)}</td>${cells}</tr>`;
  }).join('');
  const totRow = `<tr class="pm-tot"><td>Total</td>${years.map((y, i) => `<td class="${i >= cut ? 'fc' : ''}">${fmtNum(totals[i])}</td>`).join('')}</tr>`;
  return `<table class="pm-tbl" style="margin-top:8px"><thead>${head}</thead><tbody>${body}${totRow}</tbody></table>`;
}

// Compact financials table for print: all years, forecast columns tinted, negatives red.
function printFinTable(c) {
  const fin = c.financials;
  if (!fin || !Array.isArray(fin.years)) return '';
  const years = fin.years, cut = years.indexOf(fin.actualsThrough) + 1;
  const cagr = fin.cagr || {}, cagrCols = Array.isArray(fin.cagrCols) ? fin.cagrCols : [];
  const colspan = years.length + 1 + cagrCols.length;
  const head = '<tr><th></th>' + years.map((y, i) => `<th class="${i >= cut ? 'fc' : ''}">${esc(y)}</th>`).join('') +
    cagrCols.map(cc => `<th class="cg">CAGR<br>${esc(cc)}</th>`).join('') + '</tr>';
  const body = FIN_GROUPS.map(group => {
    const present = group.rows.filter(r => Array.isArray(fin.rows[r.key]));
    if (!present.length) return '';
    const gh = `<tr class="pm-grp"><td colspan="${colspan}">${esc(group.title)}</td></tr>`;
    return gh + present.map(r => {
      const arr = fin.rows[r.key];
      const cells = years.map((y, i) => {
        const v = arr[i], fc = i >= cut ? 'fc' : '';
        if (v == null) return `<td class="${fc}">—</td>`;
        return `<td class="${fc} ${v < 0 ? 'neg' : ''}">${r.kind === 'pct' ? v + '%' : fmtNum(v)}</td>`;
      }).join('');
      const cg = cagrCols.map((cc, ci) => (r.kind === 'cr' && cagr[r.key]) ? `<td class="cg">${cagr[r.key][ci] == null ? 'NM' : Math.round(cagr[r.key][ci] * 100) + '%'}</td>` : '<td class="cg"></td>').join('');
      return `<tr class="${r.sub ? 'pm-subr' : ''}"><td>${esc(r.label)}</td>${cells}${cg}</tr>`;
    }).join('');
  }).join('');
  return `<table class="pm-tbl"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}
function printChecklist(c) {
  const list = c.fitChecklist || [];
  return ['Business', 'Promoter'].map(g => {
    const rows = list.filter(x => x.group === g);
    if (!rows.length) return '';
    return `<div style="font-family:'Sora',sans-serif;font-weight:700;color:#6B7280;font-size:8.5px;text-transform:uppercase;letter-spacing:.05em;margin:6px 0 2px">${esc(g)}</div>` +
      rows.map(x => {
        const st = CHECK_STATUS[x.status] || CHECK_STATUS.tbd;
        const mk = x.status === 'yes' ? '✓' : x.status === 'no' ? '✗' : '–';
        return `<div class="pm-check"><span class="mk" style="color:${st.color}">${mk}</span><span>${esc(x.label)}<span class="nt">${esc(x.note)}</span></span></div>`;
      }).join('');
  }).join('');
}
function printIntegrity(c) {
  return (c.integrity || []).map(it => {
    const st = INTEG_STATUS[it.status] || INTEG_STATUS.pending;
    const mk = it.status === 'clear' ? '✓' : (it.status === 'flag' || it.status === 'risk') ? '⚠' : '○';
    return `<div class="pm-check"><span class="mk" style="color:${st.color}">${mk}</span><span><b>${esc(it.area)}</b><span class="nt">${esc(it.finding)}</span></span></div>`;
  }).join('');
}

/* -----------------------------------------------------------------------------
 * 6. Pipeline landing screen
 * ---------------------------------------------------------------------------*/
function showPipeline() {
  ui.companyId = null;
  renderPipeline();
  updateDropdownActive();
  window.scrollTo({ top: 0 });
}

function renderPipeline() {
  const root = $('#screen');
  root.innerHTML = '';
  root.appendChild(renderPipelineHeader());
  const content = h('<div id="pipeline-content" class="mt-6"></div>');
  root.appendChild(content);
  renderView();
}

// Slim heading row + Cards/Table toggle (deliberately NOT a wall of KPI tiles).
function renderPipelineHeader() {
  const count = state.companies.length;
  const note = (state.meta && state.meta.note) || 'Read before Monday’s meeting';
  const wrap = h(`
    <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div class="min-w-0">
        <div class="flex items-center gap-2.5">
          <span class="grid place-items-center w-9 h-9 rounded-xl text-navy" style="background:${tint(BRAND.navy, .08)};border:1px solid ${tint(BRAND.navy, .12)}">
            ${icon('briefcase', 'w-5 h-5')}
          </span>
          <h1 class="font-display text-[22px] sm:text-[24px] font-semibold text-ink leading-none">Deal Pipeline</h1>
          <span class="count-chip">${count} ${count === 1 ? 'deal' : 'deals'}</span>
        </div>
        <p class="mt-2 text-[13.5px] text-ink-muted">${esc(note)}</p>
      </div>
      <div class="shrink-0 flex items-center gap-3">
        <div class="seg" role="tablist" aria-label="View">
          <button class="seg-btn" data-view="table" role="tab">${icon('table', 'w-4 h-4')}<span>Table</span></button>
          <button class="seg-btn" data-view="cards" role="tab">${icon('grid', 'w-4 h-4')}<span>Cards</span></button>
        </div>
        <button class="add-deal-btn" type="button" data-add-deal>${icon('plus', 'w-4 h-4', 2.4)}<span>Add a deal</span></button>
      </div>
    </div>`);

  wrap.querySelectorAll('.seg-btn').forEach(b => {
    b.classList.toggle('is-active', b.dataset.view === state.view);
    b.setAttribute('aria-selected', String(b.dataset.view === state.view));
    b.addEventListener('click', () => setView(b.dataset.view));
  });
  wrap.querySelector('[data-add-deal]').addEventListener('click', openAddDealModal);
  return wrap;
}

function setView(view) {
  if (view === state.view) return;
  state.view = view;
  $$('#screen .seg-btn').forEach(b => {
    const on = b.dataset.view === view;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', String(on));
  });
  renderView();
}

// Render just the content area (cards or table) for the current view.
function renderView() {
  destroyCharts();
  hideTip();
  const content = $('#pipeline-content');
  content.innerHTML = '';
  const activeJobs = state.jobs.filter(j => j.status === 'running' || j.status === 'error');
  if (activeJobs.length) content.appendChild(renderJobCards(activeJobs));
  if (!state.companies.length && !activeJobs.length) { content.appendChild(renderEmptyState()); return; }
  if (state.companies.length) {
    content.appendChild(state.view === 'cards' ? renderCards() : renderTable());
    if (state.view === 'cards') requestAnimationFrame(initSparklines);
  }
}

// "Processing…" cards for in-flight/failed uploads, shown above the pipeline.
function renderJobCards(jobs) {
  const wrap = h('<div class="space-y-3 mb-5"></div>');
  jobs.forEach(j => wrap.appendChild(renderJobCard(j)));
  return wrap;
}
function renderJobCard(j) {
  if (j.status === 'error') {
    const el = h(`<div class="job-card err">
      <span class="job-spin">${icon('alert', 'w-4 h-4')}</span>
      <div class="min-w-0" style="flex:1 1 auto"><div class="job-name">${esc(j.name)}</div><div class="job-status">Couldn't build the memo — ${esc(j.error || '')}</div></div>
      <button class="job-btn" data-retry="${j.id}">Try again</button>
      <button class="job-btn" data-dismiss="${j.id}">Dismiss</button>
    </div>`);
    el.querySelector('[data-retry]').addEventListener('click', () => { dismissJob(j.id); openAddDealModal(); });
    el.querySelector('[data-dismiss]').addEventListener('click', () => dismissJob(j.id));
    return el;
  }
  const pct = [12, 34, 56, 82][j.stageIdx] || 12;
  const label = ['Reading the Information Memorandum', 'Reading the financial model', 'Analysing the numbers & fit', 'Writing your screening memo'][j.stageIdx] || 'Working';
  const el = h(`<div class="job-card is-clickable" role="button" tabindex="0" aria-label="Open build progress for ${esc(j.name)}">
    <span class="job-spin">${icon('loader', 'w-4 h-4')}</span>
    <div class="min-w-0"><div class="job-name">${esc(j.name)}</div><div class="job-status">${esc(label)}… · <span class="job-el" data-el="${j.id}">${jobElapsed(j)}</span></div></div>
    <div class="job-bar"><span style="width:${pct}%"></span></div>
    <button class="job-btn job-cancel" type="button" data-cancel>Cancel</button>
    <span class="job-open">${icon('arrowRight', 'w-4 h-4')}</span>
  </div>`);
  const open = () => openAddDealModal({ watchJob: j });
  el.addEventListener('click', e => { if (e.target.closest('[data-cancel]')) return; open(); });
  el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  el.querySelector('[data-cancel]').addEventListener('click', e => { e.stopPropagation(); cancelJob(j.id); });
  return el;
}

/* ---- Cards view ---- */
function renderCards() {
  const grid = h('<div class="grid gap-5 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3"></div>');
  state.companies.forEach(c => grid.appendChild(renderDealCard(c)));
  grid.appendChild(renderAddDealCard());
  return grid;
}

// Deal-size wording (decision #3): the full headline is the source of truth.
// Cards show the amount prominently + type, with the full headline on hover.
function dealAmount(c)   { const hl = c.transaction && c.transaction.headline; return (hl ? hl.split('—')[0] : '').trim() || fmtCr(c.transaction.amountCr); }
function dealHeadline(c) { return (c.transaction && c.transaction.headline) || fmtCr(c.transaction.amountCr); }

function renderDealCard(c) {
  const fit = FIT[c.fit && c.fit.verdict] || FIT.watch;
  const sc = sectorColor(c.sectorTag);
  const card = h(`
    <article class="deal-card" style="--accent:${sc}" role="button" tabindex="0"
             aria-label="Open ${esc(c.shortName || c.name)}">
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <div class="monogram-badge">${esc(c.monogram || '')}</div>
          <div class="min-w-0">
            <h3 class="card-title truncate">${esc(c.shortName || c.name)}${isSample(c) ? ' ' + SAMPLE_TAG : ''}</h3>
            <p class="card-sub truncate">${esc(c.project)}</p>
          </div>
        </div>
        <span class="fit-pill shrink-0" data-tip="${esc(c.fit ? c.fit.reason : '')}"
              style="color:${fit.color};background:${fit.tint}">
          <span class="fit-dot${c.fit && c.fit.verdict === 'go' ? ' pulse' : ''}" style="background:${fit.color}"></span>${fit.label}
        </span>
      </div>

      <div class="mt-3">
        <span class="chip" style="color:${sc};background:${tint(sc, .1)}">
          <span class="chip-dot" style="background:${sc}"></span>${esc(c.sector)}
        </span>
      </div>

      <div class="card-divider"></div>

      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0" data-tip="${esc(dealHeadline(c))}">
          <div class="kicker">Deal size</div>
          <div class="deal-amount tnum">${esc(dealAmount(c))}</div>
          <div class="deal-type truncate">${esc(c.transaction ? c.transaction.type : '')}</div>
        </div>
        <div class="text-right shrink-0">
          <div class="kicker">Sourced by</div>
          <div class="meta-line">${esc(c.origination ? c.origination.banker : '')}</div>
          <div class="meta-sub tnum">${esc(c.origination ? fmtDate(c.origination.date) : '')}</div>
        </div>
      </div>

      <div class="mt-4">
        <div class="flex items-center justify-between">
          <div class="kicker">Revenue trend</div>
          <span class="spark-legend"><span class="legend-line"></span>actual<span class="legend-line dash ml-1"></span>est.</span>
        </div>
        <div class="spark-wrap mt-1.5"><canvas data-spark="${esc(c.id)}"></canvas></div>
        <div class="spark-cap">${esc(c.headline ? c.headline.revenueLabel : '')} <b class="tnum">${fmtCr(c.headline.revenueCr)}</b></div>
      </div>
    </article>`);

  const open = () => openCompany(c.id);
  card.addEventListener('click', open);
  card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  return card;
}

function renderAddDealCard() {
  const el = h(`
    <button class="add-card" type="button" aria-label="Add a deal">
      <span class="plus">${icon('plus', 'w-5 h-5', 2.4)}</span>
      <span class="font-display font-semibold text-[15px]" style="color:inherit">Add a deal</span>
      <span class="text-[12px] text-ink-hint">Upload the IM &amp; Excel model</span>
    </button>`);
  el.addEventListener('click', openAddDealModal);
  return el;
}

/* ---- Table view ---- */
const TABLE_COLS = [
  { key: 'name',    label: 'Company',        num: false },
  { key: 'sector',  label: 'Sector',         num: false },
  { key: 'deal',    label: 'Deal size',      num: true  },
  { key: 'banker',  label: 'Banker',         num: false },
  { key: 'revenue', label: 'Latest revenue', num: true  },
  { key: 'fit',     label: 'Fit',            num: false },
];

function sortValue(c, key) {
  switch (key) {
    case 'name':    return (c.shortName || c.name || '').toLowerCase();
    case 'sector':  return (c.sectorTag || c.sector || '').toLowerCase();
    case 'deal':    return (c.transaction && c.transaction.amountCr) || 0;
    case 'banker':  return (c.origination && c.origination.banker || '').toLowerCase();
    case 'revenue': return (c.headline && c.headline.revenueCr) || 0;
    case 'fit':     return FIT_RANK[c.fit && c.fit.verdict] ?? 9;
    default:        return 0;
  }
}
// Decision #2: default sort is Fit; ties always break by larger deal first.
function sortedCompanies() {
  const { key, dir } = state.sort, mul = dir === 'asc' ? 1 : -1;
  return [...state.companies].sort((a, b) => {
    const av = sortValue(a, key), bv = sortValue(b, key);
    if (av < bv) return -mul;
    if (av > bv) return mul;
    return ((b.transaction && b.transaction.amountCr) || 0) - ((a.transaction && a.transaction.amountCr) || 0);
  });
}

function renderTable() {
  const card = h('<div class="surface-card overflow-hidden"><div class="table-scroll"></div></div>');
  const table = h('<table class="deal-table"></table>');

  const thead = h('<thead><tr></tr></thead>');
  const tr = thead.querySelector('tr');
  TABLE_COLS.forEach(col => {
    const active = state.sort.key === col.key;
    const arrow = active ? (state.sort.dir === 'asc' ? 'arrowUp' : 'arrowDown') : 'sort';
    const th = h(`<th class="${col.num ? 'num ' : ''}${active ? 'is-sorted' : ''}" data-key="${col.key}" scope="col"
                    aria-sort="${active ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">
                    <span class="th-inner">${esc(col.label)}<span class="sort-ico">${icon(arrow, 'w-3.5 h-3.5', 2.4)}</span></span>
                  </th>`);
    th.addEventListener('click', () => toggleSort(col.key));
    tr.appendChild(th);
  });
  table.appendChild(thead);

  const tbody = h('<tbody></tbody>');
  sortedCompanies().forEach(c => tbody.appendChild(renderTableRow(c)));
  table.appendChild(tbody);

  card.querySelector('.table-scroll').appendChild(table);
  return card;   // "Add a deal" now lives in the pipeline header, so no dashed row here
}

function renderTableRow(c) {
  const fit = FIT[c.fit && c.fit.verdict] || FIT.watch;
  const sc = sectorColor(c.sectorTag);
  const fy = (c.headline && c.headline.revenueLabel || '').split(' ')[0]; // "FY25 revenue" → "FY25"
  const row = h(`
    <tr data-company="${esc(c.id)}">
      <td>
        <div class="flex items-center gap-3">
          <span class="monogram-mini">${esc(c.monogram || '')}</span>
          <span class="min-w-0">
            <span class="row-name block truncate">${esc(c.shortName || c.name)}${isSample(c) ? ' ' + SAMPLE_TAG : ''}</span>
            <span class="row-sub block truncate">${esc(c.project)}</span>
          </span>
        </div>
      </td>
      <td><span class="chip" style="color:${sc};background:${tint(sc, .1)}"><span class="chip-dot" style="background:${sc}"></span>${esc(c.sector)}</span></td>
      <td class="num" data-tip="${esc(dealHeadline(c))}"><span class="row-name tnum">${fmtCr(c.transaction.amountCr)}</span><span class="row-sub">${esc(c.transaction.type)}</span></td>
      <td><span class="row-name">${esc(c.origination.banker)}</span><span class="row-sub tnum">${esc(fmtDate(c.origination.date))}</span></td>
      <td class="num"><span class="row-name tnum">${fmtCr(c.headline.revenueCr)}</span><span class="row-sub">${esc(fy)}</span></td>
      <td>
        <span class="fit-pill" data-tip="${esc(c.fit ? c.fit.reason : '')}" style="color:${fit.color};background:${fit.tint}">
          <span class="fit-dot" style="background:${fit.color}"></span>${fit.label}
        </span>
      </td>
    </tr>`);
  row.addEventListener('click', () => openCompany(c.id));
  return row;
}

function toggleSort(key) {
  if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
  else state.sort = { key, dir: key === 'deal' || key === 'revenue' ? 'desc' : 'asc' };
  renderView();
}

/* -----------------------------------------------------------------------------
 * 7. Company view (Phases 2–3)
 * ---------------------------------------------------------------------------*/
function showCompany(c, tab) {
  const shellExists = !!$('#company-shell');
  const sameCompany = shellExists && ui.companyId === c.id;
  ui.companyId = c.id;
  ui.tab = tab;
  // Carry-over decision: each time a company opens, Financials starts on the
  // Table view (the table is the hero). Forecast preference is left as-is.
  if (!sameCompany) ui.fin.view = 'table';
  if (!sameCompany) renderCompanyShell(c);   // rebuild identity + tabs only when company changes
  setActiveTab(tab);
  renderTabPanel(c, tab);
  updateDropdownActive();
  if (!sameCompany) window.scrollTo({ top: 0 });
}

// Identity strip + tab bar + empty panel.
function renderCompanyShell(c) {
  destroyCharts();
  hideTip();
  const root = $('#screen');
  root.innerHTML = '';
  const shell = h('<div id="company-shell" class="space-y-5"></div>');

  const topRow = h('<div class="flex items-center justify-between gap-3"></div>');
  const back = h(`<button class="back-btn" type="button">${icon('arrowLeft', 'w-4 h-4', 2.4)}<span>Pipeline</span></button>`);
  back.addEventListener('click', goHome);
  topRow.appendChild(back);
  // Every deal can be removed — uploads are deleted; samples are hidden.
  const rm = h(`<button class="rm-btn" type="button">${icon('trash', 'w-4 h-4')}<span>${isSample(c) ? 'Remove sample' : 'Remove deal'}</span></button>`);
  rm.addEventListener('click', () => removeCompany(c));
  topRow.appendChild(rm);
  shell.appendChild(topRow);

  shell.appendChild(renderIdentityStrip(c));
  shell.appendChild(renderTabBar(c));
  shell.appendChild(h('<div id="tab-panel"></div>'));
  root.appendChild(shell);
}

// ---- Figures self-audit: catch unit / scale mistakes (the ₹385cr-shown-as-₹38cr class of bug) ----
// Runs deterministic sanity checks that need NO AI cooperation, plus surfaces the AI's own
// figuresAudit reconciliation against the CIM. Returns { level:'warn'|'ok'|'none', items:[…] }.
function buildFiguresAudit(c) {
  const items = [];                                   // { level:'warn'|'ok', text }
  const rnd = n => '₹' + Math.round(Number(n)).toLocaleString('en-IN') + 'cr';
  const fin = c.financials || {}, rows = fin.rows || {}, yrs = Array.isArray(fin.years) ? fin.years : [];
  const rev = Array.isArray(rows.revenue) ? rows.revenue : [];
  const idxA = yrs.indexOf(fin.actualsThrough);
  const latestRev = (idxA >= 0 && rev[idxA] != null) ? rev[idxA] : [...rev].reverse().find(v => v != null);
  const peakRev = rev.reduce((m, v) => (v != null && v > m ? v : m), 0);
  const ask = Number((c.returns && c.returns.investmentCr) || (c.transaction && c.transaction.amountCr) || 0);
  const fa = (c.figuresAudit && typeof c.figuresAudit === 'object') ? c.figuresAudit : null;
  const near = (r, k) => r > 0 && Math.abs(r - k) / k < 0.25;

  // 1) The AI's own reconciliation against the CIM's stated revenue.
  if (fa) {
    const m = Number(fa.modelRevenueCr), s = Number(fa.imStatedRevenueCr);
    if (m > 0 && s > 0) {
      const ratio = m / s;
      if (near(ratio, 10) || near(ratio, 0.1) || near(ratio, 100) || near(ratio, 0.01)) {
        const f = ratio > 1 ? Math.round(ratio) + '×' : '1/' + Math.round(1 / ratio) + '×';
        items.push({ level: 'warn', text: `Model revenue ${rnd(m)} vs the CIM's stated ${rnd(s)} — off by ~${f}. Almost always a unit misread (crore ↔ lakh ↔ million). Re-check the reporting unit and regenerate.` });
      } else {
        items.push({ level: 'ok', text: `Revenue ${rnd(m)} reconciles with the CIM's stated ${rnd(s)}.` });
      }
    }
    if (fa.revenueConsistent === false && !items.some(i => i.level === 'warn')) {
      items.push({ level: 'warn', text: `Figures audit flagged a scale mismatch: ${esc(fa.note || 'model and document disagree on scale')}.` });
    }
    if (fa.unitSource) items.push({ level: 'ok', text: `Figures taken from ${esc(fa.unitSource)}.` });
  }

  // 2) Deterministic sanity — works on ANY deal, even without an AI audit block.
  if (ask > 0 && latestRev > 0 && ask / latestRev > 3) {
    items.push({ level: 'warn', text: `The raise (${rnd(ask)}) is ${(ask / latestRev).toFixed(1)}× the latest revenue (${rnd(latestRev)}) — unusually high for growth equity; check whether the revenue units are 10× too small.` });
  }
  if (ask > 0 && peakRev > 0 && ask > peakRev) {
    items.push({ level: 'warn', text: `The raise (${rnd(ask)}) is larger than the peak projected revenue (${rnd(peakRev)}) — a classic sign the financials were scaled 10× too small.` });
  }
  try {
    const out = computeReturns(c, returnsInputs(c));
    if (out.stakePct > 0.6) items.push({ level: 'warn', text: `At these figures the cheque implies a ~${Math.round(out.stakePct * 100)}% stake — far too high for a minority deal; the entry value (EBITDA/revenue) is likely scaled wrong.` });
  } catch (_) {}

  const warns = items.filter(i => i.level === 'warn');
  const level = warns.length ? 'warn' : (items.length ? 'ok' : 'none');
  // De-dupe identical texts, warnings first.
  const seen = new Set();
  const ordered = [...warns, ...items.filter(i => i.level === 'ok')].filter(i => (seen.has(i.text) ? false : seen.add(i.text)));
  return { level, items: ordered };
}

function renderFiguresAudit(c) {
  const a = buildFiguresAudit(c);
  if (a.level === 'none') return null;
  const warn = a.level === 'warn';
  const warns = a.items.filter(i => i.level === 'warn');
  const oks = a.items.filter(i => i.level === 'ok');
  const li = arr => arr.map(i => `<li class="fa-${i.level === 'warn' ? 'warn' : 'ok'}">${i.level === 'warn' ? icon('alert', 'w-3.5 h-3.5') : icon('check', 'w-3.5 h-3.5')}<span>${i.text}</span></li>`).join('');
  const head = warn
    ? `${icon('alert', 'w-4 h-4')}<b>Check these figures before sharing</b><span class="fa-count">${warns.length}</span>`
    : `${icon('check', 'w-4 h-4')}<b>Figures self-audit — consistent</b>`;
  const el = h(`
    <div class="fig-audit ${warn ? 'is-warn' : 'is-ok'}">
      <button class="fa-head" type="button" aria-expanded="${warn}">
        <span class="fa-head-l">${head}</span>
        ${icon('chevronDown', 'fa-chev w-4 h-4')}
      </button>
      <div class="fa-body" ${warn ? '' : 'hidden'}>
        <ul class="fa-list">${li(warns)}${li(oks)}</ul>
        ${warn ? `<p class="fa-foot">These are automatic sanity checks (raise vs. revenue, implied stake, unit reconciliation). If a unit looks wrong, fix the model’s unit label or regenerate — don’t send the memo until it clears.</p>` : ''}
      </div>
    </div>`);
  const btn = el.querySelector('.fa-head'), body = el.querySelector('.fa-body');
  btn.addEventListener('click', () => {
    const open = body.hasAttribute('hidden');
    if (open) body.removeAttribute('hidden'); else body.setAttribute('hidden', '');
    btn.setAttribute('aria-expanded', String(open));
  });
  return el;
}

function renderIdentityStrip(c) {
  const fit = FIT[c.fit && c.fit.verdict] || FIT.watch;
  const sc = sectorColor(c.sectorTag);
  return h(`
    <div class="identity">
      <div class="flex items-center gap-3 min-w-0">
        <div class="monogram-badge" style="width:52px;height:52px;border-radius:14px;font-size:18px">${esc(c.monogram || '')}</div>
        <div class="id-block min-w-0">
          <div class="id-name truncate">${esc(c.name)}${isSample(c) ? ' ' + SAMPLE_TAG : ''}</div>
          <div class="id-project truncate">${esc(c.project)}</div>
        </div>
      </div>
      <div class="id-divider"></div>
      <div class="id-block">
        <div class="kicker">Sector</div>
        <span class="chip mt-1" style="color:${sc};background:${tint(sc, .1)}"><span class="chip-dot" style="background:${sc}"></span>${esc(c.sector)}</span>
      </div>
      <div class="id-divider"></div>
      <div class="id-block min-w-0">
        <div class="kicker">The ask</div>
        <div class="meta-line mt-0.5 truncate">${esc(dealHeadline(c))}${(c.transaction && c.transaction.amountSource) ? ` <span class="src-chip ${/assum/i.test(c.transaction.amountSource) ? 'assume' : ''}" title="Where the raise size came from: ${esc(c.transaction.amountSource)}">${icon('info', 'w-3 h-3')}<span>${esc(c.transaction.amountSource)}</span></span>` : ''}</div>
        <div class="meta-sub tnum">${esc(c.origination.banker)} · ${esc(fmtDate(c.origination.date))}</div>
      </div>
      <div class="sm:ml-auto">
        <span class="fit-pill" data-tip="${esc(c.fit ? c.fit.reason : '')}" style="color:${fit.color};background:${fit.tint}">
          <span class="fit-dot${c.fit && c.fit.verdict === 'go' ? ' pulse' : ''}" style="background:${fit.color}"></span>${fit.label}
        </span>
      </div>
    </div>`);
}

function renderTabBar(c) {
  const bar = h('<div class="tabbar" role="tablist" aria-label="Sections"></div>');
  TABS.forEach(t => {
    const soon = !LIVE_TABS.includes(t.key);
    const el = h(`<button class="tab ${soon ? 'is-soon' : ''}" role="tab" data-tab="${t.key}" aria-selected="false">
        ${icon(t.icon, 'tab-ico w-4 h-4')}<span>${esc(t.label)}</span>${soon ? '<span class="soon-dot" title="Coming soon"></span>' : ''}
      </button>`);
    el.addEventListener('click', () => navigate(`#${c.id}/${t.key}`));
    bar.appendChild(el);
  });
  return bar;
}

function setActiveTab(tab) {
  $$('#company-shell .tab').forEach(t => {
    const on = t.dataset.tab === tab;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
}

function renderTabPanel(c, tab) {
  destroyCharts();
  hideTip();
  const panel = $('#tab-panel');
  if (!panel) return;
  panel.innerHTML = '';
  let node;
  if (tab === 'snapshot')        node = renderSnapshot(c);
  else if (tab === 'deepdive')   node = renderDeepDive(c);
  else if (tab === 'financials') node = renderFinancials(c);
  else if (tab === 'excel')      node = renderExcelAnalysis(c);
  else if (tab === 'fit')        node = renderFit(c);
  else if (tab === 'integrity')  node = renderIntegrity(c);
  else if (tab === 'questions')  node = renderQuestions(c);
  else if (tab === 'thesis')     node = renderThesis(c);
  else if (tab === 'comps')      node = renderComps(c);
  else if (tab === 'returns')    node = renderReturns(c);
  else                           node = renderComingSoon(tab);
  panel.appendChild(node);
  requestAnimationFrame(() => initPanelCharts(c));
}

// Small helper: a titled surface card (icon + title + body).
function sectionCard(title, iconName, bodyEl) {
  const el = h(`<section class="surface-card p-5"><div class="section-title"><span class="sec-ico">${icon(iconName, 'w-4 h-4')}</span>${esc(title)}</div></section>`);
  el.appendChild(bodyEl);
  return el;
}

/* ---- 7a. Snapshot tab ---- */
function renderSnapshot(c) {
  const wrap = h('<div class="space-y-5"></div>');
  wrap.appendChild(renderWhatTheyDo(c));

  const row = h('<div class="grid gap-5 lg:grid-cols-2 items-start"></div>');
  row.appendChild(renderDealFacts(c));
  row.appendChild(renderPromoters(c));
  wrap.appendChild(row);

  wrap.appendChild(renderManagement(c));
  wrap.appendChild(renderOwnership(c));
  return wrap;
}

// Paragraph first (full width), facts underneath in a two-up grid. Side-by-side
// columns left a tall dead gap next to the shorter one — the bullets are usually
// far taller than the paragraph.
function renderWhatTheyDo(c) {
  const s = c.snapshot || {};
  const bullets = (s.businessBullets || []).filter(Boolean);
  const body = h('<div></div>');
  if (s.whatTheyDo) body.appendChild(h(`<p class="lede">${esc(s.whatTheyDo)}</p>`));
  if (bullets.length) {
    const chips = h(`<div class="grid gap-2.5 sm:grid-cols-2 ${s.whatTheyDo ? 'mt-4' : ''}"></div>`);
    bullets.forEach(b =>
      chips.appendChild(h(`<span class="bullet-chip"><span class="b-ico">${icon('check', 'w-3.5 h-3.5', 2.6)}</span><span>${esc(b)}</span></span>`)));
    body.appendChild(chips);
  }
  if (!s.whatTheyDo && !bullets.length) body.appendChild(h('<p class="text-[13px] text-ink-hint">No business description in the documents.</p>'));
  return sectionCard('What they do', 'layers', body);
}

function renderDealFacts(c) {
  const t = c.transaction || {}, o = c.origination || {};
  const facts = [
    ['Sector', c.sector],
    ['The ask', t.headline],
    ['Type', t.type],
    ['Co-investment', t.coInvestment || '—'],
    ['Banker', o.banker],
    ['Origination date', fmtDate(o.date)],
  ];
  const table = h('<table class="facts"><tbody></tbody></table>');
  const tb = table.querySelector('tbody');
  facts.forEach(([k, v]) => tb.appendChild(h(`<tr><th>${esc(k)}</th><td>${esc(v == null ? '—' : v)}</td></tr>`)));
  return sectionCard('The deal', 'briefcase', table);
}

function renderPromoters(c) {
  const list = h('<div class="flex flex-col gap-3"></div>');
  (c.snapshot && c.snapshot.promoters || []).forEach(p => {
    const nm = personName(p), role = p.role || '';
    const primary = nm || role || 'To be confirmed';
    list.appendChild(h(`
      <div class="person-card flex items-start gap-3">
        <span class="person-avatar">${esc(personAvatar(primary))}</span>
        <div class="min-w-0">
          <div class="person-name">${esc(primary)}</div>
          ${nm && role ? `<div class="person-role">${esc(role)}</div>` : ''}
          ${p.note ? `<div class="person-note">${esc(p.note)}</div>` : ''}
        </div>
      </div>`));
  });
  return sectionCard('Promoters', 'star', list);
}

function renderManagement(c) {
  const scroll = h('<div class="table-scroll"></div>');
  const table = h(`<table class="mini-table"><thead><tr><th>Name</th><th>Role</th><th>Background</th></tr></thead><tbody></tbody></table>`);
  const tb = table.querySelector('tbody');
  (c.snapshot && c.snapshot.management || []).forEach(m => {
    const nm = personName(m), role = m.role || '';
    // No personal name on the slide → the role IS the identity; show it once, don't duplicate.
    const nameCell = nm || role || '—';
    const roleCell = nm ? role : '';
    tb.appendChild(h(`<tr>
      <td class="font-semibold text-ink whitespace-nowrap">${esc(nameCell)}</td>
      <td class="text-navy font-medium whitespace-nowrap">${esc(roleCell)}</td>
      <td class="text-ink-muted">${m.note ? esc(m.note) : ''}</td>
    </tr>`));
  });
  scroll.appendChild(table);
  return sectionCard('Management', 'users', scroll);
}

// Ownership: doughnut + companion table when `ownership` exists; else a note callout.
function renderOwnership(c) {
  const s = c.snapshot || {};
  const own = s.ownership;
  const body = h('<div></div>');

  if (Array.isArray(own) && own.length) {
    const colors = own.map((_, i) => CHART_PALETTE[i % CHART_PALETTE.length]);
    const grid = h('<div class="grid gap-5 md:grid-cols-2 items-center"></div>');
    grid.appendChild(h('<div class="chart-box" style="height:210px"><canvas data-chart="ownership"></canvas></div>'));
    const rows = own.map((o, i) => `
      <tr>
        <td class="py-1.5 pr-3"><span class="inline-flex items-center gap-2">
          <span style="width:10px;height:10px;border-radius:3px;background:${colors[i]};display:inline-block;flex:0 0 auto"></span>
          <span class="text-[13px] text-ink">${esc(o.holder)}</span></span></td>
        <td class="py-1.5 text-right tnum font-semibold text-ink text-[13px]">${o.pct}%</td>
      </tr>`).join('');
    grid.appendChild(h(`<table class="w-full"><tbody>${rows}</tbody></table>`));
    body.appendChild(grid);
    if (s.ownershipNote) body.appendChild(h(`<p class="text-[12px] text-ink-hint mt-3 leading-relaxed">${esc(s.ownershipNote)}</p>`));
  } else if (s.ownershipNote) {
    body.appendChild(h(`<div class="callout"><span class="co-ico">${icon('info', 'w-4 h-4')}</span><span>${esc(s.ownershipNote)}</span></div>`));
  } else {
    body.appendChild(h('<p class="text-[13px] text-ink-hint">Cap table to be received.</p>'));
  }
  return sectionCard('Ownership', 'pieChart', body);
}

/* ---- 7b. Financials tab ---- */
// Row groups shown in the hero table. A group is skipped entirely if none of its
// rows exist for the company; a row cell is "—" when that year's value is null.
const FIN_GROUPS = [
  { title: 'Profit & Loss', rows: [
    { key: 'revenue',        label: 'Revenue',          kind: 'cr'  },
    { key: 'growthPct',      label: 'YoY growth',       kind: 'pct', bar: true, sub: true },
    { key: 'grossMarginPct', label: 'Gross margin',     kind: 'pct', bar: true, sub: true },
    { key: 'ebitda',         label: 'EBITDA',           kind: 'cr'  },
    { key: 'ebitdaPct',      label: 'EBITDA margin',    kind: 'pct', bar: true, sub: true },
    { key: 'pat',            label: 'PAT (net profit)', kind: 'cr' },
    { key: 'patPct',         label: 'PAT margin',       kind: 'pct', bar: true, sub: true },
  ]},
  { title: 'Cash flow', rows: [
    { key: 'capex',             label: 'Capex',                   kind: 'cr' },
    { key: 'operatingCashflow', label: 'Operating cash flow',     kind: 'cr' },
    { key: 'fcf',               label: 'Free cash flow',          kind: 'cr' },
  ]},
  { title: 'Returns & efficiency', rows: [
    { key: 'roePct',  label: 'Return on equity',  kind: 'pct', bar: true },
    { key: 'rocePct', label: 'Return on capital', kind: 'pct', bar: true },
    { key: 'nwcDays', label: 'Working-capital days', kind: 'days' },
  ]},
  { title: 'Balance sheet', rows: [
    { key: 'cash',     label: 'Cash',      kind: 'cr' },
    { key: 'netWorth', label: 'Net worth', kind: 'cr' },
    { key: 'debt',     label: 'Debt',      kind: 'cr' },
  ]},
];

// Which columns are visible given the forecast toggle.
function finView(c) {
  const fin = c.financials;
  const actualsCut = fin.years.indexOf(fin.actualsThrough) + 1;   // count of actual years
  const n = ui.fin.forecast ? fin.years.length : actualsCut;
  return { fin, years: fin.years.slice(0, n), n, actualsCut, isForecast: i => i >= actualsCut };
}

function renderFinancials(c) {
  const wrap = h('<div class="space-y-5"></div>');
  wrap.appendChild(renderFinControls(c));
  if (ui.fin.view === 'charts') {
    wrap.appendChild(renderFinCharts(c));
  } else {
    wrap.appendChild(renderFinTable(c));
    const seg = renderFinSegments(c); if (seg) wrap.appendChild(seg);
    const cap = renderFinCapacity(c); if (cap) wrap.appendChild(cap);
  }
  return wrap;
}

// Segment revenue over time — ₹ cr or share-of-revenue (%), toggled.
function renderFinSegments(c) {
  const seg = c.financials && c.financials.segments;
  if (!seg || !Array.isArray(seg.rows) || !seg.rows.length) return null;
  const v = finView(c);
  const pct = ui.fin.segPct;
  // column totals (for % mode), across visible years
  const totals = v.years.map((_, i) => seg.rows.reduce((s, r) => s + (Number(r.values && r.values[i]) || 0), 0));

  const card = h('<div class="surface-card overflow-hidden"></div>');
  card.appendChild(h(`
    <div class="seg-head">
      <div><span class="seg-title">Revenue by segment</span>${seg.note ? `<span class="seg-note">${esc(seg.note)}</span>` : ''}</div>
      <div class="switch" role="group" aria-label="Segment units">
        <button data-seg="cr" class="${pct ? '' : 'on'}">₹ cr</button>
        <button data-seg="pct" class="${pct ? 'on' : ''}">% of revenue</button>
      </div>
    </div>`));
  const scroll = h('<div class="fin-scroll"></div>');
  const table = h('<table class="fin"></table>');
  let head = '<thead><tr><th class="rowhead">&nbsp;</th>';
  v.years.forEach((y, i) => head += `<th class="${(v.isForecast(i) ? 'fc' : '') + (i === v.actualsCut ? ' fc-start' : '')}">${esc(y)}</th>`);
  head += '</tr></thead>';
  const tbody = h('<tbody></tbody>');
  seg.rows.forEach((r, ri) => {
    let tr = `<tr><td class="rowhead"><span class="seg-swatch" style="background:${CHART_PALETTE[ri % CHART_PALETTE.length]}"></span>${esc(r.name)}</td>`;
    v.years.forEach((_, i) => {
      const raw = r.values && r.values[i];
      const fcCls = (v.isForecast(i) ? 'fc' : '') + (i === v.actualsCut ? ' fc-start' : '');
      if (raw == null) { tr += `<td class="val muted ${fcCls}">—</td>`; return; }
      tr += pct
        ? `<td class="val ${fcCls}">${totals[i] ? Math.round(raw / totals[i] * 100) : 0}%</td>`
        : `<td class="val ${fcCls}">${fmtNum(raw)}</td>`;
    });
    tbody.appendChild(h(tr + '</tr>'));
  });
  // total row
  let tot = `<tr class="seg-total"><td class="rowhead">Total revenue</td>`;
  v.years.forEach((_, i) => { const fcCls = (v.isForecast(i) ? 'fc' : '') + (i === v.actualsCut ? ' fc-start' : ''); tot += `<td class="val ${fcCls}">${pct ? '100%' : fmtNum(totals[i])}</td>`; });
  tbody.appendChild(h(tot + '</tr>'));
  table.innerHTML = head; table.appendChild(tbody);
  scroll.appendChild(table); card.appendChild(scroll);
  card.querySelectorAll('[data-seg]').forEach(b => b.addEventListener('click', () => { ui.fin.segPct = b.dataset.seg === 'pct'; renderTabPanel(c, 'financials'); }));
  return card;
}

// Capacity & utilisation (installed capacity + how full it runs).
function renderFinCapacity(c) {
  const cap = c.financials && c.financials.capacity;
  if (!cap || !Array.isArray(cap.rows) || !cap.rows.length) return null;
  const v = finView(c);
  const card = h('<div class="surface-card overflow-hidden"></div>');
  card.appendChild(h(`<div class="seg-head"><div><span class="seg-title">Capacity &amp; utilisation</span><span class="seg-note">Installed ${esc(cap.unit || '')} and how full it runs</span></div></div>`));
  const scroll = h('<div class="fin-scroll"></div>');
  const table = h('<table class="fin"></table>');
  let head = '<thead><tr><th class="rowhead">&nbsp;</th>';
  v.years.forEach((y, i) => head += `<th class="${(v.isForecast(i) ? 'fc' : '') + (i === v.actualsCut ? ' fc-start' : '')}">${esc(y)}</th>`);
  head += '</tr></thead>';
  const tbody = h('<tbody></tbody>');
  cap.rows.forEach(r => {
    let tr = `<tr><td class="rowhead">${esc(r.name)}</td>`;
    v.years.forEach((_, i) => { const val = r.values && r.values[i]; const fcCls = (v.isForecast(i) ? 'fc' : '') + (i === v.actualsCut ? ' fc-start' : ''); tr += val == null ? `<td class="val muted ${fcCls}">—</td>` : `<td class="val ${fcCls}">${fmtNum(val)}</td>`; });
    tbody.appendChild(h(tr + '</tr>'));
    if (Array.isArray(r.utilPct)) {
      let ur = `<tr class="subrow"><td class="rowhead">Utilisation</td>`;
      v.years.forEach((_, i) => { const u = r.utilPct[i]; const fcCls = (v.isForecast(i) ? 'fc' : '') + (i === v.actualsCut ? ' fc-start' : ''); ur += u == null ? `<td class="val muted ${fcCls}">—</td>` : `<td class="val ${fcCls}">${u}%</td>`; });
      tbody.appendChild(h(ur + '</tr>'));
    }
  });
  table.innerHTML = head; table.appendChild(tbody);
  scroll.appendChild(table); card.appendChild(scroll);
  return card;
}

function renderFinControls(c) {
  const el = h(`
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="fin-unit">Figures in <b>₹ crore</b> — rounded${ui.fin.forecast ? '; tinted columns = forecast' : ''}${(c.financials && c.financials.unitSource) ? ` <span class="src-chip" title="Where these figures came from — verify the scale against the model. Source: ${esc(c.financials.unitSource)}">${icon('info', 'w-3 h-3')}<span>${esc(c.financials.unitSource)}</span></span>` : ''}</div>
      <div class="flex items-center gap-2">
        <div class="switch" role="group" aria-label="Forecast">
          <button data-forecast="false">Actuals only</button>
          <button data-forecast="true">Include forecast</button>
        </div>
        <div class="switch" role="group" aria-label="View">
          <button data-finview="table">Table</button>
          <button data-finview="charts">Charts</button>
        </div>
      </div>
    </div>`);
  el.querySelector(`[data-forecast="${ui.fin.forecast}"]`).classList.add('on');
  el.querySelector(`[data-finview="${ui.fin.view}"]`).classList.add('on');
  el.querySelectorAll('[data-forecast]').forEach(b =>
    b.addEventListener('click', () => { ui.fin.forecast = b.dataset.forecast === 'true'; renderTabPanel(c, 'financials'); }));
  el.querySelectorAll('[data-finview]').forEach(b =>
    b.addEventListener('click', () => { ui.fin.view = b.dataset.finview; renderTabPanel(c, 'financials'); }));
  return el;
}

// Hero summary table. Sticky first column + sticky header; forecast columns tinted.
function renderFinTable(c) {
  const v = finView(c);
  const rows = v.fin.rows;
  const card = h('<div class="surface-card overflow-hidden"><div class="fin-scroll"></div></div>');
  const table = h('<table class="fin"></table>');

  // CAGR summary columns show only in the full (forecast-inclusive) view.
  const cagr = c.financials.cagr || {};
  const cagrCols = (ui.fin.forecast && Array.isArray(c.financials.cagrCols)) ? c.financials.cagrCols : [];

  // Header
  let head = '<thead><tr><th class="rowhead">&nbsp;</th>';
  v.years.forEach((y, i) => {
    const cls = (v.isForecast(i) ? 'fc' : '') + (i === v.actualsCut ? ' fc-start' : '');
    head += `<th class="${cls}">${esc(y)}</th>`;
  });
  cagrCols.forEach(cc => head += `<th class="cagr">CAGR<span>${esc(cc)}</span></th>`);
  head += '</tr></thead>';
  table.innerHTML = head;

  // Body
  const tbody = h('<tbody></tbody>');
  const colCount = v.years.length + 1 + cagrCols.length;
  FIN_GROUPS.forEach(group => {
    const present = group.rows.filter(r => Array.isArray(rows[r.key]));
    if (!present.length) return;                                   // skip empty groups cleanly
    tbody.appendChild(h(`<tr class="group"><td colspan="${colCount}">${esc(group.title)}</td></tr>`));
    present.forEach(r => {
      const visible = rows[r.key].slice(0, v.n);
      const maxAbs = Math.max(1, ...visible.filter(x => x != null).map(x => Math.abs(x)));
      let tr = `<tr class="${r.sub ? 'subrow' : ''}"><td class="rowhead">${esc(r.label)}</td>`;
      visible.forEach((val, i) => {
        const fcCls = (v.isForecast(i) ? 'fc' : '') + (i === v.actualsCut ? ' fc-start' : '');
        tr += finCell(val, r, maxAbs, fcCls);
      });
      cagrCols.forEach((cc, ci) => tr += (r.kind === 'cr' && cagr[r.key]) ? cagrCell(cagr[r.key][ci]) : '<td class="val cagr muted"></td>');
      tbody.appendChild(h(tr + '</tr>'));
    });
  });
  table.appendChild(tbody);
  card.querySelector('.fin-scroll').appendChild(table);
  return card;
}

// One financial cell. cr → plain number (red if negative); pct → number + mini-bar; days → plain integer.
function finCell(val, r, maxAbs, fcCls) {
  if (val == null) return `<td class="val muted ${fcCls}">—</td>`;
  const neg = val < 0;
  if (r.kind === 'pct') {
    const w = Math.max(6, Math.round(Math.abs(val) / maxAbs * 100));
    const barColor = neg ? tint(NEG, .75) : tint(POS, .75);
    const numColor = neg ? '#DC2626' : 'var(--ink)';
    const bar = r.bar ? `<div class="minibar"><span style="width:${w}%;background:${barColor}"></span></div>` : '';
    return `<td class="val ${fcCls}"><div class="cellwrap"><span style="color:${numColor};font-weight:600">${val}%</span>${bar}</div></td>`;
  }
  if (r.kind === 'days') return `<td class="val ${fcCls}">${fmtNum(val)}</td>`;
  return `<td class="val ${neg ? 'neg' : ''} ${fcCls}">${fmtNum(val)}</td>`;
}

// CAGR cell (right-hand summary columns). NM when a base is non-positive.
function cagrCell(v) {
  if (v == null) return '<td class="val cagr muted">NM</td>';
  return `<td class="val cagr">${Math.round(v * 100)}%</td>`;
}

// Supporting charts grid (only render charts whose data exists).
function renderFinCharts(c) {
  const fin = c.financials;
  const grid = h('<div class="grid gap-5 lg:grid-cols-2"></div>');
  grid.appendChild(chartCard('Revenue & EBITDA', 'barChart', 'revEbitda'));
  grid.appendChild(chartCard('Margins over time', 'percent', 'margins'));
  if (fin.segments && Array.isArray(fin.segments.rows) && fin.segments.rows.length)
    grid.appendChild(chartCard('Segment revenue mix', 'sliders', 'segMix'));
  if (Array.isArray(fin.rows.operatingCashflow) || Array.isArray(fin.rows.fcf))
    grid.appendChild(chartCard('Cash generation', 'coins', 'cashFlow'));
  if (fin.revenueMix) grid.appendChild(chartCard(fin.revenueMix.label || 'Revenue mix', 'pieChart', 'revmix'));
  if (fin.rows.cash && fin.rows.debt) grid.appendChild(chartCard('Cash vs Debt', 'coins', 'cashDebt'));
  return grid;
}
function chartCard(title, iconName, chartType) {
  return h(`
    <div class="chart-card">
      <div class="chart-head">
        <span class="sec-ico" style="width:24px;height:24px">${icon(iconName, 'w-3.5 h-3.5')}</span>
        <span class="chart-title">${esc(title)}</span>
      </div>
      <div class="chart-box"><canvas data-chart="${chartType}"></canvas></div>
    </div>`);
}

/* ---- 7c. Coming-soon tabs (nav stays complete + stable) ---- */
const SOON_DESC = {
  deepdive:  'Everything inside the Information Memorandum, unpacked into visual sections — so you never have to open the PDF.',
  fit:       'How this deal maps to Paragon’s mandate — sector, cheque size, stage and the full go / watch / pass rationale.',
  integrity: 'Promoter background, governance flags and the diligence checklist that must clear before we proceed.',
  questions: 'The sharp questions for the banker and management, gathered in one place for the meeting.',
  thesis:    'Why this could be a great investment — the value-creation story and the risks that could break it.',
  comps:     'How the deal stacks up against peers — operating metrics, listed trading multiples and past M&A transactions.',
  returns:   'Entry assumptions and a base / bull / bear return range, with what needs to be true to hit them.',
};
function renderComingSoon(tab) {
  const meta = TAB_META[tab] || { label: tab, icon: 'clock' };
  return h(`
    <div class="coming">
      <span class="cs-ico">${icon(meta.icon, 'w-7 h-7')}</span>
      <h3 class="font-display text-[18px] font-semibold text-ink">${esc(meta.label)}</h3>
      <p class="text-[13.5px] text-ink-muted mt-1.5 max-w-md leading-relaxed">${esc(SOON_DESC[tab] || '')}</p>
      <span class="cs-badge">${icon('clock', 'w-3.5 h-3.5')} Coming soon</span>
    </div>`);
}

/* ---- 7d. Fit tab ("does this deal fit our rules?") ---- */
const CHECK_STATUS = {
  yes: { color: '#10B981', icon: 'check', label: 'Yes' },
  no:  { color: '#E11D48', icon: 'x',     label: 'No'  },
  tbd: { color: '#9CA3AF', icon: 'minus', label: 'To confirm' },
};

function renderFit(c) {
  const fit = FIT[c.fit && c.fit.verdict] || FIT.watch;
  const list = c.fitChecklist || [];
  const total = list.length || 1;
  const yes = list.filter(x => x.status === 'yes').length;
  const no  = list.filter(x => x.status === 'no').length;
  const tbd = list.filter(x => x.status === 'tbd').length;
  const wrap = h('<div class="space-y-5"></div>');

  // Banner: the big fit light + reason, with a slim yes/no/tbd meter (checklist stays the hero).
  wrap.appendChild(h(`
    <div class="surface-card p-5">
      <div class="flex flex-col md:flex-row md:items-center gap-4 md:gap-6">
        <div class="flex items-center gap-3 min-w-0">
          <span class="fit-badge-lg" style="color:${fit.color};background:${fit.tint}">
            <span class="fit-dot${c.fit && c.fit.verdict === 'go' ? ' pulse' : ''}" style="background:${fit.color}"></span>${fit.label}
          </span>
          <p class="text-[13.5px] text-ink-muted leading-snug min-w-0">${esc(c.fit ? c.fit.reason : '')}</p>
        </div>
        <div class="md:ml-auto w-full md:w-auto md:min-w-[248px]">
          <div class="flex items-baseline justify-between mb-1.5">
            <span class="text-[12.5px] font-semibold text-ink"><b class="font-display">${yes}</b> of ${list.length} checks met</span>
            <span class="text-[11px] text-ink-hint">${no} no · ${tbd} to confirm</span>
          </div>
          <div class="meter" role="img" aria-label="${yes} yes, ${no} no, ${tbd} to confirm">
            <span style="width:${yes / total * 100}%;background:${POS}"></span>
            <span style="width:${no / total * 100}%;background:${NEG}"></span>
            <span style="width:${tbd / total * 100}%;background:#CBD1DC"></span>
          </div>
        </div>
      </div>
    </div>`));

  // Grouped checklist.
  const card = h(`<div class="surface-card p-5"><div class="section-title"><span class="sec-ico">${icon('target', 'w-4 h-4')}</span>Screening checklist</div></div>`);
  ['Business', 'Promoter'].forEach(group => {
    const rows = list.filter(x => x.group === group);
    if (!rows.length) return;
    card.appendChild(h(`<div class="group-head">${esc(group)}</div>`));
    rows.forEach(r => {
      const st = CHECK_STATUS[r.status] || CHECK_STATUS.tbd;
      card.appendChild(h(`
        <div class="check-row">
          <span class="check-mark" style="color:${st.color};background:${tint(st.color, .12)}">${icon(st.icon, 'w-3.5 h-3.5', 3)}</span>
          <div class="check-body">
            <div class="check-label">${esc(r.label)}</div>
            <div class="check-note">${esc(r.note)}</div>
          </div>
        </div>`));
    });
  });
  wrap.appendChild(card);
  return wrap;
}

/* ---- 7e. Integrity tab ("any red flags?") ---- */
const INTEG_STATUS = {
  clear:   { color: '#10B981', icon: 'check',  label: 'Clear'    },
  flag:    { color: '#F59E0B', icon: 'alert',  label: 'Flag'     },
  risk:    { color: '#E11D48', icon: 'alert',  label: 'Red flag' },
  pending: { color: '#9CA3AF', icon: 'circle', label: 'Pending'  },
};
function integrityIcon(area) {
  const a = String(area).toLowerCase();
  if (a.includes('google') || a.includes('search')) return 'search';
  if (a.includes('circle') || a.includes('private')) return 'users';
  if (a.includes('cibil')) return 'gauge';
  if (a.includes('rating')) return 'award';
  if (a.includes('legal') || a.includes('mca')) return 'scale';
  return 'shield';
}

function renderIntegrity(c) {
  const items = c.integrity || [];
  const clear = items.filter(x => x.status === 'clear').length;
  const risk = items.filter(x => x.status === 'risk').length;
  const toCheck = items.length - clear - risk;
  const wrap = h('<div class="space-y-5"></div>');

  wrap.appendChild(h(`
    <div class="surface-card px-5 py-3.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
      ${risk ? `<span class="inline-flex items-center gap-2"><span class="dot-sm" style="background:#E11D48"></span><b class="text-ink font-semibold">${risk} red flag${risk === 1 ? '' : 's'}</b></span><span class="text-ink-hint">·</span>` : ''}
      <span class="inline-flex items-center gap-2"><span class="dot-sm" style="background:${POS}"></span><b class="text-ink font-semibold">${clear} clear</b></span>
      <span class="text-ink-hint">·</span>
      <span class="inline-flex items-center gap-2"><span class="dot-sm" style="background:#F59E0B"></span><b class="text-ink font-semibold">${toCheck} to check</b></span>
      <span class="ml-auto text-[12px] text-ink-hint">Background &amp; diligence scan</span>
    </div>`));

  const card = h('<div class="surface-card p-2.5"></div>');
  items.forEach(it => {
    const st = INTEG_STATUS[it.status] || INTEG_STATUS.pending;
    const links = Array.isArray(it.links) ? it.links.filter(l => l && l.url).slice(0, 4) : [];
    const linksHtml = links.length
      ? `<div class="integ-links">${links.map(l => `<a class="integ-link" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer"><span>${esc(l.label || l.url)}</span></a>`).join('')}</div>`
      : '';
    card.appendChild(h(`
      <div class="integ-row">
        <span class="integ-area-ico">${icon(integrityIcon(it.area), 'w-4 h-4')}</span>
        <div class="integ-body">
          <div class="integ-area">${esc(it.area)}</div>
          <div class="integ-find">${esc(it.finding)}</div>
          ${linksHtml}
        </div>
        <span class="integ-badge" style="color:${st.color};background:${tint(st.color, .12)}">${icon(st.icon, 'w-3.5 h-3.5', 2.6)}${st.label}</span>
      </div>`));
  });
  wrap.appendChild(card);
  return wrap;
}

/* ---- 7f. Questions tab ("what we'll ask management") ---- */
function themeIcon(theme) {
  const t = String(theme).toLowerCase();
  if (t.includes('revenue') || t.includes('financ') || t.includes('margin') || t.includes('econ')) return 'percent';
  if (t.includes('customer') || t.includes('concentration')) return 'users';
  if (t.includes('order') || t.includes('sales')) return 'clipboard';
  if (t.includes('raw material') || t.includes('sourcing') || t.includes('supply') || t.includes('inventory')) return 'layers';
  if (t.includes('manufactur') || t.includes('processing') || t.includes('capex')) return 'wallet';
  if (t.includes('competition') || t.includes('peer')) return 'target';
  if (t.includes('governance') || t.includes('cap table') || t.includes('process')) return 'shield';
  if (t.includes('strategy') || t.includes('pivot') || t.includes('expansion') || t.includes('epr')) return 'trendingUp';
  if (t.includes('distribution') || t.includes('hedging') || t.includes('ipo')) return 'building';
  return 'help';
}

function renderQuestions(c) {
  const themes = c.questions || [];
  const totalQ = themes.reduce((n, t) => n + t.items.length, 0);
  const wrap = h('<div class="space-y-4"></div>');

  const bar = h(`
    <div class="flex items-center justify-between gap-3">
      <div class="text-[13px] text-ink-muted">${themes.length} themes · ${totalQ} questions for management</div>
      <button class="link-btn" data-toggle-all type="button">Collapse all</button>
    </div>`);
  wrap.appendChild(bar);

  const listWrap = h('<div class="space-y-2.5"></div>');
  themes.forEach(t => {
    const open = true;                             // every theme open — the questions are the point of the tab
    const acc = h(`
      <div class="accordion${open ? ' open' : ''}">
        <button class="acc-head" type="button" aria-expanded="${open}">
          <span class="acc-ico">${icon(themeIcon(t.theme), 'w-4 h-4')}</span>
          <span class="acc-title">${esc(t.theme)}</span>
          <span class="acc-count">${t.items.length}</span>
          <span class="acc-chev">${icon('chevronDown', 'w-4 h-4')}</span>
        </button>
        <div class="acc-body"><div class="acc-inner"><ol class="q-list">${t.items.map(q => `<li>${esc(q)}</li>`).join('')}</ol></div></div>
      </div>`);
    acc.querySelector('.acc-head').addEventListener('click', () => setAccordion(acc, !acc.classList.contains('open')));
    listWrap.appendChild(acc);
  });
  wrap.appendChild(listWrap);

  bar.querySelector('[data-toggle-all]').addEventListener('click', e => {
    const accs = $$('.accordion', listWrap);
    const expand = accs.some(a => !a.classList.contains('open'));   // if any closed → expand all
    accs.forEach(a => setAccordion(a, expand));
    e.currentTarget.textContent = expand ? 'Collapse all' : 'Expand all';
  });
  return wrap;
}
function setAccordion(acc, open) {
  acc.classList.toggle('open', open);
  acc.querySelector('.acc-head').setAttribute('aria-expanded', String(open));
}

/* ---- 7g. Thesis tab ("why we'd invest vs what worries us") ---- */
function renderThesis(c) {
  const grid = h('<div class="grid gap-5 lg:grid-cols-2 items-start"></div>');

  const left = h(`<div class="surface-card p-5"><div class="section-title"><span class="sec-ico" style="color:${POS};background:${tint(POS, .1)};border-color:${tint(POS, .22)}">${icon('thumbsUp', 'w-4 h-4')}</span>Why we’d invest</div><div class="space-y-3"></div></div>`);
  const lb = left.querySelector('.space-y-3');
  (c.thesis || []).forEach(t => lb.appendChild(h(`
    <div class="reason-card pos">
      <div class="reason-point">${esc(t.point)}</div>
      <div class="reason-detail">${esc(t.detail)}</div>
    </div>`)));

  const right = h(`<div class="surface-card p-5"><div class="section-title"><span class="sec-ico" style="color:#B45309;background:${tint('#F59E0B', .13)};border-color:${tint('#F59E0B', .28)}">${icon('alert', 'w-4 h-4')}</span>What worries us</div><div class="space-y-3"></div></div>`);
  const rb = right.querySelector('.space-y-3');
  (c.concerns || []).forEach(t => rb.appendChild(h(`
    <div class="reason-card neg">
      <div class="reason-point">${esc(t.issue)}</div>
      <div class="reason-detail">${esc(t.detail)}</div>
      <div class="reason-mit"><span class="mit-label">Mitigant</span>${esc(t.mitigant)}</div>
    </div>`)));

  grid.appendChild(left);
  grid.appendChild(right);
  return grid;
}

/* ---- 7g-2. Comps tab — peer benchmarking · trading comps · transaction comps ----
 * The peer LIST comes from the IM / banker notes; the NUMBERS come from the IM, a
 * Private Circle export (unlisted), or live from Screener (listed). Modelled on the
 * firm's own trading & transaction comps workbook. Any section with no rows is hidden. */
const hasRows = x => Array.isArray(x) && x.length > 0;
function compsData(c) { return (c.comps && typeof c.comps === 'object') ? c.comps : {}; }
function hasComps(c) {
  const k = compsData(c);
  return hasRows(k.peerBenchmark && k.peerBenchmark.rows) || hasRows(k.trading && k.trading.rows) || hasRows(k.transactions && k.transactions.rows);
}
const cVal  = (v, suf) => (v == null || isNaN(v)) ? '—' : (v + (suf || ''));
const cMult = v => (v == null || isNaN(v)) ? '—' : (Math.round(v * 10) / 10) + '×';
const cCr   = v => (v == null || isNaN(v)) ? '—' : fmtCr(v);
const cTag  = l => `<span class="peer-tag ${l ? 'lst' : 'prv'}">${l ? 'Listed' : 'Private'}</span>`;

function renderComps(c) {
  const k = compsData(c);
  const wrap = h('<div class="space-y-5"></div>');
  // Add-a-report action bar (uploaded deals only): drop a valuation-comps / Private Circle export to
  // fill transaction comps for the private names, then the memo rebuilds in place.
  if (!isSample(c)) {
    const bar = h(`<div class="flex items-center justify-between gap-3 flex-wrap">
      <div class="text-[12.5px] text-ink-hint">Have a valuation-comps / Private Circle export? Add it to complete transaction comps for the private names.</div>
      <button class="hdr-btn" data-add-report type="button" style="color:${BRAND.ink};background:#F2F5FB;border-color:${BRAND.border}">${icon('plus', 'w-4 h-4')} Add report</button>
    </div>`);
    bar.querySelector('[data-add-report]').addEventListener('click', () => openAttachReportModal(c));
    wrap.appendChild(bar);
  }
  const hasTrading = hasRows(k.trading && k.trading.rows);
  const hasTxn     = hasRows(k.transactions && k.transactions.rows);
  const hasVal = hasTrading || hasTxn;
  let any = false;
  // Valuation comps FIRST — this is what "Comps" means (Faraz: trading + transaction valuation).
  if (hasVal) {
    wrap.appendChild(h(`
      <div class="comps-intro">
        <div class="section-title mb-0"><span class="sec-ico">${icon('scale', 'w-4 h-4')}</span>Valuation comps</div>
        <p class="text-[12.5px] text-ink-muted mt-1">What comparable companies are worth — <b>trading comps</b> (listed peers' current multiples) and <b>transaction comps</b> (multiples paid in past M&amp;A / PE deals). Listed multiples are indicative estimates (refreshed live where the market-data source returns them); private names and deals come from a Private Circle / valuation export.</p>
      </div>`));
    if (hasTrading) { wrap.appendChild(renderTradingComps(c, k.trading));    any = true; }
    if (hasTxn)     { wrap.appendChild(renderTransactionComps(c, k.transactions)); any = true; }
  }
  // Peer benchmarking (operating metrics) SECOND — related, but not valuation.
  if (hasRows(k.peerBenchmark && k.peerBenchmark.rows)) { wrap.appendChild(renderPeerBenchmark(c, k.peerBenchmark)); any = true; }
  // Fallback: no rich comps block, but the memo still named peers (the simpler `peers` block) —
  // show them here so the tab reflects the peers that were found, rather than reading "empty".
  if (!any && hasPeers(c)) { const pc = renderPeerComps(c); if (pc) { wrap.appendChild(pc); any = true; } }
  if (!any) {
    wrap.appendChild(h(`
      <div class="coming">
        <div class="cs-ico">${icon('scale', 'w-6 h-6')}</div>
        <div class="text-[15px] font-semibold text-ink">No valuation comps yet</div>
        <p class="text-[13px] text-ink-muted mt-1 max-w-md">Trading comps (listed peers) and transaction comps (past deals) appear here from the deal's listed peer set (multiples indicative, refreshed live where available) or from a Private Circle / valuation export you add for the private names.</p>
      </div>`));
  }
  return wrap;
}

// 1) Peer benchmarking — operating metrics (revenue, growth, margins) of the named peers.
function renderPeerBenchmark(c, pb) {
  const rows = pb.rows || [];
  const self = pb.self;
  const line = r => `<tr class="${r._self ? 'peer-self' : ''}">
      <td>${esc(r.name)}${r._self ? ' <span class="peer-you">the deal</span>' : ''}${r.note && !r._self ? `<span class="peer-note">${esc(r.note)}</span>` : ''}</td>
      <td>${cTag(!!r.listed)}${r.ticker ? ` <span class="peer-tick">${esc(r.ticker)}</span>` : ''}</td>
      <td class="num">${cCr(r.revenueCr)}</td>
      <td class="num">${cVal(r.revenueGrowthPct, '%')}</td>
      <td class="num">${cVal(r.ebitdaPct, '%')}</td>
      <td class="num">${cVal(r.patPct, '%')}</td></tr>`;
  const selfRow = (self && self.name) ? line({ ...self, _self: true }) : '';
  const body = selfRow + rows.map(line).join('');
  const card = h(`
    <div class="surface-card p-5">
      <div class="section-title"><span class="sec-ico">${icon('barChart', 'w-4 h-4')}</span>Peer benchmarking · operating metrics</div>
      ${pb.note ? `<p class="text-[12.5px] text-ink-muted mb-3 leading-relaxed">${esc(pb.note)}</p>` : ''}
      <div class="peer-scroll"><table class="comps-tbl">
        <thead><tr><th>Company</th><th>Type</th><th class="num">Revenue</th><th class="num">Rev growth</th><th class="num">EBITDA %</th><th class="num">PAT %</th></tr></thead>
        <tbody>${body}</tbody></table></div>
      <p class="text-[11px] text-ink-hint mt-2">${esc(pb.asOf ? 'As of ' + pb.asOf + '. ' : '')}From the IM / banker notes; blank where the documents give no figure.</p>
    </div>`);
  return card;
}

// 2) Trading comps — listed peers' VALUATION multiples, with a live market-data pull.
function renderTradingComps(c, tr) {
  const rows = tr.rows || [];
  const medEbitda = peerMedian(rows.map(r => r.evEbitda));
  const medRev = peerMedian(rows.map(r => r.evRevenue));
  const medPe = peerMedian(rows.map(r => r.pe));
  const line = r => `<tr>
      <td>${esc(r.name)}${r.ticker ? ` <span class="peer-tick">${esc(r.ticker)}</span>` : ''}${r.note ? `<span class="peer-note">${esc(r.note)}</span>` : ''}</td>
      <td class="num">${cCr(r.marketCapCr)}</td>
      <td class="num">${cCr(r.evCr)}</td>
      <td class="num">${cCr(r.revenueCr)}</td>
      <td class="num">${cVal(r.ebitdaPct, '%')}</td>
      <td class="num">${cMult(r.evEbitda)}</td>
      <td class="num">${cMult(r.evRevenue)}</td>
      <td class="num">${cMult(r.pe)}</td></tr>`;
  const medRow = (medEbitda != null || medRev != null || medPe != null)
    ? `<tr class="peer-med"><td>Peer median</td><td></td><td></td><td></td><td></td><td class="num">${cMult(medEbitda)}</td><td class="num">${cMult(medRev)}</td><td class="num">${cMult(medPe)}</td></tr>` : '';
  const card = h(`
    <div class="surface-card p-5">
      <div class="section-title"><span class="sec-ico">${icon('scale', 'w-4 h-4')}</span>Trading comps · listed peers</div>
      ${tr.note ? `<p class="text-[12.5px] text-ink-muted mb-3 leading-relaxed">${esc(tr.note)}</p>` : ''}
      <div class="peer-scroll"><table class="comps-tbl">
        <thead><tr><th>Company</th><th class="num">Mkt cap</th><th class="num">EV</th><th class="num">Revenue</th><th class="num">EBITDA %</th><th class="num">EV/EBITDA</th><th class="num">EV/Revenue</th><th class="num">P/E</th></tr></thead>
        <tbody>${rows.map(line).join('')}${medRow}</tbody></table></div>
      <div data-comps-live class="mt-3"></div>
      <p class="text-[11px] text-ink-hint mt-2">${esc(tr.asOf ? 'As of ' + tr.asOf + '. ' : '')}${esc(tr.source ? tr.source + '. ' : '')}Multiples shown are indicative estimates for the listed peer set — verify against a market terminal before use. The live pull below refreshes market cap / P·E where the data source returns them; the median feeds the entry-multiple hint on Returns.</p>
    </div>`);
  attachCompsLive(card, c, rows);
  return card;
}

// 3) Transaction comps — past M&A / PE deals in the space and the multiples paid.
function renderTransactionComps(c, tx) {
  const rows = tx.rows || [];
  const medEbitda = peerMedian(rows.map(r => r.evEbitda));
  const medRev = peerMedian(rows.map(r => r.evRevenue));
  const line = r => `<tr>
      <td class="nowrap">${esc(r.date || '—')}</td>
      <td>${esc(r.target || '—')}${r.note ? `<span class="peer-note">${esc(r.note)}</span>` : ''}</td>
      <td>${esc(r.buyer || '—')}</td>
      <td>${esc(r.seller || '—')}</td>
      <td>${esc(r.dealType || '—')}</td>
      <td>${esc(r.region || '—')}</td>
      <td class="num">${cVal(r.stakePct, '%')}</td>
      <td class="num">${esc(r.dealValue || '—')}</td>
      <td class="num">${cMult(r.evEbitda)}</td>
      <td class="num">${cMult(r.evRevenue)}</td></tr>`;
  const medRow = (medEbitda != null || medRev != null)
    ? `<tr class="peer-med"><td></td><td>Deal median</td><td></td><td></td><td></td><td></td><td></td><td></td><td class="num">${cMult(medEbitda)}</td><td class="num">${cMult(medRev)}</td></tr>` : '';
  return h(`
    <div class="surface-card p-5">
      <div class="section-title"><span class="sec-ico">${icon('briefcase', 'w-4 h-4')}</span>Transaction comps · past deals</div>
      ${tx.note ? `<p class="text-[12.5px] text-ink-muted mb-3 leading-relaxed">${esc(tx.note)}</p>` : ''}
      <div class="peer-scroll"><table class="comps-tbl">
        <thead><tr><th>Date</th><th>Target</th><th>Buyer</th><th>Seller</th><th>Type</th><th>Region</th><th class="num">% Sought</th><th class="num">Deal value</th><th class="num">EV/EBITDA</th><th class="num">EV/Revenue</th></tr></thead>
        <tbody>${rows.map(line).join('')}${medRow}</tbody></table></div>
      <p class="text-[11px] text-ink-hint mt-2">${esc(tx.source ? tx.source + '. ' : '')}From a Private Circle / valuation export or disclosed deals; blank where a multiple was not disclosed.</p>
    </div>`);
}

// Live Screener pull for the trading-comps listed rows (market cap, P/E, ROE). Purely additive:
// fills the Mkt-cap column and shows a small live sub-table. Cached on c._peerLive so it persists.
function attachCompsLive(card, c, rows) {
  const listed = (rows || []).filter(r => r && r.listed && r.ticker);
  const box = card.querySelector('[data-comps-live]');
  if (!state.peerLiveEnabled || !listed.length || !box) return;

  const liveTable = live => {
    const cell = v => v == null ? '<span class="peer-live-na">—</span>' : v;
    const mult = v => v == null ? null : v.toFixed(1) + '×';
    const body = listed.map(r => {
      const d = (live.byTicker || {})[r.ticker] || {};
      return `<tr><td>${esc(r.name)} <span class="peer-tick">${esc(r.ticker)}</span></td>
        <td class="num">${cell(d.marketCapCr != null ? fmtCr(d.marketCapCr) : null)}</td>
        <td class="num">${cell(mult(d.pe))}</td>
        <td class="num">${cell(mult(d.evEbitda))}</td>
        <td class="num">${cell(mult(d.evRevenue))}</td></tr>`;
    }).join('');
    const got = listed.some(r => { const d = (live.byTicker || {})[r.ticker]; return d && (d.pe != null || d.marketCapCr != null || d.evEbitda != null || d.evRevenue != null); });
    const foot = got
      ? `Live market data${live.ts ? ' · ' + esc(live.ts) : ''}. Market cap, P/E and EV multiples for the listed peers.`
      : `No live figures right now — the market-data source may be busy. Try Refresh in a moment.`;
    return `<div class="peer-scroll mt-2"><table class="peer-tbl peer-live-tbl">
        <thead><tr><th>Listed peer</th><th class="num">Market cap</th><th class="num">P/E</th><th class="num">EV/EBITDA</th><th class="num">EV/Revenue</th></tr></thead>
        <tbody>${body}</tbody></table></div><p class="peer-live-hint">${foot}</p>`;
  };
  const renderPanel = () => {
    const live = c._peerLive;
    box.innerHTML = `
      <div class="peer-live-head">
        <span class="peer-live-title">${icon('search', 'w-3.5 h-3.5')} Listed peers · live market data</span>
        <button class="peer-live-btn" type="button" data-live-fetch>${icon('refreshCw', 'w-3.5 h-3.5')}<span>${live ? 'Refresh' : 'Fetch live market data'}</span><span class="peer-live-tag">live</span></button>
      </div>
      <div data-live-body>${live ? liveTable(live) : `<p class="peer-live-hint">Pull each listed peer's current market cap, P/E and trading multiples (EV/EBITDA, EV/Revenue) live — and fill any blanks in the table above.</p>`}</div>`;
    box.querySelector('[data-live-fetch]').addEventListener('click', fetchLive);
  };
  const runFetch = async (btn) => {
    if (btn) { btn.disabled = true; const span = btn.querySelector('span'); if (span) span.textContent = 'Fetching…'; }
    const byTicker = (c._peerLive && c._peerLive.byTicker) || {};
    await Promise.all(listed.map(async r => {
      try {
        const res = await fetch(apiUrl('peer-multiple') + '?ticker=' + encodeURIComponent(r.ticker));
        const d = await res.json().catch(() => ({}));
        byTicker[r.ticker] = { pe: _num(d.pe), marketCapCr: _num(d.marketCapCr), evCr: _num(d.evCr), evEbitda: _num(d.evEbitda), evRevenue: _num(d.evRevenue), revenueCr: _num(d.revenueCr), ebitdaPct: _num(d.ebitdaPct), roe: _num(d.roe), via: d.via };
      } catch (_) { byTicker[r.ticker] = byTicker[r.ticker] || {}; }
    }));
    c._peerLive = { ts: nowLabel(), byTicker };
    // Backfill the trading table's blank cells (mkt cap, EV, and the multiples) from live data,
    // then re-render the tab so the median row + Returns hint recompute off the fresh multiples.
    let filled = false;
    // For LISTED peers, live market data is authoritative — OVERWRITE the model's indicative estimates
    // so every column shows real figures (a failed fetch leaves that peer's estimate untouched).
    listed.forEach(r => {
      const d = byTicker[r.ticker]; if (!d) return;
      if (d.marketCapCr != null) { r.marketCapCr = Math.round(d.marketCapCr); filled = true; }
      if (d.evCr != null) { r.evCr = Math.round(d.evCr); filled = true; }
      if (d.revenueCr != null) { r.revenueCr = Math.round(d.revenueCr); filled = true; }
      if (d.ebitdaPct != null) { r.ebitdaPct = Math.round(d.ebitdaPct); filled = true; }
      if (d.evEbitda != null) { r.evEbitda = d.evEbitda; filled = true; }
      if (d.evRevenue != null) { r.evRevenue = d.evRevenue; filled = true; }
      if (d.pe != null) { r.pe = Math.round(d.pe * 10) / 10; filled = true; }
      if (filled) r._live = true;
    });
    if (filled && box.isConnected) { renderTabPanel(c, 'comps'); return; }
    if (box.isConnected) renderPanel();
  };
  const fetchLive = e => runFetch(e.currentTarget);
  renderPanel();
  // Refresh listed peers automatically the first time this deal's Comps tab is opened, so the
  // trading multiples are real market data (not just the model's estimates) without a manual click.
  if (!c._peerLive && !c._peerLiveAuto) { c._peerLiveAuto = true; runFetch(null); }
}

/* ---- 7g-bis. IM Deep-Dive — a GENERIC, block-based unpacking of the whole IM ----
 * The client wants the dashboard so complete he never has to open the Information
 * Memorandum. So the AI emits, per deal, a fully dynamic:
 *     c.deepDive = { source?, summary?, sections:[ { title, icon?, summary?, blocks:[…] } ] }
 * There is NO fixed list of sections — they adapt to whatever a given IM contains
 * (market, business model, unit economics, customers, moat, use of proceeds, …).
 * Every block carries a `type` from the fixed visual library below; unknown types
 * degrade gracefully. Blocks are pure HTML + inline SVG using `.dd-*` classes
 * (defined once in index.html), so the SAME renderers drive both this live tab and
 * the printed/exported report (exportDocHtml inlines every <style>). --------------- */

const DD_PALETTE = ['#0C3078', '#2563EB', '#0EA5E9', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#14B8A6', '#EF4444', '#64748B'];
const ddColor = i => DD_PALETTE[i % DD_PALETTE.length];
const ddIsNum = v => typeof v === 'number' && isFinite(v);
const ddSafeIcon = name => (name && ICONS[name]) ? name : null;

// Display a value: numbers get Indian grouping (+ optional unit); strings pass through
// verbatim (IMs often carry pre-formatted values like "₹5,000 cr" or "23% YoY").
function ddValue(v, unit) {
  if (v == null || v === '') return '';
  if (ddIsNum(v)) {
    const abs = Math.abs(v);
    const s = abs >= 1000 ? Math.round(v).toLocaleString('en-IN')
            : (Math.round(v * 100) / 100).toLocaleString('en-IN');
    return esc(s + (unit ? ' ' + unit : ''));
  }
  return esc(String(v)) + (unit ? ' ' + esc(unit) : '');
}
// Pull a number out of a number or a string ("₹1,240 cr" → 1240) for chart geometry.
function ddToNum(v) {
  if (ddIsNum(v)) return v;
  if (typeof v === 'string') { const m = v.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); if (m) return parseFloat(m[0]); }
  return null;
}
// Compact axis tick (Indian lakh/crore scale) so y-labels stay narrow.
const ddTrim = s => s.replace(/\.0$/, '');
function ddCompact(v) {
  const a = Math.abs(v);
  if (a >= 1e7) return ddTrim((v / 1e7).toFixed(a >= 1e8 ? 0 : 1)) + 'Cr';
  if (a >= 1e5) return ddTrim((v / 1e5).toFixed(a >= 1e6 ? 0 : 1)) + 'L';
  if (a >= 1e3) return ddTrim((v / 1e3).toFixed(a >= 1e4 ? 0 : 1)) + 'k';
  return String(Math.round(v * 10) / 10);
}
// A "nice" round step (1/2/5 × 10ⁿ) for readable axis gridlines.
function ddNiceStep(raw) {
  if (!(raw > 0)) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / e;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * e;
}
const ddField = (o, ...keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return undefined; };

// Optional block heading + caption (charts/tables/bars use these; self-titled blocks skip).
function ddBlockHead(b) {
  const t = ddField(b, 'title', 'heading');
  if (!t) return '';
  const ic = ddSafeIcon(b.icon);
  return `<div class="dd-bh">${ic ? `<span class="dd-bh-ico">${icon(ic, 'w-3.5 h-3.5', 2.4)}</span>` : ''}<span class="dd-bh-t">${esc(t)}</span></div>`;
}
const ddBlockCap = b => { const c = ddField(b, 'caption', 'footnote'); return c ? `<div class="dd-cap">${esc(c)}</div>` : ''; };

/* ---- the block library — each returns an HTML *body* string (no outer wrapper) ---- */

// KPI tiles: big number, label, optional sub + delta chip.
function ddKpis(b) {
  const items = (b.items || b.stats || b.kpis || b.metrics || []).filter(Boolean);
  if (!items.length) return '';
  const tiles = items.map(it => {
    const val = ddField(it, 'value', 'v', 'val');
    const label = ddField(it, 'label', 'k', 'name');
    const delta = ddField(it, 'delta', 'change');
    let dchip = '';
    if (delta != null && delta !== '') {
      const up = ddIsNum(delta) ? delta >= 0 : !/^-|↓|down|drop|decl/i.test(String(delta));
      const bad = it.tone === 'bad' || (it.tone !== 'good' && !up);
      dchip = `<span class="dd-kpi-d ${bad ? 'is-bad' : 'is-good'}">${up ? '▲' : '▼'} ${esc(String(delta).replace(/^[+-]/, ''))}</span>`;
    }
    return `<div class="dd-kpi">
      <div class="dd-kpi-v">${ddValue(val, it.unit)}${dchip}</div>
      <div class="dd-kpi-l">${esc(label || '')}</div>
      ${it.sub ? `<div class="dd-kpi-s">${esc(it.sub)}</div>` : ''}</div>`;
  }).join('');
  return `<div class="dd-kpis">${tiles}</div>`;
}

// Horizontal bars, proportional to the max value.
function ddBars(b) {
  const items = (b.items || b.rows || b.data || []).filter(Boolean);
  if (!items.length) return '';
  const nums = items.map(it => ddToNum(ddField(it, 'value', 'v', 'val')));
  const max = Math.max(1, ...nums.map(n => n == null ? 0 : Math.abs(n)));
  const rows = items.map((it, i) => {
    const raw = ddField(it, 'value', 'v', 'val');
    const w = nums[i] == null ? 0 : Math.max(2, Math.abs(nums[i]) / max * 100);
    return `<div class="dd-bar-row">
      <div class="dd-bar-lab">${esc(ddField(it, 'label', 'name', 'k') || '')}</div>
      <div class="dd-bar-track"><span class="dd-bar-fill" style="width:${w}%;background:${esc(it.color || ddColor(i))}"></span></div>
      <div class="dd-bar-val">${raw == null ? '' : ddValue(raw, b.unit || it.unit)}</div>${it.note ? `<div class="dd-bar-note">${esc(it.note)}</div>` : ''}</div>`;
  }).join('');
  return `<div class="dd-bars">${rows}</div>`;
}

// Line / area chart over time — one or more series, self-contained SVG.
function ddTrend(b) {
  const x = b.x || b.labels || b.categories || b.years || [];
  let series = b.series;
  if (!series && Array.isArray(b.values)) series = [{ name: b.name || '', values: b.values }];
  series = (series || []).filter(s => s && Array.isArray(s.values) && s.values.length);
  if (!series.length) return '';
  const n = Math.max(...series.map(s => s.values.length), x.length || 0);
  if (n < 2) return '';
  const nums = series.flatMap(s => s.values.map(ddToNum)).filter(v => v != null);
  if (!nums.length) return '';
  // "Nice" round bounds so gridlines read 0 / 500 / 1k / 1.5k, not 349.5 / 699.1.
  const dMin = Math.min(...nums), dMax = Math.max(...nums), lo0 = dMin >= 0 ? 0 : dMin;
  const step = ddNiceStep(((dMax - lo0) || 1) / 4);
  const lo = Math.floor(lo0 / step) * step;
  let hi = Math.ceil(dMax / step) * step;
  if (hi <= lo) hi = lo + step;
  const W = 720, H = 250, mL = 46, mR = 16, mT = 14, mB = 34, iw = W - mL - mR, ih = H - mT - mB;
  const X = i => mL + (n <= 1 ? iw / 2 : iw * i / (n - 1));
  const Y = v => mT + ih * (1 - (v - lo) / (hi - lo));
  const grid = [], ylab = [];
  for (let v = lo; v <= hi + step * 1e-6; v += step) { const y = Y(v); grid.push(`<line x1="${mL}" y1="${y.toFixed(1)}" x2="${W - mR}" y2="${y.toFixed(1)}" class="dd-grid"/>`); ylab.push(`<text x="${mL - 6}" y="${(y + 3).toFixed(1)}" class="dd-yt">${esc(ddCompact(v))}</text>`); }
  const xstep = n <= 9 ? 1 : Math.ceil(n / 8);
  const xlab = []; for (let i = 0; i < n; i++) if (i % xstep === 0 || i === n - 1) xlab.push(`<text x="${X(i).toFixed(1)}" y="${H - 12}" class="dd-xt">${esc(String(x[i] != null ? x[i] : i + 1))}</text>`);
  const paths = series.map((s, si) => {
    const col = s.color || ddColor(si);
    const pts = s.values.map((v, i) => { const y = ddToNum(v); return y == null ? null : `${X(i).toFixed(1)},${Y(y).toFixed(1)}`; }).filter(Boolean);
    if (!pts.length) return '';
    const dots = s.values.map((v, i) => { const y = ddToNum(v); return y == null ? '' : `<circle cx="${X(i).toFixed(1)}" cy="${Y(y).toFixed(1)}" r="3" fill="${esc(col)}"/>`; }).join('');
    const area = series.length === 1 ? `<polygon points="${X(0).toFixed(1)},${Y(lo).toFixed(1)} ${pts.join(' ')} ${X(n - 1).toFixed(1)},${Y(lo).toFixed(1)}" fill="${tint(col, .10)}"/>` : '';
    return `${area}<polyline points="${pts.join(' ')}" fill="none" stroke="${esc(col)}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
  }).join('');
  const legend = series.length > 1 ? `<div class="dd-lg dd-lg-row-wrap">${series.map((s, si) => `<span class="dd-lg-chip"><span class="dd-lg-dot" style="background:${esc(s.color || ddColor(si))}"></span>${esc(s.name || 'Series ' + (si + 1))}</span>`).join('')}</div>` : '';
  return `${legend}<svg viewBox="0 0 ${W} ${H}" class="dd-chart" role="img" aria-label="trend chart">${grid.join('')}${ylab.join('')}${xlab.join('')}${paths}</svg>`;
}

// Donut / share breakdown — SVG ring + legend with values and %.
function ddDonut(b) {
  const items = (b.items || b.slices || b.data || b.segments || []).filter(it => it && ddToNum(ddField(it, 'value', 'v', 'val')) != null);
  if (!items.length) return '';
  const vals = items.map(it => Math.abs(ddToNum(ddField(it, 'value', 'v', 'val'))));
  const total = vals.reduce((a, c) => a + c, 0) || 1;
  const R = 58, TH = 24, C = 2 * Math.PI * R, cx = 80, cy = 80;
  let off = 0;
  const arcs = items.map((it, i) => { const dash = vals[i] / total * C; const seg = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${esc(it.color || ddColor(i))}" stroke-width="${TH}" stroke-dasharray="${dash.toFixed(2)} ${(C - dash).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`; off += dash; return seg; }).join('');
  const center = b.center != null ? b.center : (b.total != null ? ddValue(b.total) : '');
  const ctext = center ? `<text x="${cx}" y="${cy - 2}" text-anchor="middle" class="dd-donut-c1">${esc(String(center))}</text>${b.centerSub ? `<text x="${cx}" y="${cy + 15}" text-anchor="middle" class="dd-donut-c2">${esc(b.centerSub)}</text>` : ''}` : '';
  const legend = items.map((it, i) => `<div class="dd-lg-item"><span class="dd-lg-dot" style="background:${esc(it.color || ddColor(i))}"></span><span class="dd-lg-lab">${esc(ddField(it, 'label', 'name', 'k') || '')}</span><span class="dd-lg-val">${ddValue(ddField(it, 'value', 'v', 'val'), it.unit)}</span><span class="dd-lg-pct">${Math.round(vals[i] / total * 100)}%</span></div>`).join('');
  return `<div class="dd-donut"><svg viewBox="0 0 160 160" class="dd-donut-svg" role="img" aria-label="share chart">${arcs}${ctext}</svg><div class="dd-lg">${legend}</div></div>`;
}

// Funnel — centered bars that narrow down the list (TAM→SAM→SOM, sales stages, …).
function ddFunnel(b) {
  const items = (b.items || b.stages || b.data || []).filter(Boolean);
  if (!items.length) return '';
  const nums = items.map(it => ddToNum(ddField(it, 'value', 'v', 'val')));
  const max = Math.max(1, ...nums.map(n => n == null ? 0 : Math.abs(n)));
  const rows = items.map((it, i) => {
    const w = nums[i] == null ? 100 : Math.max(16, Math.abs(nums[i]) / max * 100);
    const col = ddColor(i);
    return `<div class="dd-fn-row"><div class="dd-fn-bar" style="width:${w}%;background:linear-gradient(90deg,${tint(col, .92)},${tint(col, .6)})"><span class="dd-fn-lab">${esc(ddField(it, 'label', 'name', 'k') || '')}</span><span class="dd-fn-val">${ddValue(ddField(it, 'value', 'v', 'val'), it.unit)}</span></div>${it.note ? `<span class="dd-fn-note">${esc(it.note)}</span>` : ''}</div>`;
  }).join('');
  return `<div class="dd-funnel">${rows}</div>`;
}

// Flow / process / value chain — steps connected by arrows, wraps on narrow screens.
function ddFlow(b) {
  const steps = (b.steps || b.items || b.stages || []).filter(Boolean);
  if (!steps.length) return '';
  const node = (s, i) => {
    const label = typeof s === 'string' ? s : (ddField(s, 'label', 'name', 'title') || '');
    const note = typeof s === 'object' ? ddField(s, 'note', 'detail') : '';
    const ic = typeof s === 'object' ? ddSafeIcon(s.icon) : null;
    return `<div class="dd-flow-step"><div class="dd-flow-num">${ic ? icon(ic, 'w-4 h-4') : (i + 1)}</div><div class="dd-flow-body"><div class="dd-flow-lab">${esc(label)}</div>${note ? `<div class="dd-flow-note">${esc(note)}</div>` : ''}</div></div>`;
  };
  return `<div class="dd-flow">${steps.map(node).join(`<span class="dd-flow-ar">${icon('arrowRight', 'w-4 h-4')}</span>`)}</div>`;
}

// Timeline — dated milestones down a rail (history, roadmap, key events).
function ddTimeline(b) {
  const items = (b.items || b.events || b.milestones || []).filter(Boolean);
  if (!items.length) return '';
  const rows = items.map((it, i) => `<div class="dd-tl-row"><div class="dd-tl-date">${esc(ddField(it, 'date', 'year', 'when') || '')}</div><div class="dd-tl-rail"><span class="dd-tl-dot" style="background:${ddColor(i)}"></span></div><div class="dd-tl-body"><div class="dd-tl-lab">${esc(ddField(it, 'label', 'title', 'event') || '')}</div>${ddField(it, 'note', 'detail') ? `<div class="dd-tl-note">${esc(ddField(it, 'note', 'detail'))}</div>` : ''}</div></div>`).join('');
  return `<div class="dd-tl">${rows}</div>`;
}

// Generic table — arrays or arrays-of-objects; numeric columns auto-right-align.
function ddTable(b) {
  let cols = b.columns || b.cols || b.headers || [];
  const rows = b.rows || b.data || [];
  if (!rows.length) return '';
  cols = cols.map(c => typeof c === 'string' ? { label: c } : { label: ddField(c, 'label', 'name', 'key') || '', align: c.align, key: c.key, unit: c.unit });
  if (!cols.length && rows[0] && !Array.isArray(rows[0])) cols = Object.keys(rows[0]).map(k => ({ label: k, key: k }));
  if (!cols.length && Array.isArray(rows[0])) cols = rows[0].map((_, i) => ({ label: '' }));
  const norm = r => Array.isArray(r) ? r : cols.map(c => r[c.key || c.label]);
  const numCol = cols.map((_, ci) => rows.every(r => { const v = norm(r)[ci]; return v == null || v === '' || ddToNum(v) != null; }) && rows.some(r => ddToNum(norm(r)[ci]) != null));
  const head = `<tr>${cols.map((c, ci) => `<th class="${(c.align === 'right' || numCol[ci]) ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr>`;
  const body = rows.map(r => { const cells = norm(r); const cls0 = ci => ci === 0 ? ' dd-td0' : ''; return `<tr>${cols.map((c, ci) => `<td class="${(c.align === 'right' || (numCol[ci] && ci > 0)) ? 'num' : ''}${cls0(ci)}">${ddValue(cells[ci], c.unit)}</td>`).join('')}</tr>`; }).join('');
  return `<div class="dd-tbl-wrap"><table class="dd-tbl"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

// Bullets — plain strings, or {head, text} titled points.
function ddBullets(b) {
  const items = (b.items || b.points || b.list || []).filter(x => x != null && x !== '');
  if (!items.length) return '';
  const cols = items.length > 5 ? ' dd-bullets-2' : '';
  const li = it => {
    if (typeof it !== 'object') return `<li><span class="dd-bl-mk">${icon('check', 'w-3.5 h-3.5', 3)}</span><span>${esc(it)}</span></li>`;
    const head = ddField(it, 'head', 'title', 'label'), text = ddField(it, 'text', 'detail', 'note') || '';
    return `<li><span class="dd-bl-mk">${icon(ddSafeIcon(it.icon) || 'check', 'w-3.5 h-3.5', 3)}</span><span>${head ? `<b>${esc(head)}</b>${text ? ' — ' : ''}` : ''}${esc(text)}</span></li>`;
  };
  return `<ul class="dd-bullets${cols}">${items.map(li).join('')}</ul>`;
}

// Callout — tinted highlight box (info / good / warn / bad / neutral).
const DD_TONES = { info: { c: '#2563EB', ic: 'info' }, good: { c: '#10B981', ic: 'check' }, warn: { c: '#F59E0B', ic: 'alert' }, bad: { c: '#E11D48', ic: 'alert' }, neutral: { c: '#64748B', ic: 'info' } };
function ddCallout(b) {
  const text = ddField(b, 'text', 'body', 'detail'), title = b.title;
  if (!text && !title) return '';
  const tn = DD_TONES[b.tone] || DD_TONES.info;
  return `<div class="dd-callout" style="--cc:${tn.c};background:${tint(tn.c, .07)};border-color:${tint(tn.c, .28)}"><span class="dd-callout-ico" style="color:${tn.c}">${icon(ddSafeIcon(b.icon) || tn.ic, 'w-4 h-4')}</span><div>${title ? `<div class="dd-callout-t">${esc(title)}</div>` : ''}${text ? `<div class="dd-callout-x">${esc(text)}</div>` : ''}</div></div>`;
}

// Key/value facts — two-column definition grid (deal terms, quick stats).
function ddKeyValue(b) {
  const items = (b.items || b.pairs || b.rows || []).filter(Boolean);
  if (!items.length) return '';
  const rows = items.map(it => `<div class="dd-kv-row"><span class="dd-kv-k">${esc(ddField(it, 'k', 'key', 'label', 'name') || '')}</span><span class="dd-kv-v">${ddValue(ddField(it, 'v', 'value', 'detail'), it.unit)}</span></div>`).join('');
  return `<div class="dd-kv">${rows}</div>`;
}

// Pull-quote — management commentary, customer testimonial.
function ddQuote(b) {
  const text = ddField(b, 'text', 'quote', 'body');
  if (!text) return '';
  const src = ddField(b, 'source', 'attribution', 'who');
  return `<figure class="dd-quote"><blockquote>${esc(text)}</blockquote>${src ? `<figcaption>— ${esc(src)}</figcaption>` : ''}</figure>`;
}

// Narrative paragraph(s).
function ddText(b) {
  const t = ddField(b, 'text', 'body', 'content');
  if (!t) return '';
  return (Array.isArray(t) ? t : [t]).filter(Boolean).map(p => `<p class="dd-text">${esc(p)}</p>`).join('');
}

// Unknown type: salvage anything renderable so no IM content is silently dropped.
function ddFallback(b) {
  if (Array.isArray(b.items) && b.items.length) return ddBullets({ items: b.items.map(x => typeof x === 'object' ? (ddField(x, 'label', 'name', 'text', 'title') || JSON.stringify(x)) : x) });
  const t = ddField(b, 'text', 'body', 'summary', 'detail');
  return t ? `<p class="dd-text">${esc(t)}</p>` : '';
}

const DD_RENDERERS = {
  kpis: ddKpis, kpi: ddKpis, stats: ddKpis, stat: ddKpis, metrics: ddKpis,
  bars: ddBars, bar: ddBars, barchart: ddBars, hbar: ddBars, ranking: ddBars,
  trend: ddTrend, line: ddTrend, linechart: ddTrend, trendline: ddTrend, area: ddTrend,
  donut: ddDonut, pie: ddDonut, doughnut: ddDonut, share: ddDonut, breakdown: ddDonut, mix: ddDonut,
  funnel: ddFunnel,
  flow: ddFlow, process: ddFlow, valuechain: ddFlow, steps: ddFlow, journey: ddFlow,
  timeline: ddTimeline, milestones: ddTimeline, history: ddTimeline, roadmap: ddTimeline,
  table: ddTable, grid: ddTable, matrix: ddTable,
  bullets: ddBullets, list: ddBullets, points: ddBullets, checklist: ddBullets,
  callout: ddCallout, note: ddCallout, highlight: ddCallout, insight: ddCallout, risk: ddCallout,
  keyvalue: ddKeyValue, keyvalues: ddKeyValue, facts: ddKeyValue, terms: ddKeyValue, details: ddKeyValue,
  quote: ddQuote, testimonial: ddQuote,
  text: ddText, paragraph: ddText, para: ddText, narrative: ddText,
};
const DD_SELF_TITLED = { callout: 1, note: 1, highlight: 1, insight: 1, risk: 1, quote: 1, testimonial: 1 };

function renderDDBlock(b) {
  if (!b || typeof b !== 'object' || !b.type) return '';
  const type = String(b.type).toLowerCase().replace(/[^a-z]/g, '');
  const R = DD_RENDERERS[type] || ddFallback;
  let body = '';
  try { body = R(b) || ''; } catch (_) { body = ''; }
  if (!body) return '';
  const head = DD_SELF_TITLED[type] ? '' : ddBlockHead(b);
  return `<div class="dd-block">${head}${body}${ddBlockCap(b)}</div>`;
}

function hasDeepDive(c) {
  return !!(c && c.deepDive && Array.isArray(c.deepDive.sections) &&
    c.deepDive.sections.some(s => s && Array.isArray(s.blocks) && s.blocks.some(x => x && x.type)));
}

const DD_SEC_ICONS = ['layers', 'trendingUp', 'factory', 'users', 'coins', 'target', 'globe', 'briefcase', 'gauge', 'sparkles', 'wallet', 'mapPin'];
function renderDDSection(s, i) {
  if (!s || !Array.isArray(s.blocks)) return null;
  const blocks = s.blocks.map(renderDDBlock).filter(Boolean).join('');
  if (!blocks) return null;
  const ic = ddSafeIcon(s.icon) || DD_SEC_ICONS[i % DD_SEC_ICONS.length];
  return h(`<section class="surface-card p-5 dd-sec">
    <div class="section-title"><span class="sec-ico">${icon(ic, 'w-4 h-4')}</span>${esc(s.title || ('Section ' + (i + 1)))}</div>
    ${s.summary ? `<p class="dd-sec-sum">${esc(s.summary)}</p>` : ''}
    <div class="dd-blocks">${blocks}</div></section>`);
}

function renderDeepDive(c) {
  const wrap = h('<div class="space-y-5"></div>');
  if (!hasDeepDive(c)) {
    if (c._deepDivePending) {
      wrap.appendChild(h(`<div class="coming"><div class="cs-ico dd-prep-ic">${icon('loader', 'w-6 h-6')}</div>
        <div class="text-[15px] font-semibold text-ink">Preparing the deep dive…</div>
        <p class="text-[13px] text-ink-muted mt-1 max-w-md">The core memo is ready — we're now unpacking the whole IM into visual sections. This usually takes another minute; it'll appear here on its own, and it's saved so you can come back to it.</p></div>`));
      return wrap;
    }
    const failedMsg = typeof c._deepDiveFailed === 'string' ? c._deepDiveFailed : '';
    const failed = !!c._deepDiveFailed;
    const needsReupload = /re-upload/i.test(failedMsg);   // built before we stored the IM — a retry can't help; only a fresh upload can
    const canRetry = !isSample(c) && !needsReupload;
    const body = failed
      ? ('The core memo is complete and ready to show — ' + (needsReupload
          ? 'but this deal was built before we started saving the IM for rebuilds, so please <b>re-upload it once</b> to add the deep dive. New deals won’t need this.'
          : (failedMsg ? esc(failedMsg) : 'the visual IM unpacking just couldn’t be built this time.') + (canRetry ? ' Try again below.' : '')))
      : 'Add a deal with an Information Memorandum and this tab unpacks everything inside it — market, business model, unit economics, growth, customers, use of proceeds and more — as visual sections, so you never have to open the PDF.';
    const card = h(`<div class="coming"><div class="cs-ico">${icon('bookOpen', 'w-6 h-6')}</div>
      <div class="text-[15px] font-semibold text-ink">${failed ? 'The deep dive didn’t finish' : 'The IM deep-dive appears here'}</div>
      <p class="text-[13px] text-ink-muted mt-1 max-w-md">${body}</p>
      ${canRetry ? `<button class="hdr-btn dd-retry-btn" type="button" style="margin-top:14px;color:#fff;background:${BRAND.navy};border-color:${BRAND.navy}">${icon('refreshCw', 'w-4 h-4')} Try the deep dive again</button>` : ''}</div>`);
    if (canRetry) card.querySelector('.dd-retry-btn').addEventListener('click', () => retryDeepDive(c.id));
    wrap.appendChild(card);
    return wrap;
  }
  const dd = c.deepDive;
  const n = dd.sections.filter(s => s && Array.isArray(s.blocks) && s.blocks.length).length;
  wrap.appendChild(h(`<div class="dd-hero">
      <div class="dd-hero-ico">${icon('bookOpen', 'w-5 h-5')}</div>
      <div><div class="dd-hero-t">Everything in the Information Memorandum — unpacked</div>
        <div class="dd-hero-s">${esc(dd.source || 'From the IM and supporting documents')} · ${n} section${n === 1 ? '' : 's'}. You shouldn't need to open the PDF.</div></div></div>`));
  if (dd.summary) wrap.appendChild(h(`<div class="dd-execsum"><div class="dd-execsum-h">${icon('sparkles', 'w-3.5 h-3.5')} In a nutshell</div><p>${esc(dd.summary)}</p></div>`));
  dd.sections.forEach((s, i) => { const node = renderDDSection(s, i); if (node) wrap.appendChild(node); });
  return wrap;
}

// Print/export: same blocks, folded into the report's section styling.
function frDeepDive(c) {
  if (!hasDeepDive(c)) return '';
  const secs = c.deepDive.sections.map((s, i) => {
    if (!s || !Array.isArray(s.blocks)) return '';
    const blocks = s.blocks.map(renderDDBlock).filter(Boolean).join('');
    if (!blocks) return '';
    return `<div class="fr-dd-sec"><h3>${esc(s.title || ('Part ' + (i + 1)))}</h3>${s.summary ? `<p class="fr-cap">${esc(s.summary)}</p>` : ''}<div class="dd-blocks">${blocks}</div></div>`;
  }).filter(Boolean).join('');
  return secs ? (c.deepDive.summary ? `<p class="fr-note" style="margin-bottom:10px">${esc(c.deepDive.summary)}</p>` : '') + secs : '';
}

/* ---- 7g-bis. Excel Analysis tab — the whole Excel model turned into charts. Same generic block
 * doc as the Deep Dive (source/summary/sections[].blocks[]), so it reuses renderDDSection /
 * renderDDBlock verbatim; only the source field and the empty/pending copy differ. --------------- */
function hasExcelAnalysis(c) {
  return !!(c && c.excelAnalysis && Array.isArray(c.excelAnalysis.sections) &&
    c.excelAnalysis.sections.some(s => s && Array.isArray(s.blocks) && s.blocks.some(x => x && x.type)));
}

function renderExcelAnalysis(c) {
  const wrap = h('<div class="space-y-5"></div>');
  if (!hasExcelAnalysis(c)) {
    // First time the tab is opened for a real deal that has no analysis yet (e.g. one built before
    // this feature existed) → kick the build once so it just appears, zero clicks. Guarded so it
    // fires only once per session and never for the built-in sample or a failed/pending build.
    if (!c._excelPending && !c._excelFailed && !isSample(c) && !c._xaAutoTried) {
      c._xaAutoTried = true; c._excelPending = true; c._xaPendingSince = Date.now();
      startExcelAnalysis(c.id, c._xaInputs || {});
    }
    if (c._excelPending) {
      wrap.appendChild(h(`<div class="coming"><div class="cs-ico dd-prep-ic">${icon('loader', 'w-6 h-6')}</div>
        <div class="text-[15px] font-semibold text-ink">Analysing the Excel model…</div>
        <p class="text-[13px] text-ink-muted mt-1 max-w-md">We're reading the whole spreadsheet and turning its trends and breakdowns into charts. This usually takes a minute or two; it'll appear here on its own, and it's saved so you can come back to it.</p></div>`));
      return wrap;
    }
    const failedMsg = typeof c._excelFailed === 'string' ? c._excelFailed : '';
    const failed = !!c._excelFailed;
    const needsReupload = /re-add|re-upload|no stored excel|no Excel/i.test(failedMsg);   // built before we stored the Excel — only a fresh upload can help
    const canRetry = !isSample(c) && !needsReupload;
    const body = failed
      ? ('The core memo is ready — ' + (needsReupload
          ? 'but this deal has no Excel saved for a rebuild, so please <b>re-add it once with the Excel attached</b> to build the analysis. New deals won’t need this.'
          : (failedMsg ? esc(failedMsg) : 'the Excel analysis just couldn’t be built this time.') + (canRetry ? ' Try again below.' : '')))
      : 'Add a deal with an Excel financial model and this tab turns the whole model — revenue and cost trends, margins, segment splits, unit economics, whatever the sheet breaks out — into colourful charts, so you never have to open the spreadsheet.';
    const card = h(`<div class="coming"><div class="cs-ico">${icon('gauge', 'w-6 h-6')}</div>
      <div class="text-[15px] font-semibold text-ink">${failed ? 'The Excel analysis didn’t finish' : 'The Excel analysis appears here'}</div>
      <p class="text-[13px] text-ink-muted mt-1 max-w-md">${body}</p>
      ${canRetry ? `<button class="hdr-btn xa-retry-btn" type="button" style="margin-top:14px;color:#fff;background:${BRAND.navy};border-color:${BRAND.navy}">${icon('refreshCw', 'w-4 h-4')} ${failed ? 'Try the analysis again' : 'Build Excel analysis'}</button>` : ''}</div>`);
    if (canRetry) card.querySelector('.xa-retry-btn').addEventListener('click', () => retryExcelAnalysis(c.id));
    wrap.appendChild(card);
    return wrap;
  }
  const xa = c.excelAnalysis;
  const n = xa.sections.filter(s => s && Array.isArray(s.blocks) && s.blocks.length).length;
  wrap.appendChild(h(`<div class="dd-hero">
      <div class="dd-hero-ico">${icon('gauge', 'w-5 h-5')}</div>
      <div><div class="dd-hero-t">The Excel model — unpacked into charts</div>
        <div class="dd-hero-s">${esc(xa.source || 'From the uploaded Excel financial model')} · ${n} section${n === 1 ? '' : 's'}. You shouldn't need to open the spreadsheet.</div></div></div>`));
  if (xa.summary) wrap.appendChild(h(`<div class="dd-execsum"><div class="dd-execsum-h">${icon('sparkles', 'w-3.5 h-3.5')} In a nutshell</div><p>${esc(xa.summary)}</p></div>`));
  xa.sections.forEach((s, i) => { const node = renderDDSection(s, i); if (node) wrap.appendChild(node); });
  return wrap;
}

// Print/export: same blocks, folded into the report's section styling (mirrors frDeepDive).
function frExcelAnalysis(c) {
  if (!hasExcelAnalysis(c)) return '';
  const secs = c.excelAnalysis.sections.map((s, i) => {
    if (!s || !Array.isArray(s.blocks)) return '';
    const blocks = s.blocks.map(renderDDBlock).filter(Boolean).join('');
    if (!blocks) return '';
    return `<div class="fr-dd-sec"><h3>${esc(s.title || ('Part ' + (i + 1)))}</h3>${s.summary ? `<p class="fr-cap">${esc(s.summary)}</p>` : ''}<div class="dd-blocks">${blocks}</div></div>`;
  }).filter(Boolean).join('');
  return secs ? (c.excelAnalysis.summary ? `<p class="fr-note" style="margin-bottom:10px">${esc(c.excelAnalysis.summary)}</p>` : '') + secs : '';
}

/* ---- 7h. Returns tab — the real PE returns model (JRG/Bloom methodology) ------
 * Not a toy any more: we enter at a multiple of a REAL model year's EBITDA, bridge
 * enterprise value to equity via net debt, size our stake off post-money, and exit
 * on MANAGEMENT'S OWN PROJECTED EBITDA (from the Financials tab) — with a knob to
 * haircut that projection ("management under-delivers by X%"). Outputs MoIC + IRR
 * and a full entry→exit bridge, plus an entry×exit sensitivity grid. ---------- */

// FY label → 2-digit number for spacing the holding period. "FY26"/"FY2026"/"FY26E" → 26.
function fyToNum(y) {
  const m = String(y == null ? '' : y).match(/(\d{2,4})/);
  if (!m) return null;
  let n = parseInt(m[1], 10);
  if (n >= 1900) n -= 2000;                 // FY2026 → 26
  return n;
}
// Value of a financials row at a given year label (null when absent / non-numeric).
function finAt(c, rowKey, year) {
  const f = c.financials || {}, yrs = f.years || [], rows = f.rows || {};
  const i = yrs.indexOf(year);
  if (i < 0 || !Array.isArray(rows[rowKey])) return null;
  const v = rows[rowKey][i];
  return (typeof v === 'number' && isFinite(v)) ? v : null;
}
const ebitdaAt = (c, year) => finAt(c, 'ebitda', year);
// Net debt at a year = total debt − cash (null when the model carries neither).
function netDebtAt(c, year) {
  const d = finAt(c, 'debt', year), cash = finAt(c, 'cash', year);
  if (d == null && cash == null) return null;
  return (d || 0) - (cash || 0);
}
// The three valuation bases Faraz described — the ONLY three. EBITDA/Revenue price the
// enterprise (bridge net debt + minority to equity); PAT is already an equity (P/E) basis.
const RET_BASES = [
  { key: 'ebitda',  label: 'EBITDA',  mult: 'EV/EBITDA',  equity: false },
  { key: 'revenue', label: 'Revenue', mult: 'EV/Revenue', equity: false },
  { key: 'pat',     label: 'PAT',     mult: 'P/E',        equity: true  },
];
const retBasis   = k => RET_BASES.find(b => b.key === k) || RET_BASES[0];
const isEquityBasis = k => retBasis(k).equity;                 // PAT (P/E) → equity directly, no net-debt bridge
const basisMultLabel = k => retBasis(k).mult;                  // 'EV/EBITDA' | 'EV/Revenue' | 'P/E'
// The model figure for a basis at a year (EBITDA / Revenue / PAT), straight from the Financials tab.
const metricAt = (c, basis, year) => finAt(c, basis === 'ebitda' ? 'ebitda' : basis, year);
// Minority interest at a year: a financials row if the model carries one, else the returns default, else 0.
function minorityAt(c, year) {
  const m = finAt(c, 'minority', year);
  if (m != null) return m;
  const dm = c.returns && c.returns.defaults ? Number(c.returns.defaults.minorityCr) : null;
  return (dm != null && !isNaN(dm)) ? dm : 0;
}
// The year immediately after `year` in the model horizon — LTM is `year`, NTM is the next one.
function yearAfter(c, year) {
  const yrs = (c.financials && c.financials.years) || [];
  const i = yrs.indexOf(year);
  return (i >= 0 && i + 1 < yrs.length) ? yrs[i + 1] : null;
}
// Median trading-comp multiple matched to a basis (EV/EBITDA, EV/Revenue or P/E) — feeds the
// entry-multiple hint and the sensible default, exactly as Faraz asked ("uska median … side me hint").
function compsMedianMult(c, basis) {
  const tr = c.comps && c.comps.trading;
  if (!tr || !Array.isArray(tr.rows) || !tr.rows.length) return null;
  const key = basis === 'revenue' ? 'evRevenue' : basis === 'pat' ? 'pe' : 'evEbitda';
  return peerMedian(tr.rows.map(r => r && r[key]));
}
// The inputs the controls hold — falls back to sensible, model-derived defaults so
// every deal (seed or upload) gets a coherent returns model with zero setup.
function returnsInputs(c) {
  const r = c.returns || {}, d = r.defaults || {};
  const f = c.financials || {}, yrs = Array.isArray(f.years) ? f.years : [];
  const posY = y => { const e = ebitdaAt(c, y); return typeof e === 'number' && e > 0; };
  const inYrs = y => y && yrs.includes(y);

  // Entry year: prefer a stated one; else the latest actual with real EBITDA; else the first positive year.
  let entryYear = [r.entryYear, r.startYear].find(y => inYrs(y) && posY(y)) || '';
  if (!entryYear) {
    const ai = yrs.indexOf(f.actualsThrough);
    if (ai >= 0 && posY(yrs[ai])) entryYear = yrs[ai];
    else { for (let i = Math.max(ai, 0); i < yrs.length; i++) if (posY(yrs[i])) { entryYear = yrs[i]; break; } }
    if (!entryYear) entryYear = yrs.find(posY) || f.actualsThrough || yrs[0] || '';
  }
  // Exit year: prefer a stated one; else the last projected year with real EBITDA (the model horizon).
  let exitYear = inYrs(r.exitYear) ? r.exitYear : '';
  if (!exitYear) { for (let i = yrs.length - 1; i >= 0; i--) if (posY(yrs[i])) { exitYear = yrs[i]; break; } }
  if (!exitYear || fyToNum(exitYear) <= fyToNum(entryYear)) exitYear = yrs[yrs.length - 1] || entryYear;

  const invDefault = Number(r.investmentCr) > 0 ? Number(r.investmentCr) : Math.round((ebitdaAt(c, entryYear) || 50) * 2);
  // Basis: EBITDA / Revenue / PAT. Old memos stored exitBasis:'pe' — map it to the new 'pat'.
  const normBasis = (b, dflt) => (b === 'revenue' || b === 'ebitda' || b === 'pat') ? b : (b === 'pe' ? 'pat' : dflt);
  const entryBasis = normBasis(d.entryBasis, 'ebitda');
  const exitBasis  = normBasis(d.exitBasis,  entryBasis === 'pat' ? 'pat' : 'ebitda');
  // Default multiple: prefer a stated one; else the peer-median from the trading comps (Faraz's rule); else a floor.
  const med = compsMedianMult(c, entryBasis);
  const entryDefault = Number(d.entryX) > 0 ? Number(d.entryX)
    : (med != null ? Math.round(med * 2) / 2 : (entryBasis === 'pat' ? 18 : entryBasis === 'revenue' ? 2 : 12));
  const exitMed = compsMedianMult(c, exitBasis);
  const exitDefault = Number(d.exitX) > 0 ? Number(d.exitX)
    : (exitMed != null ? Math.round(exitMed * 2) / 2 : entryDefault);
  return {
    investmentCr: invDefault,
    entryYear, exitYear, entryBasis, exitBasis,
    entryX: entryDefault,
    exitX:  exitDefault,
    underdeliverPct: Number(d.underdeliverPct) >= 0 ? Number(d.underdeliverPct) : 0,
  };
}

// Pure calc — entry EV → net-debt bridge → stake, then exit priced on EV/EBITDA OR P/E → MoIC, IRR.
// Entry is always EV/EBITDA (the standard PE entry). Exit can be priced on the projected EBITDA
// (bridge net debt to equity) or on the projected profit via a P/E (already an equity multiple).
function computeReturns(c, v) {
  const investment = Number(v.investmentCr) || 0;
  const haircut    = Math.max(0, Math.min(100, Number(v.underdeliverPct) || 0)) / 100;
  const entryB = v.entryBasis || 'ebitda', exitB = v.exitBasis || 'ebitda';

  // ---- Entry: metric × multiple → EV → (− net debt − minority) → pre-money equity.
  //      PAT (P/E) is an equity multiple, so it lands on equity directly (no bridge).
  const entryMetric   = metricAt(c, entryB, v.entryYear);
  const entryNetDebt  = netDebtAt(c, v.entryYear) || 0;
  const entryMinority = minorityAt(c, v.entryYear) || 0;
  let entryEV, preMoney;
  if (isEquityBasis(entryB)) {
    preMoney = (entryMetric || 0) * v.entryX;
    entryEV  = preMoney + entryNetDebt + entryMinority;           // implied EV = equity + net debt + minority (JRG row 13)
  } else {
    entryEV  = (entryMetric || 0) * v.entryX;
    preMoney = entryEV - entryNetDebt - entryMinority;
  }
  const postMoney = preMoney + investment;                        // post-money (after our primary cheque)
  const stakePct  = postMoney > 0 ? Math.min(1, investment / postMoney) : 0;

  // ---- Exit: management's own projection (haircut for under-delivery), priced on the exit basis.
  const rawExit     = metricAt(c, exitB, v.exitYear);
  const exitMetric  = rawExit == null ? null : rawExit * (1 - haircut);
  const exitNetDebt = netDebtAt(c, v.exitYear) || 0;
  const exitMinority = minorityAt(c, v.exitYear) || 0;
  let exitEV, exitEquity;
  if (isEquityBasis(exitB)) {
    exitEquity = (exitMetric || 0) * v.exitX;
    exitEV     = exitEquity + exitNetDebt + exitMinority;         // implied EV, for reference only
  } else {
    exitEV     = (exitMetric || 0) * v.exitX;
    exitEquity = exitEV - exitNetDebt - exitMinority;
  }
  const proceeds = Math.max(0, stakePct * exitEquity);

  const years = Math.max(1, (fyToNum(v.exitYear) - fyToNum(v.entryYear)) || 1);
  const moneyBack = investment > 0 ? proceeds / investment : 0;
  const yearlyReturn = moneyBack > 0 ? (Math.pow(moneyBack, 1 / years) - 1) * 100 : -100;

  // ---- Implied entry multiples (LTM = entry year, NTM = next year) — compare vs the comps median.
  const ntm = yearAfter(c, v.entryYear);
  const div = (a, b) => (a != null && b != null && b !== 0) ? a / b : null;
  const implied = {
    evEbitdaLtm: div(entryEV, finAt(c, 'ebitda',  v.entryYear)),
    evEbitdaNtm: div(entryEV, finAt(c, 'ebitda',  ntm)),
    evRevLtm:    div(entryEV, finAt(c, 'revenue', v.entryYear)),
    evRevNtm:    div(entryEV, finAt(c, 'revenue', ntm)),
    peLtm:       div(preMoney, finAt(c, 'pat',    v.entryYear)),
    peNtm:       div(preMoney, finAt(c, 'pat',    ntm)),
  };

  return {
    entryBasis: entryB, exitBasis: exitB, peMode: isEquityBasis(exitB),
    entryMetric, entryEV, entryNetDebt, entryMinority, preMoney, postMoney, stakePct,
    exitMetric, exitEV, exitNetDebt, exitMinority, exitEquity,
    investment, proceeds, moneyBack, yearlyReturn, years, implied,
    // legacy aliases still read by the chart / older callers
    entryEbitda: finAt(c, 'ebitda', v.entryYear),
    exitEbitda: exitB === 'ebitda' ? exitMetric : null,
    exitPat:    exitB === 'pat'    ? exitMetric : null,
  };
}
function readReturns(root) {
  const g = k => { const el = root.querySelector(`[data-ret="${k}"]`); return el ? el.value : null; };
  const okB = b => (b === 'revenue' || b === 'ebitda' || b === 'pat') ? b : 'ebitda';
  return {
    investmentCr: Number(g('investmentCr')),
    entryYear: g('entryYear'), exitYear: g('exitYear'),
    entryBasis: okB(g('entryBasis')), exitBasis: okB(g('exitBasis')),
    entryX: Number(g('entryX')), exitX: Number(g('exitX')),
    underdeliverPct: Number(g('underdeliverPct')),
  };
}

// Sliders (numeric) + the year/basis dropdowns. Entry/exit multiple labels depend on the chosen basis.
const RETURN_SLIDERS = [
  { key: 'entryX',          label: 'Entry price — multiple',       min: 1, max: 40, step: 0.5, suffix: '×' },
  { key: 'exitX',           label: 'Exit price — multiple',        min: 1, max: 45, step: 0.5, suffix: '×' },
  { key: 'underdeliverPct', label: 'If management under-delivers', min: 0, max: 40, step: 5,   suffix: '%' },
];
// The entry/exit multiple slider labels track the basis (EV/EBITDA · EV/Revenue · P/E).
const entrySliderLabel = basis => `Entry price — ${basisMultLabel(basis)} multiple`;
const exitSliderLabel  = basis => `Exit price — ${basisMultLabel(basis)} multiple`;

function renderReturns(c) {
  const d = returnsInputs(c);
  const f = c.financials || {}, yrs = Array.isArray(f.years) ? f.years : [];
  const wrap = h('<div class="space-y-5"></div>');

  const chequeMax = Math.max(500, roundNiceUI((Number(d.investmentCr) || 100) * 3));
  const yearOpts = (sel, basis) => yrs.map(y => {
    const e = metricAt(c, basis, y), lab = retBasis(basis).label;
    return `<option value="${esc(y)}"${y === sel ? ' selected' : ''}>${esc(y)}${e != null ? ` · ${lab} ${fmtCr(e)}` : ''}</option>`;
  }).join('');
  const basisOpts = sel => RET_BASES.map(b => `<option value="${b.key}"${b.key === sel ? ' selected' : ''}>${b.label} (${b.mult})</option>`).join('');

  // Two big answers.
  wrap.appendChild(h(`
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div class="result-card">
        <div class="result-kick">Money multiple (MoIC)</div>
        <div class="result-num tnum" data-out="moneyBack">—</div>
        <div class="result-sub" data-out="moneySub">on the cheque invested</div>
      </div>
      <div class="result-card">
        <div class="result-kick">Annual return (IRR)</div>
        <div class="result-num tnum" data-out="yearly">—</div>
        <div class="result-sub" data-out="yearlySub">compounded, per year</div>
      </div>
    </div>`));

  // Assumptions (cheque + years + multiples + haircut) and the entry→exit bridge, side by side.
  const grid = h('<div class="grid gap-5 lg:grid-cols-2 items-start"></div>');

  const inputs = h(`<div class="surface-card p-5"><div class="section-title"><span class="sec-ico">${icon('sliders', 'w-4 h-4')}</span>Your assumptions</div></div>`);
  // Cheque size
  inputs.appendChild(h(`
    <div class="slider-row">
      <div class="slider-head"><span class="slider-label">Our cheque (primary)</span>
        <span class="slider-val tnum" data-val="investmentCr">${fmtCr(d.investmentCr)}</span></div>
      <input type="range" class="range" data-ret="investmentCr" data-slider="investmentCr" data-kind="cr" min="25" max="${chequeMax}" step="25" value="${d.investmentCr}" aria-label="Our cheque">
    </div>`));
  // Basis (EBITDA / Revenue / PAT — the only three) + entry/exit years + exit basis.
  inputs.appendChild(h(`
    <div class="slider-row">
      <label class="ret-sel"><span>Value the business on</span>
        <select class="ret-dd" data-ret="entryBasis" aria-label="Entry basis">${basisOpts(d.entryBasis)}</select></label>
      <div class="ret-selects mt-3">
        <label class="ret-sel"><span>Enter in</span>
          <select class="ret-dd" data-ret="entryYear" aria-label="Entry year">${yearOpts(d.entryYear, d.entryBasis)}</select></label>
        <label class="ret-sel"><span>Exit in</span>
          <select class="ret-dd" data-ret="exitYear" aria-label="Exit year">${yearOpts(d.exitYear, d.exitBasis)}</select></label>
      </div>
      <p class="text-[11.5px] text-ink-hint mt-2" data-out="holdNote">—</p>
      <label class="ret-sel mt-3"><span>Exit priced on</span>
        <select class="ret-dd" data-ret="exitBasis" aria-label="Exit basis">${basisOpts(d.exitBasis)}</select></label>
    </div>`));
  // Numeric sliders (the entry multiple carries a live comps-median hint underneath).
  RETURN_SLIDERS.forEach(s => {
    const label = s.key === 'entryX' ? entrySliderLabel(d.entryBasis) : s.key === 'exitX' ? exitSliderLabel(d.exitBasis) : s.label;
    const hint = s.key === 'entryX' ? `<p class="ret-hint" data-out="entryHint"></p>` : '';
    inputs.appendChild(h(`
      <div class="slider-row">
        <div class="slider-head">
          <span class="slider-label" data-slabel="${s.key}">${esc(label)}</span>
          <span class="slider-val tnum" data-val="${s.key}">${d[s.key]}${esc(s.suffix)}</span>
        </div>
        <input type="range" class="range" data-ret="${s.key}" data-slider="${s.key}" data-suffix="${esc(s.suffix)}" min="${s.min}" max="${s.max}" step="${s.step}" value="${d[s.key]}" aria-label="${esc(label)}">
        ${hint}
      </div>`));
  });
  grid.appendChild(inputs);

  // Entry → exit bridge + supporting chart.
  const bridge = h(`
    <div class="surface-card p-5">
      <div class="section-title"><span class="sec-ico">${icon('scale', 'w-4 h-4')}</span>Entry → exit bridge</div>
      <div class="ret-bridge" data-out="bridge"></div>
      <div class="text-[12.5px] text-ink-muted mt-3 mb-1" data-out="chartCap">—</div>
      <div class="chart-box" style="height:170px"><canvas data-chart="returns"></canvas></div>
    </div>`);
  grid.appendChild(bridge);
  wrap.appendChild(grid);

  // Implied entry multiples vs the comps median (Faraz: compare implied P/E with median comps).
  wrap.appendChild(h(`
    <div class="surface-card p-5">
      <div class="section-title"><span class="sec-ico">${icon('scale', 'w-4 h-4')}</span>Implied entry multiples</div>
      <p class="text-[12px] text-ink-muted mb-3">What your entry valuation implies across EV/EBITDA, EV/Revenue and P/E — last- and next-twelve-months — set against the trading-comps median.</p>
      <div class="peer-scroll"><div data-out="implied"></div></div>
    </div>`));

  // Three self-constructing sensitivity grids — exactly the JRG "Returns Output" tab.
  wrap.appendChild(h(`
    <div class="surface-card p-5">
      <div class="section-title"><span class="sec-ico">${icon('gauge', 'w-4 h-4')}</span>Sensitivity — all scenarios</div>
      <p class="text-[12px] text-ink-muted mb-4">Entry multiple down the side, exit (or management under-delivery) across the top. Your current pick is highlighted; each grid rebuilds live as you move the assumptions.</p>
      <div class="sens-stack">
        <div><div class="sens-h">1 · Money multiple (MoIC) — entry × exit</div><div class="peer-scroll"><div data-out="sensiMoic"></div></div></div>
        <div><div class="sens-h">2 · Annual return (IRR) — entry × exit</div><div class="peer-scroll"><div data-out="sensiIrrExit"></div></div></div>
        <div><div class="sens-h">3 · Annual return (IRR) — entry × management under-delivery</div><div class="peer-scroll"><div data-out="sensiIrrUnder"></div></div></div>
      </div>
      <div class="sens-legend"><span class="sk g3"></span>≥25%<span class="sk g2"></span>18–25%<span class="sk g1"></span>10–18%<span class="sk g0"></span>&lt;10% IRR</div>
    </div>`));

  wrap.appendChild(h('<p class="text-[12px] text-ink-hint">Exit figures are management’s own projections from the Financials tab; EV/EBITDA & EV/Revenue bridge net debt (and minority interest) to equity, while P/E lands on equity directly. Illustrative — not a full valuation.</p>'));

  // Live inputs. A basis change resets that leg's multiple to the new basis's comps median (Faraz: default = median).
  wrap.querySelectorAll('[data-ret]').forEach(inp => {
    if (inp.dataset.ret === 'entryBasis' || inp.dataset.ret === 'exitBasis') return;
    const ev = inp.tagName === 'SELECT' ? 'change' : 'input';
    inp.addEventListener(ev, () => recomputeReturns(c, wrap));
  });
  [['entryBasis', 'entryX'], ['exitBasis', 'exitX']].forEach(([bkey, xkey]) => {
    const sel = wrap.querySelector(`[data-ret="${bkey}"]`);
    if (!sel) return;
    sel.addEventListener('change', () => {
      const med = compsMedianMult(c, sel.value);
      const def = med != null ? Math.round(med * 2) / 2 : (sel.value === 'pat' ? 18 : sel.value === 'revenue' ? 2 : 12);
      const slider = wrap.querySelector(`[data-ret="${xkey}"]`);
      if (slider) slider.value = def;
      recomputeReturns(c, wrap);
    });
  });
  requestAnimationFrame(() => recomputeReturns(c, wrap));   // set numbers (chart syncs once built)
  return wrap;
}

// Round a number up to a clean slider ceiling (25s below 500, else 50s).
function roundNiceUI(n) { const step = n < 500 ? 25 : 50; return Math.max(step, Math.ceil(n / step) * step); }

// The entry→exit bridge, rendered as two stacked mini-tables. Labels track the basis:
// EBITDA/Revenue bridge net debt + minority to equity; PAT (P/E) lands on equity directly.
function returnsBridgeHTML(c, v, out) {
  const cr = n => n == null ? '—' : fmtCr(Math.round(n));
  const rows = list => list.filter(Boolean).map(([k, val, cls]) => `<tr class="${cls || ''}"><td>${k}</td><td class="num">${val}</td></tr>`).join('');
  const hc = Number(v.underdeliverPct) > 0 ? ` <span class="ret-haircut">-${v.underdeliverPct}%</span>` : '';
  const eB = retBasis(v.entryBasis), xB = retBasis(v.exitBasis);
  const entryRows = eB.equity ? [
      [`Entry ${eB.label} (${esc(v.entryYear)})`, cr(out.entryMetric)],
      [`× Entry ${eB.mult}`, v.entryX + '×'],
      [`Pre-money equity`, cr(out.preMoney), 'sub'],
      [`+ Our cheque (primary)`, cr(out.investment)],
      [`Post-money equity`, cr(out.postMoney), 'tot'],
      [`Our stake`, (out.stakePct * 100).toFixed(1) + '%', 'hl'],
    ] : [
      [`Entry ${eB.label} (${esc(v.entryYear)})`, cr(out.entryMetric)],
      [`× Entry ${eB.mult}`, v.entryX + '×'],
      [`Enterprise value`, cr(out.entryEV)],
      [`− Net debt`, cr(out.entryNetDebt)],
      out.entryMinority ? [`− Minority interest`, cr(out.entryMinority)] : null,
      [`Pre-money equity`, cr(out.preMoney), 'sub'],
      [`+ Our cheque (primary)`, cr(out.investment)],
      [`Post-money equity`, cr(out.postMoney), 'tot'],
      [`Our stake`, (out.stakePct * 100).toFixed(1) + '%', 'hl'],
    ];
  const exitRows = xB.equity ? [
      [`Exit ${xB.label} (${esc(v.exitYear)})${hc}`, cr(out.exitMetric)],
      [`× Exit ${xB.mult}`, v.exitX + '×'],
      [`Exit equity value`, cr(out.exitEquity), 'sub'],
      [`× Our stake`, (out.stakePct * 100).toFixed(1) + '%'],
      [`Our proceeds`, cr(out.proceeds), 'tot hl'],
    ] : [
      [`Exit ${xB.label} (${esc(v.exitYear)})${hc}`, cr(out.exitMetric)],
      [`× Exit ${xB.mult}`, v.exitX + '×'],
      [`Enterprise value`, cr(out.exitEV)],
      [`− Net debt`, cr(out.exitNetDebt)],
      out.exitMinority ? [`− Minority interest`, cr(out.exitMinority)] : null,
      [`Exit equity value`, cr(out.exitEquity), 'sub'],
      [`× Our stake`, (out.stakePct * 100).toFixed(1) + '%'],
      [`Our proceeds`, cr(out.proceeds), 'tot hl'],
    ];
  return `
    <table class="ret-bridge-tbl"><tbody>${rows(entryRows)}</tbody></table>
    <table class="ret-bridge-tbl mt-2"><tbody>${rows(exitRows)}</tbody></table>`;
}

// Multiple axis for a sensitivity grid: five steps centred on the current pick.
const retAxisMult = base => [-2, -1, 0, 1, 2].map(s => Math.max(1, Math.round((base + s) * 2) / 2));
const RET_UNDER_AXIS = [0, 5, 10, 15, 20];

// One sensitivity grid. Rows = entry multiple; cols = exit multiple (kind 'exit') or management
// under-delivery % (kind 'under'). metric = 'moic' | 'irr'. Mirrors the three JRG "Returns Output" tables.
function sensiGridHTML(c, v, kind, metric) {
  const rowAxis = retAxisMult(v.entryX);
  const cols = kind === 'under' ? RET_UNDER_AXIS : retAxisMult(v.exitX);
  const colUnit = kind === 'under' ? '%' : '×';
  const colLab = kind === 'under' ? 'Under-delivery' : (basisMultLabel(v.exitBasis) + ' at exit');
  const fmtCell = metric === 'moic'
    ? (o => o.moneyBack > 0 ? o.moneyBack.toFixed(1) + '×' : '—')
    : (o => o.yearlyReturn > -100 ? Math.round(o.yearlyReturn) + '%' : '—');
  const head = `<tr><th class="cnr">Entry ${esc(basisMultLabel(v.entryBasis))} ╲ ${esc(colLab)}</th>${cols.map(x => `<th class="num">${x}${colUnit}</th>`).join('')}</tr>`;
  const body = rowAxis.map(rx => {
    const cells = cols.map(cx => {
      const vv = kind === 'under' ? { ...v, entryX: rx, underdeliverPct: cx } : { ...v, entryX: rx, exitX: cx };
      const out = computeReturns(c, vv);
      const irr = out.yearlyReturn;
      const cls = irr >= 25 ? 'g3' : irr >= 18 ? 'g2' : irr >= 10 ? 'g1' : 'g0';
      const here = (rx === v.entryX && (kind === 'under' ? cx === v.underdeliverPct : cx === v.exitX)) ? ' here' : '';
      return `<td class="num sens ${cls}${here}">${fmtCell(out)}</td>`;
    }).join('');
    return `<tr><th class="num">${rx}×</th>${cells}</tr>`;
  }).join('');
  return `<table class="sens-tbl"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

// Implied entry multiples (LTM & NTM) against the trading-comps median — Faraz's "compare with median comps".
function impliedMultiplesHTML(c, out) {
  const im = out.implied || {};
  const m1 = x => x == null ? '—' : (Math.round(x * 10) / 10) + '×';
  const med = { ebitda: compsMedianMult(c, 'ebitda'), revenue: compsMedianMult(c, 'revenue'), pat: compsMedianMult(c, 'pat') };
  const row = (label, ltm, ntm, medv) => `<tr><td>${label}</td><td class="num">${m1(ltm)}</td><td class="num">${m1(ntm)}</td><td class="num med">${m1(medv)}</td></tr>`;
  return `<table class="comps-tbl impl-tbl">
    <thead><tr><th>Implied at entry</th><th class="num">LTM</th><th class="num">NTM</th><th class="num">Comps median</th></tr></thead>
    <tbody>
      ${row('EV / EBITDA', im.evEbitdaLtm, im.evEbitdaNtm, med.ebitda)}
      ${row('EV / Revenue', im.evRevLtm, im.evRevNtm, med.revenue)}
      ${row('P / E', im.peLtm, im.peNtm, med.pat)}
    </tbody></table>`;
}

// Peer valuation sanity-check — reads the optional c.peers block. Table-first.
function peerMedian(vals) {
  const s = vals.filter(v => v != null && !isNaN(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function renderPeerComps(c) {
  const p = c.peers;
  if (!p || !Array.isArray(p.rows) || !p.rows.length) return null;
  const unit = p.unit || '';
  const peerVals = p.rows.map(r => r.value).filter(v => v != null && !isNaN(v));
  const hasNumbers = peerVals.length > 0 || (p.self && p.self.value != null);   // a real comparable metric?
  const tag = listed => `<span class="peer-tag ${listed ? 'lst' : 'prv'}">${listed ? 'Listed' : 'Private'}</span>`;

  let tableHtml, vline = '', footHint;
  if (hasNumbers) {
    const fmtVal = v => v == null ? '—' : (unit === '%' ? v + '%' : v + (unit || ''));
    const median = peerMedian(peerVals);
    const maxV = Math.max(1, ...[p.self && p.self.value, ...peerVals].filter(v => v != null).map(Math.abs));
    const bar = v => v == null ? '' : `<div class="peer-bar"><span style="width:${Math.max(5, Math.round(Math.abs(v) / maxV * 100))}%"></span></div>`;
    const selfRow = (p.self && p.self.name) ? `<tr class="peer-self"><td>${esc(p.self.name)} <span class="peer-you">the deal</span></td><td>${tag(!!p.self.listed)}</td><td class="num">${fmtVal(p.self.value)}</td><td class="barcell">${bar(p.self.value)}</td></tr>` : '';
    const rows = p.rows.map(r => `<tr><td>${esc(r.name)}${r.note ? `<span class="peer-note">${esc(r.note)}</span>` : ''}</td><td>${tag(!!r.listed)}${r.ticker ? ` <span class="peer-tick">${esc(r.ticker)}</span>` : ''}</td><td class="num">${fmtVal(r.value)}</td><td class="barcell">${bar(r.value)}</td></tr>`).join('');
    const medRow = median != null ? `<tr class="peer-med"><td>Peer median</td><td></td><td class="num">${fmtVal(median)}</td><td></td></tr>` : '';
    const metricHdr = esc(p.metric || '') + (unit === 'x' ? ' (×)' : unit === '%' ? ' (%)' : '');
    if (median != null && (p.metric === 'P/E' || p.metric === 'EV/EBITDA')) {
      vline = `Peer median ${esc(p.metric)} ≈ ${fmtVal(median)}.`;
      if (p.metric === 'EV/EBITDA' && c.returns && c.returns.defaults) vline += ` Your entry assumption is ${c.returns.defaults.entryX}× EBITDA — ${c.returns.defaults.entryX <= median ? 'at or below' : 'above'} the peer median.`;
    }
    tableHtml = `<table class="peer-tbl"><thead><tr><th>Company</th><th>Type</th><th class="num">${metricHdr}</th><th class="barhd"></th></tr></thead><tbody>${selfRow}${rows}${medRow}</tbody></table>`;
    footHint = "Indicative — drawn from the IM's benchmarking; blank where the documents give no figure.";
  } else {
    // No comparable numbers in the documents — show names + positioning, not an empty metric column.
    const selfRow = (p.self && p.self.name) ? `<tr class="peer-self"><td>${esc(p.self.name)} <span class="peer-you">the deal</span></td><td>${tag(!!p.self.listed)}</td><td class="peer-pos">—</td></tr>` : '';
    const rows = p.rows.map(r => `<tr><td>${esc(r.name)}</td><td>${tag(!!r.listed)}${r.ticker ? ` <span class="peer-tick">${esc(r.ticker)}</span>` : ''}</td><td class="peer-pos">${r.note ? esc(r.note) : '—'}</td></tr>`).join('');
    tableHtml = `<table class="peer-tbl"><thead><tr><th>Company</th><th>Type</th><th>Positioning</th></tr></thead><tbody>${selfRow}${rows}</tbody></table>`;
    footHint = 'Peers and positioning named in the documents. The documents give no comparable financials for these peers; listed names can still pull live below.';
  }

  const card = h(`
    <div class="surface-card p-5">
      <div class="section-title"><span class="sec-ico">${icon('scale', 'w-4 h-4')}</span>How this deal compares</div>
      ${p.note ? `<p class="text-[12.5px] text-ink-muted mb-3 leading-relaxed">${esc(p.note)}</p>` : ''}
      <div class="peer-scroll">${tableHtml}</div>
      ${vline ? `<p class="text-[12.5px] text-ink-muted mt-3">${vline}</p>` : ''}
      <div data-peer-live class="mt-3"></div>
      <p class="text-[11px] text-ink-hint mt-2">${footHint}</p>
    </div>`);
  maybeAddPeerLive(card, c);
  return card;
}
// Live screener for LISTED players. Any deal whose peer set names listed companies
// with NSE tickers gets a "listed peers · live" panel that pulls each one's current
// P/E and market cap from Screener.in (via /api/peer-multiple). When the memo itself
// benchmarks on P/E, the fetched multiples also backfill the comparison table above.
// Fetched data is cached on the company (c._peerLive) so it survives that re-render.
const _num = v => (v == null || isNaN(v)) ? null : Number(v);
function nowLabel() {
  try { return new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }); }
  catch (_) { return ''; }
}
function maybeAddPeerLive(card, c) {
  const p = c.peers;
  if (!state.peerLiveEnabled || !p || !Array.isArray(p.rows)) return;
  const listed = p.rows.filter(r => r && r.listed && r.ticker);
  if (!listed.length) return;                       // no listed tickers → nothing to look up
  const box = card.querySelector('[data-peer-live]');
  if (!box) return;

  const renderPanel = () => {
    const live = c._peerLive;
    box.innerHTML = `
      <div class="peer-live-head">
        <span class="peer-live-title">${icon('search', 'w-3.5 h-3.5')} Listed peers · live market data</span>
        <button class="peer-live-btn" type="button" data-live-fetch>
          ${icon('refreshCw', 'w-3.5 h-3.5')}<span>${live ? 'Refresh' : 'Fetch live market data'}</span><span class="peer-live-tag">live</span>
        </button>
      </div>
      <div data-live-body>${live ? liveTable(live) : `<p class="peer-live-hint">Pull each listed peer's current P/E and market cap live.</p>`}</div>`;
    box.querySelector('[data-live-fetch]').addEventListener('click', fetchLive);
  };

  const liveTable = live => {
    const cell = v => v == null ? '<span class="peer-live-na">—</span>' : v;
    const rows = listed.map(r => {
      const d = live.byTicker[r.ticker] || {};
      const pe  = d.pe != null ? d.pe.toFixed(1) + '×' : null;
      const mc  = d.marketCapCr != null ? fmtCr(d.marketCapCr) : null;
      const roe = d.roe != null ? d.roe + '%' : null;
      return `<tr>
        <td>${esc(r.name)} <span class="peer-tick">${esc(r.ticker)}</span></td>
        <td class="num">${cell(pe)}</td><td class="num">${cell(mc)}</td><td class="num">${cell(roe)}</td></tr>`;
    }).join('');
    const got = listed.some(r => { const d = live.byTicker[r.ticker]; return d && (d.pe != null || d.marketCapCr != null); });
    const foot = got
      ? `Live market data${live.ts ? ' · ' + esc(live.ts) : ''}.`
      : `No live figures right now — the market-data source may be busy. Try Refresh in a moment.`;
    return `
      <div class="peer-scroll mt-2">
        <table class="peer-tbl peer-live-tbl">
          <thead><tr><th>Listed peer</th><th class="num">P/E</th><th class="num">Market cap</th><th class="num">ROE</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="peer-live-hint">${foot}</p>`;
  };

  const fetchLive = async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const span = btn.querySelector('span'); span.textContent = 'Fetching…';
    const byTicker = (c._peerLive && c._peerLive.byTicker) || {};
    await Promise.all(listed.map(async r => {
      try {
        const res = await fetch(apiUrl('peer-multiple') + '?ticker=' + encodeURIComponent(r.ticker));
        const d = await res.json().catch(() => ({}));
        byTicker[r.ticker] = { pe: _num(d.pe), marketCapCr: _num(d.marketCapCr), roce: _num(d.roce), roe: _num(d.roe) };
      } catch (_) { byTicker[r.ticker] = byTicker[r.ticker] || {}; }
    }));
    c._peerLive = { ts: nowLabel(), byTicker };
    // If the memo benchmarks on P/E, fill the comparison table's value column from live P/E.
    if (p.metric === 'P/E') {
      let filled = false;
      listed.forEach(r => { const pe = byTicker[r.ticker] && byTicker[r.ticker].pe; if (pe != null) { r.value = Math.round(pe * 10) / 10; filled = true; } });
      if (filled) { renderTabPanel(c, 'returns'); return; }   // re-render; c._peerLive persists → panel shows too
    }
    renderPanel();
  };

  renderPanel();
}

// Keep the entry/exit year dropdown labels showing the CURRENT basis's metric (EBITDA/Revenue/PAT).
function refreshYearOptLabels(root, c) {
  [['entryYear', 'entryBasis'], ['exitYear', 'exitBasis']].forEach(([ysel, bsel]) => {
    const sel = root.querySelector(`[data-ret="${ysel}"]`), bs = root.querySelector(`[data-ret="${bsel}"]`);
    if (!sel || !bs) return;
    const lab = retBasis(bs.value).label;
    Array.from(sel.options).forEach(opt => {
      const e = metricAt(c, bs.value, opt.value);
      opt.textContent = opt.value + (e != null ? ` · ${lab} ${fmtCr(e)}` : '');
    });
  });
}

function recomputeReturns(c, root) {
  const v = readReturns(root);
  const enLabel = root.querySelector('[data-slabel="entryX"]');  // entry/exit multiple labels depend on the basis
  if (enLabel) enLabel.textContent = entrySliderLabel(v.entryBasis);
  const exLabel = root.querySelector('[data-slabel="exitX"]');
  if (exLabel) exLabel.textContent = exitSliderLabel(v.exitBasis);
  refreshYearOptLabels(root, c);                                 // year dropdowns show the chosen basis's metric
  // Sync each slider's value label (the cheque shows as ₹ cr; others as value + suffix).
  root.querySelectorAll('[data-slider]').forEach(inp => {
    const lab = root.querySelector(`[data-val="${inp.dataset.slider}"]`);
    if (!lab) return;
    lab.textContent = inp.dataset.kind === 'cr' ? fmtCr(Number(inp.value)) : inp.value + (inp.dataset.suffix || '');
  });
  const out = computeReturns(c, v);

  root.querySelector('[data-out="moneyBack"]').textContent = out.moneyBack > 0 ? out.moneyBack.toFixed(1) + '×' : '—';
  const mSub = root.querySelector('[data-out="moneySub"]'); if (mSub) mSub.textContent = `on ${fmtCr(out.investment)} invested`;
  const yInt = Math.round(out.yearlyReturn);
  const yEl = root.querySelector('[data-out="yearly"]');
  yEl.textContent = (yInt > -100 ? yInt : '—') + (yInt > -100 ? '%' : '');
  yEl.style.color = yInt >= 20 ? POS : yInt >= 10 ? '#B45309' : '#E11D48';
  const ySub = root.querySelector('[data-out="yearlySub"]'); if (ySub) ySub.textContent = `over ${out.years} year${out.years === 1 ? '' : 's'}, compounded`;

  const hold = root.querySelector('[data-out="holdNote"]');
  if (hold) hold.textContent = `Holding ${out.years} year${out.years === 1 ? '' : 's'} — ${esc(v.entryYear)} to ${esc(v.exitYear)}.`;

  const bridge = root.querySelector('[data-out="bridge"]');
  if (bridge) bridge.innerHTML = returnsBridgeHTML(c, v, out);
  const impl = root.querySelector('[data-out="implied"]');
  if (impl) impl.innerHTML = impliedMultiplesHTML(c, out);
  const g1 = root.querySelector('[data-out="sensiMoic"]');     if (g1) g1.innerHTML = sensiGridHTML(c, v, 'exit', 'moic');
  const g2 = root.querySelector('[data-out="sensiIrrExit"]');  if (g2) g2.innerHTML = sensiGridHTML(c, v, 'exit', 'irr');
  const g3 = root.querySelector('[data-out="sensiIrrUnder"]'); if (g3) g3.innerHTML = sensiGridHTML(c, v, 'under', 'irr');

  // Entry-multiple hint: the trading-comps median for the chosen basis, and where our pick sits.
  const hint = root.querySelector('[data-out="entryHint"]');
  if (hint) {
    const med = compsMedianMult(c, v.entryBasis);
    if (med != null) {
      const m = Math.round(med * 10) / 10, rel = v.entryX <= med ? 'at/below' : 'above';
      hint.textContent = `Listed peers trade at ~${m}× ${basisMultLabel(v.entryBasis)} (median) — your ${v.entryX}× is ${rel} the comps.`;
      hint.classList.remove('muted');
    } else {
      hint.textContent = `No trading-comps median yet — add listed peers or a Private Circle export on the Comps tab.`;
      hint.classList.add('muted');
    }
  }

  const cap = root.querySelector('[data-out="chartCap"]');
  if (cap) cap.innerHTML = `Invested <b class="text-ink tnum">${fmtCr(out.investment)}</b> → could return <b class="text-ink tnum">${fmtCr(Math.round(out.proceeds))}</b>`;

  if (_returnsChart) {
    _returnsChart.data.datasets[0].data = [out.investment, Math.round(out.proceeds)];
    _returnsChart.data.datasets[0].backgroundColor = [BRAND.navy, out.moneyBack >= 1 ? POS : NEG];
    _returnsChart.update();
  }
}

/* -----------------------------------------------------------------------------
 * 8. Charts (Chart.js) — sparklines (shape-scaled) + full charts (zero-based)
 * ---------------------------------------------------------------------------*/
let _charts = []; // every live Chart instance; destroyed on any re-render
let _returnsChart = null; // the Returns-tab bar chart (updated live as sliders move)
function destroyCharts() { _charts.forEach(ch => ch.destroy()); _charts = []; _returnsChart = null; }

/* Pipeline sparklines */
function initSparklines() {
  $$('#pipeline-content canvas[data-spark]').forEach(canvas => {
    const existing = (window.Chart && Chart.getChart) ? Chart.getChart(canvas) : null;
    if (existing) existing.destroy();                    // idempotent: pipeline can re-render mid-job
    const c = companyById(canvas.dataset.spark);
    if (c && c.revenueSpark) _charts.push(buildSparkline(canvas, c.revenueSpark));
  });
}
// Tiny sparkline: navy line, soft fill, hidden axes, hover tooltip only.
// HOUSE RULE: sparklines are shape-scaled (beginAtZero:false) — full charts are not.
function buildSparkline(canvas, spark) {
  const { years, values, actualsThrough } = spark;
  const actualsIdx = years.indexOf(actualsThrough);
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 60);
  grad.addColorStop(0, tint(BRAND.navy, .16));
  grad.addColorStop(1, tint(BRAND.navy, 0));
  return new Chart(ctx, {
    type: 'line',
    data: { labels: years, datasets: [{
      data: values, borderColor: BRAND.navy, borderWidth: 2, fill: true, backgroundColor: grad,
      tension: 0.35, pointRadius: 0, pointHoverRadius: 4.5,
      pointBackgroundColor: BRAND.gold, pointBorderColor: '#fff', pointBorderWidth: 1.5, pointHoverBorderWidth: 2,
      segment: { borderDash: c => (c.p1DataIndex > actualsIdx ? [4, 3] : undefined) },
    }]},
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 650 },
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 4, bottom: 2, left: 1, right: 1 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false, backgroundColor: '#111827', padding: 9, cornerRadius: 8,
          titleColor: '#C7D2FE', titleFont: { family: 'Sora', size: 11, weight: '600' },
          bodyColor: '#fff', bodyFont: { family: 'Sora', size: 13, weight: '600' },
          callbacks: {
            title: items => items[0].label + (years.indexOf(items[0].label) > actualsIdx ? '  · estimate' : ''),
            label: item => fmtCr(item.parsed.y),
          },
        },
      },
      scales: { x: { display: false }, y: { display: false, beginAtZero: false } },
    },
  });
}

/* Company-view charts — dispatched by the canvas's data-chart attribute. */
function initPanelCharts(c) {
  $$('#tab-panel canvas[data-chart]').forEach(cv => {
    const existing = (window.Chart && Chart.getChart) ? Chart.getChart(cv) : null;
    if (existing) existing.destroy();
    let ch = null;
    switch (cv.dataset.chart) {
      case 'ownership': ch = buildOwnershipChart(cv, c); break;
      case 'revEbitda': ch = buildRevEbitda(cv, c);      break;
      case 'margins':   ch = buildMargins(cv, c);        break;
      case 'revmix':    ch = buildRevMix(cv, c);         break;
      case 'cashDebt':  ch = buildCashDebt(cv, c);       break;
      case 'segMix':    ch = buildSegmentMix(cv, c);     break;
      case 'cashFlow':  ch = buildCashFlow(cv, c);       break;
      case 'returns':   ch = buildReturnsChart(cv, c);   break;
    }
    if (ch) _charts.push(ch);
  });
}

// Returns tab: two bars (Invested vs. potential return). Zero-based; live-updated
// by recomputeReturns() as the sliders move. Reads current slider values if the
// panel is present, else the company's defaults.
function buildReturnsChart(canvas, c) {
  const panel = $('#tab-panel');
  const v = (panel && panel.querySelector('[data-ret]')) ? readReturns(panel) : returnsInputs(c);
  const out = computeReturns(c, v);
  const opts = cartesianBase(false);
  opts.plugins.legend = { display: false };
  opts.plugins.tooltip = {
    backgroundColor: '#111827', padding: 9, cornerRadius: 8, displayColors: false,
    bodyColor: '#fff', bodyFont: { family: 'Sora', size: 13, weight: '600' },
    callbacks: { title: items => items[0].label, label: ctx => ` ₹${fmtNum(ctx.parsed.y)} cr` },
  };
  _returnsChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels: ['Invested', 'Could return'], datasets: [{
      data: [out.investment, Math.round(out.proceeds)],
      backgroundColor: [BRAND.navy, out.moneyBack >= 1 ? POS : NEG],
      borderRadius: 6, borderSkipped: false, maxBarThickness: 84,
    }]},
    options: opts,
  });
  return _returnsChart;
}

// Shared cartesian options — legend + hover tooltip, clean axes, ZERO-BASED y.
function cartesianBase(isPct) {
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 600 },
    interaction: { mode: 'index', intersect: false },
    layout: { padding: { top: 2 } },
    plugins: {
      legend: { position: 'top', align: 'end',
        labels: { usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 9, boxHeight: 9, padding: 14, color: BRAND.ink, font: { family: 'Inter', size: 11.5 } } },
      tooltip: {
        backgroundColor: '#111827', padding: 10, cornerRadius: 8, usePointStyle: true,
        titleColor: '#C7D2FE', titleFont: { family: 'Sora', size: 11 },
        bodyColor: '#fff', bodyFont: { family: 'Inter', size: 12.5 },
        callbacks: { label: ctx => {
          const v = ctx.parsed.y;
          return isPct ? ` ${ctx.dataset.label}: ${v}%` : ` ${ctx.dataset.label}: ₹${fmtNum(v)} cr`;
        } },
      },
    },
    scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: { color: BRAND.muted, font: { size: 11 } } },
      y: { beginAtZero: true, grid: { color: 'rgba(17,24,39,.06)' }, border: { display: false },
           ticks: { color: BRAND.muted, font: { size: 11 }, maxTicksLimit: 5, callback: val => isPct ? val + '%' : fmtNum(val) } },
    },
  };
}
// Per-bar colours: forecast bars are lighter, matching the table's tinted columns.
function barColors(hex, v) { return v.years.map((_, i) => v.isForecast(i) ? tint(hex, .42) : hex); }

function buildRevEbitda(canvas, c) {
  const v = finView(c), r = v.fin.rows;
  const ds = (label, arr, hex) => ({ label, data: (arr || []).slice(0, v.n), backgroundColor: barColors(hex, v),
    borderRadius: 4, borderSkipped: false, maxBarThickness: 30, categoryPercentage: 0.68, barPercentage: 0.9 });
  return new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels: v.years, datasets: [ds('Revenue', r.revenue, BRAND.navy), ds('EBITDA', r.ebitda, '#14B8A6')] },
    options: cartesianBase(false),
  });
}

function buildMargins(canvas, c) {
  const v = finView(c), r = v.fin.rows;
  const dash = ctx => (ctx.p1DataIndex >= v.actualsCut ? [5, 4] : undefined);
  const line = (label, arr, hex) => ({
    label, data: (arr || []).slice(0, v.n), borderColor: hex, backgroundColor: hex, borderWidth: 2.5, tension: 0.3,
    pointRadius: 2.5, pointHoverRadius: 5, pointBackgroundColor: hex, pointBorderColor: '#fff', pointBorderWidth: 1.5,
    segment: { borderDash: dash },
  });
  return new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels: v.years, datasets: [line('EBITDA margin', r.ebitdaPct, '#10B981'), line('PAT margin', r.patPct, '#2E6FD6')] },
    options: cartesianBase(true),   // zero-based; negatives extend below the 0 line (honest)
  });
}

function buildCashDebt(canvas, c) {
  const v = finView(c), r = v.fin.rows;
  if (!Array.isArray(r.cash) || !Array.isArray(r.debt)) return null;
  const ds = (label, arr, hex) => ({ label, data: (arr || []).slice(0, v.n), backgroundColor: barColors(hex, v),
    borderRadius: 4, borderSkipped: false, maxBarThickness: 26, categoryPercentage: 0.68, barPercentage: 0.9 });
  return new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels: v.years, datasets: [ds('Cash', r.cash, POS), ds('Debt', r.debt, NEG)] },
    options: cartesianBase(false),
  });
}

// Segment revenue over time — stacked bars showing how the mix shifts.
function buildSegmentMix(canvas, c) {
  const seg = c.financials.segments;
  if (!seg || !Array.isArray(seg.rows) || !seg.rows.length) return null;
  const v = finView(c);
  const opts = cartesianBase(false);
  opts.scales.x.stacked = true;
  opts.scales.y.stacked = true;
  const datasets = seg.rows.map((row, i) => ({
    label: row.name,
    data: (row.values || []).slice(0, v.n).map(x => x == null ? 0 : x),
    backgroundColor: CHART_PALETTE[i % CHART_PALETTE.length],
    borderRadius: 2, borderSkipped: false, maxBarThickness: 40, categoryPercentage: 0.72, barPercentage: 0.96,
  }));
  return new Chart(canvas.getContext('2d'), { type: 'bar', data: { labels: v.years, datasets }, options: opts });
}

// Cash generation — operating cash flow vs free cash flow (the PE-critical view).
function buildCashFlow(canvas, c) {
  const v = finView(c), r = v.fin.rows;
  if (!Array.isArray(r.operatingCashflow) && !Array.isArray(r.fcf)) return null;
  const ds = (label, arr, hex) => Array.isArray(arr) ? ({ label, data: arr.slice(0, v.n),
    backgroundColor: barColors(hex, v), borderRadius: 4, borderSkipped: false, maxBarThickness: 24, categoryPercentage: 0.7, barPercentage: 0.9 }) : null;
  const datasets = [ds('Operating cash flow', r.operatingCashflow, BRAND.navy), ds('Free cash flow', r.fcf, '#14B8A6')].filter(Boolean);
  return new Chart(canvas.getContext('2d'), { type: 'bar', data: { labels: v.years, datasets }, options: cartesianBase(false) });
}

function buildRevMix(canvas, c) {
  const mix = c.financials.revenueMix;
  if (!mix || !Array.isArray(mix.slices) || !mix.slices.length) return null;
  return buildDoughnut(canvas, mix.slices.map(s => s.name), mix.slices.map(s => s.pct), true);
}
function buildOwnershipChart(canvas, c) {
  const own = c.snapshot && c.snapshot.ownership;
  if (!Array.isArray(own) || !own.length) return null;
  // Legend is off here — the companion table beside it acts as the legend.
  return buildDoughnut(canvas, own.map(o => o.holder), own.map(o => o.pct), false);
}
function buildDoughnut(canvas, labels, data, legend) {
  const colors = labels.map((_, i) => CHART_PALETTE[i % CHART_PALETTE.length]);
  return new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: '#fff', borderWidth: 2, hoverOffset: 6 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '60%', animation: { duration: 600 },
      plugins: {
        legend: legend
          ? { position: 'right', labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 8, padding: 9, color: BRAND.ink, font: { size: 11.5 } } }
          : { display: false },
        tooltip: {
          backgroundColor: '#111827', padding: 9, cornerRadius: 8, bodyColor: '#fff', bodyFont: { family: 'Inter', size: 12.5 },
          callbacks: { label: ctx => ` ${ctx.label}: ${ctx.parsed}%` },
        },
      },
    },
  });
}

/* -----------------------------------------------------------------------------
 * 9. Overlays: add-a-deal modal, skeleton, empty + error states
 * ---------------------------------------------------------------------------*/
/* ---- File extraction (in-browser) ---- */
// IM / notes → plain text via pdf.js (capped so payloads stay small).
async function extractPdfText(file, cap = 80000) {
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  const n = Math.min(pdf.numPages, 120);
  for (let i = 1; i <= n; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map(it => it.str).join(' '));
    if (pages.join('\n').length > cap) break;
  }
  return pages.join('\n').replace(/[ \t]+\n/g, '\n').trim().slice(0, cap);
}
// Word .docx → plain text, entirely in the browser. A .docx is a ZIP; we read word/document.xml
// from the central directory and inflate it with the platform's DecompressionStream (no library).
async function extractDocxText(file, cap = 60000) {
  try {
    const u8 = new Uint8Array(await file.arrayBuffer());
    const dv = new DataView(u8.buffer);
    // locate the End Of Central Directory record (scan back from the tail)
    let eocd = -1;
    for (let i = u8.length - 22; i >= 0 && i >= u8.length - 22 - 65536; i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) return '';
    let p = dv.getUint32(eocd + 16, true);                 // central directory offset
    const count = dv.getUint16(eocd + 10, true);
    let lho = -1, method = 8, compSize = 0;
    for (let n = 0; n < count && dv.getUint32(p, true) === 0x02014b50; n++) {   // walk central directory entries
      const m = dv.getUint16(p + 10, true), cSize = dv.getUint32(p + 20, true);
      const fnLen = dv.getUint16(p + 28, true), exLen = dv.getUint16(p + 30, true), cmLen = dv.getUint16(p + 32, true);
      const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + fnLen));
      if (name === 'word/document.xml') { lho = dv.getUint32(p + 42, true); method = m; compSize = cSize; break; }
      p += 46 + fnLen + exLen + cmLen;
    }
    if (lho < 0 || dv.getUint32(lho, true) !== 0x04034b50) return '';
    const dataStart = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const comp = u8.subarray(dataStart, dataStart + compSize);
    const xmlBytes = method === 0 ? comp
      : new Uint8Array(await new Response(new Response(comp).body.pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    const xml = new TextDecoder().decode(xmlBytes);
    return xml
      .replace(/<w:tab\b[^>]*\/?>/g, '\t').replace(/<w:br\b[^>]*\/?>/g, '\n')
      .replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')   // paragraphs → newlines, then strip all tags
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
      .replace(/\n{3,}/g, '\n\n').trim().slice(0, cap);
  } catch (_) { return ''; }
}

/* ---- Email → plain text (so banker notes can be dropped as-is, no converting) --------------
 * .eml is parsed here in pure JS (headers + body, multipart, quoted-printable / base64, html→text).
 * .msg is Outlook's OLE/compound format — read via SheetJS's bundled CFB reader (already loaded for
 * Excel), pulling the subject/sender/body property streams. Both are best-effort: any failure
 * returns '' so a stray email never blocks the memo. */
function emlHeaders(block) {
  const out = {}; let key = null;
  for (const line of block.split('\n')) {
    if (/^\s/.test(line) && key) { out[key] += ' ' + line.trim(); continue; }   // folded continuation
    const m = line.match(/^([!-9;-~]+):\s?(.*)$/);
    if (m) { key = m[1].toLowerCase(); out[key] = m[2]; }
  }
  return out;
}
function qpDecode(s) {
  s = s.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) { bytes.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
    else bytes.push(s.charCodeAt(i) & 0xff);
  }
  try { return new TextDecoder('utf-8').decode(new Uint8Array(bytes)); } catch { return s; }
}
function b64ToUtf8(s) {
  try { const bin = atob(s.replace(/\s+/g, '')); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new TextDecoder('utf-8').decode(u); }
  catch { return ''; }
}
function htmlToText(html) {
  return String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function decodeMimeWords(s) {
  return String(s).replace(/=\?[^?]+\?([BbQq])\?([^?]*)\?=/g, (_, enc, txt) =>
    /b/i.test(enc) ? b64ToUtf8(txt) : txt.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))).trim();
}
function emlDecodeBody(body, cte, ctype) {
  const e = (cte || '').toLowerCase();
  let b = e.includes('quoted-printable') ? qpDecode(body) : e.includes('base64') ? b64ToUtf8(body) : body;
  return /text\/html/i.test(ctype) ? htmlToText(b) : b.trim();
}
function emlMultipart(body, boundary, depth) {
  if (depth > 4) return '';
  const parts = body.split(new RegExp('--' + boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:--)?[ \\t]*\\n')).slice(1);
  let plain = '', html = '';
  for (const part of parts) {
    const sep = part.indexOf('\n\n');
    if (sep < 0) continue;
    const h = emlHeaders(part.slice(0, sep));
    const pct = h['content-type'] || '';
    if (/multipart\//i.test(pct)) { const bm = pct.match(/boundary="?([^";]+)"?/i); if (bm) { const inner = emlMultipart(part.slice(sep + 2), bm[1], depth + 1); if (inner) return inner; } continue; }
    if (/attachment/i.test(h['content-disposition'] || '')) continue;
    const decoded = emlDecodeBody(part.slice(sep + 2), h['content-transfer-encoding'], pct);
    if (/text\/plain/i.test(pct) && !plain) plain = decoded;
    else if (/text\/html/i.test(pct) && !html) html = decoded;
  }
  return plain || html;
}
async function extractEmlText(file, cap = 40000) {
  try {
    const text = (await file.text()).replace(/\r\n/g, '\n');
    const sep = text.indexOf('\n\n');
    const headers = emlHeaders(sep >= 0 ? text.slice(0, sep) : text);
    const body = sep >= 0 ? text.slice(sep + 2) : '';
    const ctype = headers['content-type'] || '';
    const bm = ctype.match(/boundary="?([^";]+)"?/i);
    const plain = (/multipart\//i.test(ctype) && bm) ? emlMultipart(body, bm[1], 0) : emlDecodeBody(body, headers['content-transfer-encoding'], ctype);
    const head = [];
    for (const k of ['subject', 'from', 'to', 'date']) if (headers[k]) head.push(k[0].toUpperCase() + k.slice(1) + ': ' + decodeMimeWords(headers[k]));
    return (head.join('\n') + (head.length ? '\n\n' : '') + plain).replace(/\n{3,}/g, '\n\n').trim().slice(0, cap);
  } catch (_) { return ''; }
}
async function extractMsgText(file, cap = 40000) {
  try {
    if (!window.XLSX || !window.XLSX.CFB) return '';                 // SheetJS (loaded for Excel) bundles the CFB reader
    const cfb = window.XLSX.CFB.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
    const streamEndingWith = suffix => {
      const e = (cfb.FileIndex || []).find(fi => fi && typeof fi.name === 'string' && fi.name.toLowerCase().endsWith(suffix.toLowerCase()));
      return e && e.content ? new Uint8Array(e.content) : null;
    };
    const u16 = b => b ? new TextDecoder('utf-16le').decode(b).replace(/ +$/, '').trim() : '';
    const a8  = b => b ? new TextDecoder('windows-1252').decode(b).replace(/ +$/, '').trim() : '';
    // MAPI property tags: body 0x1000, subject 0x0037, sender name 0x0C1A; suffix 001F=unicode, 001E=ascii, 0102=binary.
    let body = u16(streamEndingWith('__substg1.0_1000001F')) || a8(streamEndingWith('__substg1.0_1000001E'));
    if (!body) { const html = a8(streamEndingWith('__substg1.0_10130102')); if (html) body = htmlToText(html); }
    const subject = u16(streamEndingWith('__substg1.0_0037001F')) || a8(streamEndingWith('__substg1.0_0037001E'));
    const from = u16(streamEndingWith('__substg1.0_0C1A001F')) || a8(streamEndingWith('__substg1.0_0C1A001E'));
    const head = [];
    if (subject) head.push('Subject: ' + subject);
    if (from) head.push('From: ' + from);
    return (head.join('\n') + (head.length ? '\n\n' : '') + body).replace(/\n{3,}/g, '\n\n').trim().slice(0, cap);
  } catch (_) { return ''; }
}
// ---- Vision: render document pages to JPEGs the model can read (logos, org charts, tables) ----
// Each page is rendered near Claude's vision sweet spot (~1540px long edge → ~1.15MP after the
// API's own downscale). Bedrock caps images per request, so a long doc — or several docs — is
// packed N-up into a shared budget of <= maxImages composites; no page of any document is dropped.
function _downscaleCanvas(c, maxDim) {
  const m = Math.max(c.width, c.height);
  if (m <= maxDim) return c;
  const s = maxDim / m, d = document.createElement('canvas');
  d.width = Math.round(c.width * s); d.height = Math.round(c.height * s);
  d.getContext('2d').drawImage(c, 0, 0, d.width, d.height);
  return d;
}
// Render a doc's pages into <= maxImages canvases. Pack at most maxPerImage pages/image so text
// stays legible; if the doc is larger than the budget can show 2-up, the front is imaged and the
// rest is left to the full text extraction (which reads every page anyway).
async function renderPdfToCanvases(pdf, { maxImages, targetW, maxDim, maxPerImage = 2 }) {
  const total = pdf.numPages;
  const per = Math.max(1, Math.min(maxPerImage, Math.ceil(total / maxImages)));
  const coverable = Math.min(total, per * maxImages);
  const out = [];
  for (let start = 1; start <= coverable; start += per) {
    const tiles = [];
    for (let i = start; i <= Math.min(start + per - 1, coverable); i++) {
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(2.2, targetW / base.width) });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);   // JPEG has no alpha
      await page.render({ canvasContext: cx, viewport: vp }).promise;
      tiles.push(c);
    }
    let composite = tiles[0];
    if (tiles.length > 1) {                                  // stack pages vertically into one image
      const W = Math.max(...tiles.map(t => t.width));
      const H = tiles.reduce((s, t) => s + t.height, 0) + (tiles.length - 1) * 6;
      composite = document.createElement('canvas'); composite.width = W; composite.height = H;
      const cx = composite.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, W, H);
      let y = 0; for (const t of tiles) { cx.drawImage(t, 0, y); y += t.height + 6; }
    }
    out.push(_downscaleCanvas(composite, maxDim));
  }
  return out;
}
async function imageFileToCanvas(file, { maxDim }) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
  const cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
  cx.drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}
// Render every uploaded PDF/image into one shared budget of <= maxImages JPEGs, then encode within
// a total byte budget (so a big multi-doc upload never exceeds the model's request-size limit).
// NOTE: keep this payload MODERATE. A very large image set makes the Bedrock vision call slow
// enough that a heavy multi-document deal can run past the Worker's limit and never finish. The
// full page TEXT of every document is always sent separately, so the images are supplementary
// (logos, org charts, infographics) — 12 legible composites cover that without bloating the request.
async function renderAllDocImages(files, { maxImages = 7, targetW = 1040, maxDim = 6200, budgetBytes = 2_400_000 } = {}) {
  try {
    const docs = [];
    for (const f of files) {
      if (!f) continue;
      const isPdf = /pdf$/i.test(f.name || '') || (f.type || '').includes('pdf');
      const isImg = /^image\//.test(f.type || '') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name || '');
      if (isPdf) { const pdf = await window.pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise; docs.push({ type: 'pdf', pdf, pages: pdf.numPages }); }
      else if (isImg) docs.push({ type: 'img', file: f, pages: 1 });
    }
    if (!docs.length) return [];
    // Allocate in order so the PRIMARY doc (the IM, first) gets priority coverage — ideally every
    // page 1-up — and later supporting docs share whatever budget remains (reserving >=1 slot each).
    const canvases = []; let remaining = maxImages;
    for (let di = 0; di < docs.length && remaining > 0; di++) {
      const d = docs[di], laterDocs = docs.length - di - 1;
      const budget = Math.max(1, Math.min(d.pages, remaining - laterDocs));
      try {
        if (d.type === 'img') canvases.push(await imageFileToCanvas(d.file, { maxDim }));
        else canvases.push(...await renderPdfToCanvases(d.pdf, { maxImages: budget, targetW, maxDim }));
      } catch (_) { /* skip a doc that fails to render */ }
      remaining = maxImages - canvases.length;
    }
    // Encode within the byte budget: step quality down until the whole set fits (keeps the model's
    // request small enough to never 413/timeout on a large multi-document upload).
    for (const q of [0.72, 0.62, 0.52, 0.42]) {
      const enc = canvases.map(c => _canvasToB64(c, q)).filter(Boolean);
      const bytes = enc.reduce((s, b) => s + b.length * 0.75, 0);
      if (bytes <= budgetBytes) return enc.slice(0, maxImages);
      if (q === 0.42) {                                    // last resort: trim trailing images to fit the budget
        let sum = 0; const kept = [];
        for (const b of enc) { sum += b.length * 0.75; if (sum > budgetBytes) break; kept.push(b); }
        return kept.length ? kept : enc.slice(0, 1);
      }
    }
    return [];
  } catch (_) { return []; }   // vision is additive — never block generation on a render failure
}
function _canvasToB64(c, quality) {
  const url = c.toDataURL('image/jpeg', quality);
  return (url && url.indexOf(',') > 0) ? url.slice(url.indexOf(',') + 1) : '';
}
// Back-compat single-file wrapper (IM-only path + tests).
async function renderPdfPageImages(file, opts) { return renderAllDocImages([file], opts); }
// Excel → CSV of the best financial sheet(s) via SheetJS (capped ~40k chars).
async function parseExcel(file, cap = 100000) {
  const buf = await file.arrayBuffer();
  const wb = window.XLSX.read(buf, { type: 'array' });
  const sheetNames = wb.SheetNames.slice();
  const colsOf = n => { const ref = wb.Sheets[n] && wb.Sheets[n]['!ref']; const r = ref ? window.XLSX.utils.decode_range(ref) : null; return r ? r.e.c + 1 : 0; };
  const pick = re => sheetNames.filter(n => re.test(n));
  // The Returns tab needs cash & debt (→ net debt), so the BALANCE SHEET must reach the model too —
  // not just the P&L/summary. Lead with the cleanest (fewest-column = usually annual) P&L view, then
  // the balance sheet, then cash flow, so the balance-sheet lines survive the size cap.
  // Lead with the CONSOLIDATED / group P&L — it carries the true reporting unit (a model can mix
  // units across tabs, e.g. consolidated in ₹ crore but detail tabs in ₹ lakh).
  const consol = pick(/consol/i);
  const pnlRest = pick(/summary|p&l|pnl|profit|income|key\s*metric|dashboard|financ/i).sort((a, b) => colsOf(a) - colsOf(b));
  const pnl = [...new Set([...consol, ...pnlRest])];
  const bs  = pick(/balance|\bb\/?s\b|net\s*worth/i);
  const cfs = pick(/cash\s*flow|\bcfs\b|cash\s*statement/i);
  let chosen = [...new Set([...pnl.slice(0, 1), ...bs.slice(0, 1), ...cfs.slice(0, 1), ...pnl.slice(1)])];
  if (!chosen.length) {                                  // nothing named like a statement → the largest data sheet
    let best = null, bestSize = -1;
    sheetNames.forEach(n => {
      const ref = wb.Sheets[n] && wb.Sheets[n]['!ref'];
      const r = ref ? window.XLSX.utils.decode_range(ref) : null;
      const size = r ? (r.e.r + 1) * (r.e.c + 1) : 0;
      if (size > bestSize) { bestSize = size; best = n; }
    });
    if (best) chosen = [best];
  }
  // Detect a sheet's stated money unit from its header cells, so the AI reads the scale correctly
  // (crore vs lakh vs million) instead of guessing — the #1 cause of 10×/100× errors.
  const unitOf = txt => {
    const head = txt.slice(0, 2500);
    const m = head.match(/(?:currency|amount|figures?|values?|units?|all\s+figures?)\b[^\n,]{0,20}?(₹|rs\.?|inr)?\s*(crore?s?|cr\b|lacs?|lakhs?|millions?|mn\b|thousands?|'?000s?)/i)
           || head.match(/(₹|rs\.?|inr)\s*(crore?s?|cr\b|lacs?|lakhs?|millions?|mn\b)\b/i)
           || head.match(/\b(in\s+(?:crore?s?|lacs?|lakhs?|millions?|mn|thousands?))\b/i);
    return m ? m[0].replace(/[,\n]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  };
  let csv = '';
  for (const n of chosen) {
    const sheetCsv = window.XLSX.utils.sheet_to_csv(wb.Sheets[n]);
    const unit = unitOf(sheetCsv);
    csv += `# Sheet: ${n}${unit ? ` — reporting unit: ${unit}` : ''}\n` + sheetCsv + '\n\n';
    if (csv.length > cap) break;
  }
  return { excelText: csv.slice(0, cap), sheetNames };
}
async function fileToBase64(file) {
  if (file.size > 8 * 1024 * 1024) return '';            // too big to ship for OCR
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/* ---- Attach report(s) to an EXISTING deal and rebuild its memo in place ----
 * For adding a valuation-comps / Private Circle export (or an updated deck) to a deal WITHOUT
 * re-uploading the IM + Excel. Extracts the new report client-side and posts to /api/regenerate,
 * which rebuilds the memo under the same deal id. Progress shows as a normal pipeline job. */
function openAttachReportModal(company) {
  if (!company) return;
  if (isSample(company)) { toast('This is a built-in sample — add your own deal to attach reports'); return; }
  const root = $('#modal-root');
  let sel = [];
  const overlay = h(`
    <div class="modal-overlay" role="dialog" aria-modal="true" aria-label="Add a report">
      <div class="modal">
        <div class="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-[#EEF1F6]">
          <div>
            <h2 class="font-display text-[18px] font-semibold text-ink">Add a report to ${esc(company.shortName || company.name)}</h2>
            <p class="text-[13px] text-ink-muted mt-0.5">Attach a valuation-comps / Private Circle export (or an updated deck) — the memo rebuilds in place with the new comps &amp; checks. Your original IM &amp; model stay; you don't re-upload them.</p>
          </div>
          <button class="modal-close text-ink-hint hover:text-ink transition-colors -mr-1" aria-label="Close">${icon('x', 'w-5 h-5')}</button>
        </div>
        <div class="modal-scroll px-6 py-5" style="max-height:70vh;overflow-y:auto"></div>
      </div>
    </div>`);
  const bodyEl = overlay.querySelector('.modal-scroll');
  const input = h(`<div style="display:none"><input type="file" multiple accept=".pdf,application/pdf,.xlsx,.xls,.csv,.txt,.md,.json,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,image/*,.eml,.msg,message/rfc822,application/vnd.ms-outlook"></div>`);
  overlay.appendChild(input);
  const fileInput = input.querySelector('input');

  const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 200); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };

  function render() {
    const chips = sel.length ? `<div class="flex flex-wrap gap-2 mt-2">${sel.map((f, i) =>
      `<span class="file-chip">${icon('fileText', 'w-3.5 h-3.5')}<span style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}</span>` +
      `<button type="button" data-rm="${i}" aria-label="Remove" style="line-height:1;color:var(--muted)">${icon('x', 'w-3.5 h-3.5')}</button></span>`).join('')}</div>` : '';
    bodyEl.innerHTML = `
      <button class="uz ${sel.length ? 'has-file' : ''}" type="button" data-pick>
        <span class="uz-ico">${icon(sel.length ? 'check' : 'plus', 'w-4 h-4', sel.length ? 3 : 2)}</span>
        <span class="uz-body">
          <span class="uz-title">Report file(s)</span>
          <span class="uz-sub">${sel.length ? `${sel.length} added — click to add more` : 'PrivateCircle / CapitalIQ / VCCEdge valuation-comps export, a term sheet, an updated deck, an email — PDF, Excel, CSV, image'}</span>
        </span>
      </button>${chips}
      <div class="mt-3 text-[12px] text-ink-hint">Transaction &amp; trading comps and the Integrity checks are re-read from the report; the rest of the memo is rebuilt from the deal's stored IM &amp; model. Takes 1–3 minutes and runs in the background.</div>
      <div class="flex justify-end gap-2 mt-5">
        <button class="hdr-btn" data-cancel type="button" style="color:${BRAND.ink};background:#F2F5FB;border-color:${BRAND.border}">Cancel</button>
        <button class="hdr-btn" data-go type="button" ${sel.length ? '' : 'disabled'} style="color:#fff;background:${sel.length ? BRAND.navy : '#9AA7BD'};border-color:${sel.length ? BRAND.navy : '#9AA7BD'}">${icon('refreshCw', 'w-4 h-4')} Add &amp; rebuild memo</button>
      </div>`;
    bodyEl.querySelector('[data-pick]').addEventListener('click', () => fileInput.click());
    bodyEl.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => { sel.splice(+b.dataset.rm, 1); render(); }));
    bodyEl.querySelector('[data-cancel]').addEventListener('click', close);
    const go = bodyEl.querySelector('[data-go]');
    if (go && sel.length) go.addEventListener('click', () => {
      const files = sel.slice();
      close();
      startRegeneration(company, files);
      toast(`Rebuilding ${company.shortName || company.name} with your report — the 🔔 lights up when it's ready`);
    });
  }

  fileInput.addEventListener('change', () => { sel = sel.concat([...fileInput.files]); fileInput.value = ''; render(); });
  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  render();
  root.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
}

/* ---- The real "Add a deal" modal: upload → AI → memo ----
 * opts.watchJob: open straight into a running job's live progress screen (e.g. from clicking a
 * still-building pipeline card) instead of the upload form. */
function openAddDealModal(opts = {}) {
  const root = $('#modal-root');
  const sel = { im: null, excel: null, notes: null, extra: [] };   // chosen files (extra = any supporting docs)
  let jobUnsub = null, gpCtl = null;                     // background-job mirror (see generate/close)

  const overlay = h(`
    <div class="modal-overlay" role="dialog" aria-modal="true" aria-label="Add a deal">
      <div class="modal">
        <div class="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-[#EEF1F6]">
          <div>
            <h2 class="font-display text-[18px] font-semibold text-ink">Add a deal</h2>
            <p class="text-[13px] text-ink-muted mt-0.5">Upload the banker's materials — the memo is built for you.</p>
          </div>
          <button class="modal-close text-ink-hint hover:text-ink transition-colors -mr-1" aria-label="Close">${icon('x', 'w-5 h-5')}</button>
        </div>
        <div class="modal-scroll px-6 py-5" style="max-height:70vh;overflow-y:auto"></div>
      </div>
    </div>`);

  const bodyEl = overlay.querySelector('.modal-scroll');

  // Hidden inputs.
  const inputs = h(`<div style="display:none">
    <input type="file" data-file="im" accept="application/pdf,.pdf">
    <input type="file" data-file="excel" accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
    <input type="file" data-file="notes" accept="application/pdf,.pdf,.txt,.md,text/plain,.eml,.msg,message/rfc822,application/vnd.ms-outlook">
    <input type="file" data-file="extra" multiple accept=".pdf,application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.xlsx,.xls,.txt,.md,.csv,.json,text/plain,image/*,.eml,.msg,message/rfc822,application/vnd.ms-outlook">
  </div>`);
  overlay.appendChild(inputs);
  const fileInput = k => inputs.querySelector(`[data-file="${k}"]`);

  function dropzone(key, title, sub, required) {
    const f = sel[key];
    const label = f ? f.name : sub;
    return `
      <button class="uz ${f ? 'has-file' : ''}" type="button" data-uz="${key}">
        <span class="uz-ico">${icon(f ? 'check' : (key === 'excel' ? 'sheet' : 'fileText'), 'w-4 h-4', f ? 3 : 2)}</span>
        <span class="uz-body">
          <span class="uz-title">${esc(title)}${required ? ' <span class="req">*</span>' : ' <span class="text-ink-hint font-normal">(optional)</span>'}</span>
          <span class="uz-sub">${f ? esc(label) : esc(sub)}</span>
        </span>
      </button>`;
  }

  // Optional "anything else you have" — multiple supporting docs (PDFs, images, more IMs, term
  // sheets, extra spreadsheets, notes). Every one is read (text + vision) into the memo.
  function extraZone() {
    const n = sel.extra.length;
    const chips = n ? `<div class="flex flex-wrap gap-2 mt-2">${sel.extra.map((f, i) =>
      `<span class="file-chip">${icon('fileText', 'w-3.5 h-3.5')}<span style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}</span>` +
      `<button type="button" data-rm-extra="${i}" aria-label="Remove" style="line-height:1;color:var(--muted)">${icon('x', 'w-3.5 h-3.5')}</button></span>`).join('')}</div>` : '';
    return `
      <button class="uz ${n ? 'has-file' : ''}" type="button" data-uz-extra>
        <span class="uz-ico">${icon(n ? 'check' : 'plus', 'w-4 h-4', n ? 3 : 2)}</span>
        <span class="uz-body">
          <span class="uz-title">Other documents <span class="text-ink-hint font-normal">(optional)</span></span>
          <span class="uz-sub">${n ? `${n} added — click to add more` : 'Extra IMs, decks, emails, images — and a Private Circle or valuation-comps export (fills the Integrity checks + private trading/transaction comps)'}</span>
        </span>
      </button>${chips}`;
  }

  function renderForm(errMsg) {
    bodyEl.innerHTML = `
      ${errMsg ? `<div class="form-err mb-4">${icon('alert', 'w-4 h-4 shrink-0 mt-0.5')}<span>${esc(errMsg)}</span></div>` : ''}
      <div class="space-y-2.5">
        ${dropzone('im', 'Information Memorandum · PDF', 'Click to choose the IM (PDF)', true)}
        ${dropzone('excel', 'Financial model · Excel', 'Click to choose the model (.xlsx)', true)}
        ${dropzone('notes', 'Banker notes', 'Click to add notes — PDF, email (.eml/.msg) or text', false)}
        ${extraZone()}
      </div>
      <div class="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div class="field"><label>Company name</label><input data-basic="name" placeholder="e.g. Acme Ltd" autocomplete="off"></div>
        <div class="field"><label>Sector</label><input data-basic="sector" placeholder="e.g. Consumer" autocomplete="off"></div>
        <div class="field"><label>Banker</label><input data-basic="banker" placeholder="e.g. Axis Capital" autocomplete="off"></div>
        <div class="field"><label>Deal ask</label><input data-basic="ask" placeholder="e.g. Up to ₹300 cr" autocomplete="off"></div>
      </div>
      <div class="flex items-center justify-end gap-2.5 mt-6">
        <button class="modal-close hdr-btn" style="color:${BRAND.ink};background:#F2F5FB;border-color:${BRAND.border}">Close</button>
        <button class="hdr-btn" data-generate style="color:#fff;background:${BRAND.navy};border-color:${BRAND.navy}">
          ${icon('trendingUp', 'w-4 h-4')} Generate memo
        </button>
      </div>`;
    bodyEl.querySelectorAll('.modal-close').forEach(b => b.addEventListener('click', close));
    bodyEl.querySelectorAll('[data-uz]').forEach(b => b.addEventListener('click', () => fileInput(b.dataset.uz).click()));
    const ez = bodyEl.querySelector('[data-uz-extra]');
    if (ez) ez.addEventListener('click', () => fileInput('extra').click());
    bodyEl.querySelectorAll('[data-rm-extra]').forEach(b => b.addEventListener('click', () => { sel.extra.splice(+b.dataset.rmExtra, 1); reRender(); }));
    bodyEl.querySelector('[data-generate]').addEventListener('click', generate);
  }
  // Re-render the form and restore the partner's typed basics into the fresh inputs.
  const reRender = () => { renderForm(); Object.entries(captured.basics).forEach(([k, v]) => { const i = bodyEl.querySelector(`[data-basic="${k}"]`); if (i) i.value = v; }); };

  // Steps shown to the partner (plain language, no internal/model detail).
  const GEN_STEPS = [
    { icon: 'fileText', label: 'Reading the Information Memorandum' },
    { icon: 'sheet',    label: 'Reading the financial model' },
    { icon: 'scale',    label: 'Analysing the numbers & fit' },
    { icon: 'sparkles', label: 'Writing your screening memo' },
  ];
  const BAR_BASE  = [8, 28, 50, 70];    // where the bar jumps to when a step begins
  const BAR_CREEP = [24, 44, 64, 80];   // creep ceiling while a step runs — kept well under 100% so it never implies "almost done"

  // Build the working screen once and return a small controller to drive it.
  function renderWorking(job) {
    bodyEl.innerHTML = `
      <div class="gen-wrap">
        <div class="gen-hero"><div class="gen-hero-ic">${icon('sparkles', 'w-6 h-6', 2.2)}</div></div>
        <div class="gen-head font-display" data-head>Getting started…</div>
        <div class="gen-sub" data-sub>Most memos take 1–3 minutes; a large deal with many pages can take longer. You can keep working — it builds in the background and won't be lost if you reload.</div>
        <div class="pbar"><div class="pbar-fill" data-bar></div></div>
        <div class="pbar-meta"><span class="pbar-elapsed" data-elapsed>0:00 elapsed</span><span class="pbar-pct" data-pct>0%</span></div>
        <div class="gen-steps">
          ${GEN_STEPS.map((s, i) => `
            <div class="gstep" data-gstep="${i}">
              <span class="gstep-ic">${icon(s.icon, 'w-4 h-4', 2)}</span>
              <span class="gstep-label">${esc(s.label)}</span>
              <span class="gstep-stat"></span>
            </div>`).join('')}
        </div>
        <div class="gen-actions">
          <button class="gen-bg" data-bg type="button">${icon('arrowLeft', 'w-3.5 h-3.5', 2.4)} Keep working — I'll tell you when it's ready</button>
          <button class="gen-cancel" data-cancel type="button">Cancel this build</button>
        </div>
      </div>`;

    bodyEl.querySelector('[data-bg]').addEventListener('click', () => {
      close();
      toast(`Building ${job.name} — the 🔔 will light up when it's ready`);
    });
    bodyEl.querySelector('[data-cancel]').addEventListener('click', () => { cancelJob(job.id); close(); });

    const barEl = bodyEl.querySelector('[data-bar]');
    const pctEl = bodyEl.querySelector('[data-pct]');
    const headEl = bodyEl.querySelector('[data-head]');
    const elapsedEl = bodyEl.querySelector('[data-elapsed]');
    const subEl = bodyEl.querySelector('[data-sub]');
    const stepEls = [...bodyEl.querySelectorAll('[data-gstep]')];
    let curPct = 0, pctRAF = 0, creepTO = null, finished = false, timerIV = null;

    const fmtElapsed = ms => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    function startTimer() {
      if (timerIV) return;
      const tick = () => {
        if (elapsedEl) elapsedEl.textContent = fmtElapsed(Date.now() - job.startedAt) + ' elapsed';
        // Be honest once it runs long — the elapsed clock is the real signal, not the bar.
        if (subEl && !finished && Date.now() - job.startedAt > 90000) subEl.textContent = 'Taking longer than usual — still working. Large deals can take several minutes; you can keep working and it won\'t be lost.';
      };
      tick();
      timerIV = setInterval(tick, 1000);
    }

    function tweenPct(target, ms) {
      cancelAnimationFrame(pctRAF);
      const start = curPct, t0 = performance.now();
      const frame = now => {
        const k = ms <= 0 ? 1 : Math.min(1, (now - t0) / ms);
        curPct = start + (target - start) * k;
        pctEl.textContent = Math.round(curPct) + '%';
        if (k < 1) pctRAF = requestAnimationFrame(frame);
      };
      pctRAF = requestAnimationFrame(frame);
    }
    function setBar(pct, ms) {
      barEl.style.transition = `width ${ms}ms cubic-bezier(.25,.1,.25,1)`;
      requestAnimationFrame(() => { barEl.style.width = pct + '%'; });
      tweenPct(pct, ms);
    }
    const markStat = (el, kind) => {
      el.querySelector('.gstep-stat').innerHTML =
        kind === 'done' ? `<span class="gcheck">${icon('check', 'w-4 h-4', 3)}</span>`
        : kind === 'active' ? '<span class="gspin"></span>' : '';
    };

    return {
      stage(i) {
        if (finished) return;
        startTimer();
        clearTimeout(creepTO);
        stepEls.forEach((el, idx) => {
          el.classList.toggle('is-done', idx < i);
          el.classList.toggle('is-active', idx === i);
          markStat(el, idx < i ? 'done' : idx === i ? 'active' : '');
        });
        headEl.textContent = GEN_STEPS[i].label + '…';
        setBar(BAR_BASE[i], 450);
        creepTO = setTimeout(() => { if (!finished) setBar(BAR_CREEP[i], 15000); }, 500);
      },
      finish() {
        finished = true;
        clearTimeout(creepTO); clearInterval(timerIV);
        stepEls.forEach(el => { el.classList.remove('is-active'); el.classList.add('is-done'); markStat(el, 'done'); });
        headEl.textContent = 'Memo ready';
        setBar(100, 450);
      },
      stop() { finished = true; clearTimeout(creepTO); clearInterval(timerIV); cancelAnimationFrame(pctRAF); },
    };
  }

  // Success screen — the partner clicks through to the finished memo.
  function renderDone(company, builtIn) {
    bodyEl.innerHTML = `
      <div class="gen-wrap gdone">
        <div class="gdone-hero">${icon('check', 'w-8 h-8', 3)}</div>
        <div class="gen-head font-display" style="margin-top:14px">Your memo is ready</div>
        <div class="gen-sub"><b>${esc(company.shortName || company.name)}</b> is now in your pipeline — filled across all seven tabs, ready to review.</div>
        ${builtIn ? `<div class="gdone-time">${icon('check', 'w-3.5 h-3.5', 3)} Built in ${esc(builtIn)}</div>` : ''}
        <div class="gdone-actions">
          <button class="hdr-btn" data-again style="color:${BRAND.ink};background:#F2F5FB;border-color:${BRAND.border}">Add another</button>
          <button class="hdr-btn" data-view-memo style="color:#fff;background:${BRAND.navy};border-color:${BRAND.navy}">${icon('trendingUp', 'w-4 h-4')} View memo</button>
        </div>
      </div>`;
    bodyEl.querySelector('[data-view-memo]').addEventListener('click', () => { close(); openCompany(company.id); });
    bodyEl.querySelector('[data-again]').addEventListener('click', () => {
      sel.im = sel.excel = sel.notes = null; sel.extra = []; captured.basics = {}; renderForm();
    });
  }

  // Show + follow a job's live progress screen (the big bar, steps and elapsed clock) in the modal.
  // Reused by generate() AND by clicking a still-building pipeline card / bell row, so a partner who
  // closed the modal can always re-open the full progress view. Safe if the job already finished.
  function mirror(job) {
    if (job.status === 'done')  { renderDone(job.company, jobElapsed(job)); return; }
    if (job.status === 'error') { renderForm(job.error); return; }
    gpCtl = renderWorking(job);
    let lastStage = -1, shown = false;
    const update = () => {
      if (job.status === 'running') {
        if (job.stageIdx !== lastStage) { lastStage = job.stageIdx; gpCtl.stage(job.stageIdx); }
      } else if (job.status === 'done' && !shown) {
        shown = true; gpCtl.finish();
        if (jobUnsub) { jobUnsub(); jobUnsub = null; }
        setTimeout(() => renderDone(job.company, jobElapsed(job)), 650);   // let the bar reach 100%
      } else if (job.status === 'error' && !shown) {
        shown = true; gpCtl.stop();
        if (jobUnsub) { jobUnsub(); jobUnsub = null; }
        renderForm(job.error);
      }
    };
    jobUnsub = onJobs(update);
    update();
  }

  // Start a background job and mirror its progress in the modal while it's open.
  // Closing the modal does NOT cancel the job — the pipeline card + bell take over.
  function generate() {
    if (!sel.im)    return renderForm('Please add the Information Memorandum (PDF).');
    if (!sel.excel) return renderForm('Please add the Excel financial model (.xlsx).');
    mirror(startGeneration({ files: { im: sel.im, excel: sel.excel, notes: sel.notes, extra: sel.extra.slice() }, basics: { ...captured.basics } }));
  }

  // Capture basics before we blow away the form during "working" (so generate can read them).
  const captured = { basics: {} };
  overlay.addEventListener('input', e => {
    const b = e.target.closest('[data-basic]');
    if (b) { const v = b.value.trim(); if (v) captured.basics[b.dataset.basic] = v; else delete captured.basics[b.dataset.basic]; }
  });

  // Wire the hidden inputs → store file + re-render the form (keeps basics via captured/reRender).
  ['im', 'excel', 'notes'].forEach(k => fileInput(k).addEventListener('change', e => {
    sel[k] = e.target.files[0] || null;
    reRender();
  }));
  // Extra supporting docs: append (multiple), and clear the input so the same file can be re-added.
  fileInput('extra').addEventListener('change', e => {
    for (const f of e.target.files) sel.extra.push(f);
    e.target.value = '';
    reRender();
  });

  const close = () => {
    if (jobUnsub) { jobUnsub(); jobUnsub = null; }   // stop mirroring, but the job keeps running
    if (gpCtl) { gpCtl.stop(); gpCtl = null; }
    overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 200); document.removeEventListener('keydown', onKey);
  };
  const onKey = e => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('.modal-close').addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  if (opts.watchJob) mirror(opts.watchJob); else renderForm();
  root.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
}

// Shimmer placeholders shown while companies.json loads.
function renderSkeleton() {
  $('#screen').innerHTML = `
    <div class="flex items-end justify-between gap-4">
      <div><div class="sk h-7 w-52 mb-2"></div><div class="sk h-4 w-72"></div></div>
      <div class="sk h-11 w-40 rounded-full"></div>
    </div>
    <div class="grid gap-5 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 mt-6">
      ${Array.from({ length: 3 }).map(() => `
        <div class="surface-card p-[18px]">
          <div class="flex items-center gap-3">
            <div class="sk w-[46px] h-[46px] rounded-xl"></div>
            <div class="flex-1"><div class="sk h-4 w-28 mb-2"></div><div class="sk h-3 w-20"></div></div>
          </div>
          <div class="sk h-6 w-24 rounded-full mt-3"></div>
          <div class="card-divider"></div>
          <div class="flex justify-between"><div class="sk h-9 w-28"></div><div class="sk h-9 w-24"></div></div>
          <div class="sk h-[58px] w-full mt-4"></div>
        </div>`).join('')}
    </div>`;
}

function renderEmptyState() {
  const el = h(`
    <div class="surface-card grid place-items-center text-center px-6 py-16">
      <span class="grid place-items-center w-14 h-14 rounded-2xl text-navy mb-4" style="background:${tint(BRAND.navy, .08)}">${icon('inbox', 'w-7 h-7')}</span>
      <h3 class="font-display text-[18px] font-semibold text-ink">No deals in the pipeline yet</h3>
      <p class="text-[13.5px] text-ink-muted mt-1 max-w-sm">When bankers send an IM and financial model, add the deal and a screening memo is built for Monday's meeting.</p>
      <button class="add-btn-row mt-5" style="max-width:220px" type="button">${icon('plus', 'w-5 h-5', 2.4)}<span>Add a deal</span></button>
    </div>`);
  el.querySelector('.add-btn-row').addEventListener('click', openAddDealModal);
  return el;
}

function renderError(err) {
  const isFile = location.protocol === 'file:';
  const hint = isFile
    ? 'The data file can’t be read from a file:// path. Serve the folder over HTTP — e.g. “npm run dev” (wrangler) or “npx serve public”.'
    : 'Please refresh to try again.';
  $('#screen').innerHTML = `
    <div class="surface-card grid place-items-center text-center px-6 py-16">
      <span class="grid place-items-center w-14 h-14 rounded-2xl mb-4" style="background:${tint('#E11D48', .1)};color:#E11D48">${icon('alert', 'w-7 h-7')}</span>
      <h3 class="font-display text-[18px] font-semibold text-ink">Couldn’t load the pipeline</h3>
      <p class="text-[13.5px] text-ink-muted mt-1 max-w-md">${esc(hint)}</p>
      <p class="text-[11.5px] text-ink-hint mt-3 font-mono">${esc(err && err.message || err)}</p>
    </div>`;
}

/* -----------------------------------------------------------------------------
 * 10. Boot
 * ---------------------------------------------------------------------------*/
async function init() {
  if (window.Chart) {
    Chart.defaults.font.family = "'Sora', 'Inter', sans-serif";
    Chart.defaults.font.size = 11;
    Chart.defaults.color = BRAND.muted;
  }

  initHeader();
  renderSkeleton();

  try {
    const data = await loadCompanies();
    state.meta = data.meta || null;
    state.companies = Array.isArray(data.companies) ? data.companies : [];
    state.peerLiveEnabled = !!data.peerLiveEnabled;
    state.peerLiveProxy = !!data.peerLiveProxy;
    hydrateServerJobs(data.jobs);   // show any failed / in-flight builds from a previous visit
    populateCompanyDropdown();
    window.addEventListener('hashchange', route);
    route();                       // respects a deep-link hash on first load
  } catch (err) {
    console.error(err);
    renderError(err);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
