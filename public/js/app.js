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
// Turn a Bedrock model id into a friendly name, e.g.
// "us.anthropic.claude-sonnet-4-5-20250929-v1:0" → "Claude Sonnet 4.5".
function prettyModel(id) {
  if (!id) return '';
  let s = String(id).replace(/^us\./, '').replace(/^anthropic\./, '').replace(/-\d{8}-v\d+:\d+$/, '');
  if (!/^claude-/.test(s)) return id;                    // unknown shape → show raw
  const words = [], nums = [];
  s.replace(/^claude-/, '').split('-').forEach(part => {
    if (/^\d+$/.test(part)) nums.push(part);
    else { if (nums.length) { words.push(nums.join('.')); nums.length = 0; } words.push(part); }
  });
  if (nums.length) words.push(nums.join('.'));
  return 'Claude ' + words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
// The subtle "Generated by <model> · <date>" line (only for AI-generated deals).
function generatedLine(c) {
  if (!c || !c.generatedBy) return '';
  const when = c.generatedAt ? ' · ' + fmtDate(c.generatedAt) : '';
  return `Generated by ${esc(prettyModel(c.generatedBy))}${esc(when)}`;
}

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
  hideTip();
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
  requestAnimationFrame(() => _tipEl && _tipEl.classList.add('show'));
}
function hideTip() { if (_tipEl) { _tipEl.remove(); _tipEl = null; } _tipTarget = null; }
document.addEventListener('mouseover', e => {
  const t = e.target.closest('[data-tip]');
  if (t && t !== _tipTarget) { _tipTarget = t; showTip(t); }
});
document.addEventListener('mouseout', e => {
  const t = e.target.closest('[data-tip]');
  if (t && t === _tipTarget && !t.contains(e.relatedTarget)) hideTip();
});
document.addEventListener('focusin',  e => { const t = e.target.closest('[data-tip]'); if (t) { _tipTarget = t; showTip(t); } });
document.addEventListener('focusout', hideTip);
window.addEventListener('scroll', hideTip, true);

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
  view: 'cards',                     // pipeline: 'cards' | 'table'
  sort: { key: 'fit', dir: 'asc' },  // default: Fit (Go→Watch→Pass), tie-break by deal size
};

// Company-view UI state (persists across company switches).
const ui = {
  companyId: null,
  tab: 'snapshot',
  fin: { forecast: true, view: 'table' }, // financials tab: show forecast? · Table|Charts
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
  let uploaded = [];
  try {
    const res = await fetch(apiUrl('companies'), { cache: 'no-cache' });
    if (res.ok) { const d = await res.json(); if (Array.isArray(d.companies)) uploaded = d.companies; }
  } catch (_) { /* no API (static preview) — seeds only */ }

  const seeds = Array.isArray(seed.companies) ? seed.companies : [];
  const seedIds = new Set(seeds.map(c => c.id));
  return { meta: seed.meta || null, companies: [...seeds, ...uploaded.filter(c => c && !seedIds.has(c.id))] };
}

// Add or replace a company in local state + the dropdown (used after an upload).
function addCompany(company) {
  if (!company || !company.id) return;
  state.companies = state.companies.filter(c => c.id !== company.id);
  state.companies.push(company);
  populateCompanyDropdown();
}

// Remove an uploaded deal (from KV + local state), then return to the pipeline.
async function removeCompany(c) {
  const okToRemove = await confirmDialog({
    title: `Remove ${c.shortName || c.name}?`,
    message: 'This deletes the deal and its memo from the pipeline. This can’t be undone.',
    confirmLabel: 'Remove deal',
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
  { key: 'financials', label: 'Financials', icon: 'barChart'   },
  { key: 'fit',        label: 'Fit',        icon: 'target'     },
  { key: 'integrity',  label: 'Integrity',  icon: 'shield'     },
  { key: 'questions',  label: 'Questions',  icon: 'help'       },
  { key: 'thesis',     label: 'Thesis',     icon: 'lightbulb'  },
  { key: 'returns',    label: 'Returns',    icon: 'trendingUp' },
];
// All seven tabs are built as of Phases 4–5, so none carry a "coming soon" dot.
// (renderComingSoon remains as a harmless fallback for any unknown tab key.)
const LIVE_TABS = ['snapshot', 'financials', 'fit', 'integrity', 'questions', 'thesis', 'returns'];
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
}

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

  // Brand acts as a "home" link back to the pipeline.
  const brand = $('#brand-home');
  brand.addEventListener('click', goHome);
  brand.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goHome(); } });

  // Export the currently-open company's memo as a print-optimised 2-page PDF.
  const exportBtn = $('#export-btn');
  exportBtn.classList.remove('is-disabled');
  exportBtn.removeAttribute('data-tip');
  exportBtn.removeAttribute('aria-disabled');
  exportBtn.addEventListener('click', exportPdf);
}

// Build the print memo for the open company and open the browser's print dialog.
// window.print() prints THIS document (the memo in #print-root, shown only under
// @media print). It works standalone and in a normal embed; a sandboxed iframe
// without allow-modals can swallow it, so we guard and hint the keyboard shortcut.
function exportPdf() {
  const c = companyById(ui.companyId);
  if (!c) { toast('Open a company first, then export its memo'); return; }
  const root = $('#print-root');
  root.innerHTML = renderPrintMemo(c);
  try {
    window.print();
  } catch (err) {
    const key = /Mac|iP(hone|ad)/.test(navigator.platform || '') ? '⌘P' : 'Ctrl+P';
    toast(`Press ${key} to save the memo as a PDF`);
  }
}

/* -----------------------------------------------------------------------------
 * PDF export — a print-optimised 2-page screening memo (no PDF library).
 * Reads the same company object; the whole layout lives in #print-root and is
 * only visible under @media print (see index.html print CSS).
 * ---------------------------------------------------------------------------*/
function renderPrintMemo(c) {
  const fit = FIT[c.fit && c.fit.verdict] || FIT.watch;
  const s = c.snapshot || {};
  const t = c.transaction || {}, o = c.origination || {};
  const fy = (c.headline && c.headline.revenueLabel || '').split(' ')[0];

  const bullets = (s.businessBullets || []).map(b => `<li>${esc(b)}</li>`).join('');
  const dealFacts = [
    ['Sector', c.sector], ['Ask', t.headline], ['Type', t.type],
    ['Co-investment', t.coInvestment || '—'], ['Banker', o.banker], ['Origination', fmtDate(o.date)],
  ].map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v == null ? '—' : v)}</td></tr>`).join('');

  return `
    <div class="pm">
      <div class="pm-cover">
        <div class="pm-eyebrow">Paragon Partners · Screening Memo</div>
        <div class="pm-title-row">
          <div class="pm-mono">${esc(c.monogram || initials(c.shortName || c.name))}</div>
          <div>
            <h1>${esc(c.name)}</h1>
            <div class="pm-titlesub">${esc(c.project)} · ${esc(c.sector)}</div>
          </div>
          <div class="pm-fit pm-fit-${esc(c.fit ? c.fit.verdict : 'watch')}">● ${fit.label}</div>
        </div>
        <div class="pm-facts">
          <span><b>Deal</b>${esc(dealHeadline(c))}</span>
          <span><b>Banker</b>${esc(o.banker)} · ${esc(fmtDate(o.date))}</span>
          <span><b>Latest revenue</b>${esc(fmtCr(c.headline.revenueCr))}${fy ? ' (' + esc(fy) + ')' : ''}</span>
        </div>
        <p class="pm-reason"><b>Fit — ${fit.label}:</b> ${esc(c.fit ? c.fit.reason : '')}</p>
      </div>

      <div class="pm-section">
        <h2>What they do</h2>
        <p>${esc(s.whatTheyDo || c.oneLiner || '')}</p>
        ${bullets ? `<ul class="pm-bullets">${bullets}</ul>` : ''}
      </div>

      <div class="pm-section">
        <h2>The deal</h2>
        <table class="pm-facts-tbl" style="width:100%;border-collapse:collapse">${dealFacts}</table>
      </div>

      <div class="pm-section">
        <h2>Financials (₹ crore)</h2>
        ${printFinTable(c)}
      </div>

      <div class="pm-section">
        <h2>Fit checklist</h2>
        ${printChecklist(c)}
      </div>

      <div class="pm-section">
        <h2>Integrity checks</h2>
        ${printIntegrity(c)}
      </div>

      <div class="pm-cols">
        <div class="pm-section" style="margin-top:0">
          <h2>Why we’d invest</h2>
          ${(c.thesis || []).map(x => `<div class="pm-point"><b>${esc(x.point)}</b><span>${esc(x.detail)}</span></div>`).join('')}
        </div>
        <div class="pm-section" style="margin-top:0">
          <h2>What worries us</h2>
          ${(c.concerns || []).map(x => `<div class="pm-point"><b>${esc(x.issue)}</b><span>${esc(x.detail)}</span><span class="mit">Mitigant: ${esc(x.mitigant)}</span></div>`).join('')}
        </div>
      </div>

      <div class="pm-foot">Paragon Partners · Screening Memo · Confidential — prepared for the Monday pipeline meeting${generatedLine(c) ? '<br>' + generatedLine(c) : ''}</div>
    </div>`;
}

// Compact financials table for print: all years, forecast columns tinted, negatives red.
function printFinTable(c) {
  const fin = c.financials;
  if (!fin || !Array.isArray(fin.years)) return '';
  const years = fin.years, cut = years.indexOf(fin.actualsThrough) + 1;
  const defs = FIN_GROUPS.flatMap(g => g.rows).filter(r => Array.isArray(fin.rows[r.key]));
  const head = '<tr><th></th>' + years.map((y, i) => `<th class="${i >= cut ? 'fc' : ''}">${esc(y)}</th>`).join('') + '</tr>';
  const body = defs.map(r => {
    const arr = fin.rows[r.key];
    const cells = years.map((y, i) => {
      const v = arr[i], fc = i >= cut ? 'fc' : '';
      if (v == null) return `<td class="${fc}">—</td>`;
      const neg = v < 0 ? 'neg' : '';
      return `<td class="${fc} ${neg}">${r.kind === 'pct' ? v + '%' : fmtNum(v)}</td>`;
    }).join('');
    return `<tr><td>${esc(r.label)}</td>${cells}</tr>`;
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
    const mk = it.status === 'clear' ? '✓' : it.status === 'flag' ? '⚠' : '○';
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
      <div class="shrink-0">
        <div class="seg" role="tablist" aria-label="View">
          <button class="seg-btn" data-view="cards" role="tab">${icon('grid', 'w-4 h-4')}<span>Cards</span></button>
          <button class="seg-btn" data-view="table" role="tab">${icon('table', 'w-4 h-4')}<span>Table</span></button>
        </div>
      </div>
    </div>`);

  wrap.querySelectorAll('.seg-btn').forEach(b => {
    b.classList.toggle('is-active', b.dataset.view === state.view);
    b.setAttribute('aria-selected', String(b.dataset.view === state.view));
    b.addEventListener('click', () => setView(b.dataset.view));
  });
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
  if (!state.companies.length) { content.appendChild(renderEmptyState()); return; }
  content.appendChild(state.view === 'cards' ? renderCards() : renderTable());
  if (state.view === 'cards') requestAnimationFrame(initSparklines);
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
            <h3 class="card-title truncate">${esc(c.shortName || c.name)}</h3>
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
  const wrap = h('<div></div>');
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
  wrap.appendChild(card);

  const add = h(`<button class="add-btn-row mt-4" type="button">${icon('plus', 'w-5 h-5', 2.4)}<span>Add a deal</span></button>`);
  add.addEventListener('click', openAddDealModal);
  wrap.appendChild(add);
  return wrap;
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
            <span class="row-name block truncate">${esc(c.shortName || c.name)}</span>
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
  // Uploaded deals can be removed; the 3 seeds cannot.
  if (c.generatedBy) {
    const rm = h(`<button class="rm-btn" type="button">${icon('trash', 'w-4 h-4')}<span>Remove deal</span></button>`);
    rm.addEventListener('click', () => removeCompany(c));
    topRow.appendChild(rm);
  }
  shell.appendChild(topRow);

  shell.appendChild(renderIdentityStrip(c));
  shell.appendChild(renderTabBar(c));
  shell.appendChild(h('<div id="tab-panel"></div>'));
  // Subtle provenance line for AI-generated (uploaded) deals; seeds have none.
  const gen = generatedLine(c);
  if (gen) shell.appendChild(h(`<div class="flex items-center gap-1.5 text-[11px] text-ink-hint pt-1">${icon('sparkles', 'w-3.5 h-3.5')}<span>${gen}</span></div>`));
  root.appendChild(shell);
}

function renderIdentityStrip(c) {
  const fit = FIT[c.fit && c.fit.verdict] || FIT.watch;
  const sc = sectorColor(c.sectorTag);
  return h(`
    <div class="identity">
      <div class="flex items-center gap-3 min-w-0">
        <div class="monogram-badge" style="width:52px;height:52px;border-radius:14px;font-size:18px">${esc(c.monogram || '')}</div>
        <div class="id-block min-w-0">
          <div class="id-name truncate">${esc(c.name)}</div>
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
        <div class="meta-line mt-0.5 truncate">${esc(dealHeadline(c))}</div>
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
  else if (tab === 'financials') node = renderFinancials(c);
  else if (tab === 'fit')        node = renderFit(c);
  else if (tab === 'integrity')  node = renderIntegrity(c);
  else if (tab === 'questions')  node = renderQuestions(c);
  else if (tab === 'thesis')     node = renderThesis(c);
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

function renderWhatTheyDo(c) {
  const s = c.snapshot || {};
  const body = h('<div class="grid gap-5 lg:grid-cols-5 items-start"></div>');
  body.appendChild(h(`<p class="lede lg:col-span-3">${esc(s.whatTheyDo || '')}</p>`));
  const chips = h('<div class="lg:col-span-2 flex flex-col gap-2"></div>');
  (s.businessBullets || []).forEach(b =>
    chips.appendChild(h(`<span class="bullet-chip"><span class="b-ico">${icon('check', 'w-3.5 h-3.5', 2.6)}</span><span>${esc(b)}</span></span>`)));
  body.appendChild(chips);
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
    list.appendChild(h(`
      <div class="person-card flex items-start gap-3">
        <span class="person-avatar">${esc(initials(p.name))}</span>
        <div class="min-w-0">
          <div class="person-name">${esc(p.name)}</div>
          <div class="person-role">${esc(p.role)}</div>
          <div class="person-note">${esc(p.note)}</div>
        </div>
      </div>`));
  });
  return sectionCard('Promoters', 'star', list);
}

function renderManagement(c) {
  const scroll = h('<div class="table-scroll"></div>');
  const table = h(`<table class="mini-table"><thead><tr><th>Name</th><th>Role</th><th>Background</th></tr></thead><tbody></tbody></table>`);
  const tb = table.querySelector('tbody');
  (c.snapshot && c.snapshot.management || []).forEach(m =>
    tb.appendChild(h(`<tr>
      <td class="font-semibold text-ink whitespace-nowrap">${esc(m.name)}</td>
      <td class="text-navy font-medium whitespace-nowrap">${esc(m.role)}</td>
      <td class="text-ink-muted">${esc(m.note)}</td>
    </tr>`)));
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
  wrap.appendChild(ui.fin.view === 'charts' ? renderFinCharts(c) : renderFinTable(c));
  return wrap;
}

function renderFinControls(c) {
  const el = h(`
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="fin-unit">Figures in <b>₹ crore</b> — rounded${ui.fin.forecast ? '; tinted columns = forecast' : ''}</div>
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
  if (fin.revenueMix) grid.appendChild(chartCard(fin.revenueMix.label || 'Revenue mix', 'pieChart', 'revmix'));
  if (fin.rows.cash && fin.rows.debt) grid.appendChild(chartCard('Cash vs Debt', 'wallet', 'cashDebt'));
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
  fit:       'How this deal maps to Paragon’s mandate — sector, cheque size, stage and the full go / watch / pass rationale.',
  integrity: 'Promoter background, governance flags and the diligence checklist that must clear before we proceed.',
  questions: 'The sharp questions for the banker and management, gathered in one place for the meeting.',
  thesis:    'Why this could be a great investment — the value-creation story and the risks that could break it.',
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
  clear:   { color: '#10B981', icon: 'check',  label: 'Clear'   },
  flag:    { color: '#F59E0B', icon: 'alert',  label: 'Flag'    },
  pending: { color: '#9CA3AF', icon: 'circle', label: 'Pending' },
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
  const toCheck = items.length - clear;
  const wrap = h('<div class="space-y-5"></div>');

  wrap.appendChild(h(`
    <div class="surface-card px-5 py-3.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
      <span class="inline-flex items-center gap-2"><span class="dot-sm" style="background:${POS}"></span><b class="text-ink font-semibold">${clear} clear</b></span>
      <span class="text-ink-hint">·</span>
      <span class="inline-flex items-center gap-2"><span class="dot-sm" style="background:#F59E0B"></span><b class="text-ink font-semibold">${toCheck} to check</b></span>
      <span class="ml-auto text-[12px] text-ink-hint">Background &amp; diligence scan</span>
    </div>`));

  const card = h('<div class="surface-card p-2.5"></div>');
  items.forEach(it => {
    const st = INTEG_STATUS[it.status] || INTEG_STATUS.pending;
    card.appendChild(h(`
      <div class="integ-row">
        <span class="integ-area-ico">${icon(integrityIcon(it.area), 'w-4 h-4')}</span>
        <div class="integ-body">
          <div class="integ-area">${esc(it.area)}</div>
          <div class="integ-find">${esc(it.finding)}</div>
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
      <button class="link-btn" data-toggle-all type="button">Expand all</button>
    </div>`);
  wrap.appendChild(bar);

  const listWrap = h('<div class="space-y-2.5"></div>');
  themes.forEach((t, i) => {
    const open = i === 0;                          // first theme open so the pattern is visible
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

/* ---- 7h. Returns tab (plain-language "what could we make?") ---- */
const RETURN_SLIDERS = [
  { key: 'entryX',    label: 'What we pay — entry price (× profit)',    min: 4, max: 25, step: 1, suffix: '×'   },
  { key: 'growthPct', label: 'How fast profit grows (% per year)',      min: 0, max: 60, step: 1, suffix: '%'   },
  { key: 'exitX',     label: 'What we sell for — exit price (× profit)', min: 4, max: 25, step: 1, suffix: '×'  },
  { key: 'years',     label: 'Years we hold',                           min: 2, max: 8,  step: 1, suffix: ' yrs' },
];

// Pure calculation (plain JS, per the spec).
function computeReturns(c, v) {
  const { investmentCr, startEbitdaCr } = c.returns;
  const entryValue = v.entryX * startEbitdaCr;
  const stake = Math.min(1, investmentCr / entryValue);
  const exitProfit = startEbitdaCr * Math.pow(1 + v.growthPct / 100, v.years);
  const exitValue = v.exitX * exitProfit;
  const proceeds = stake * exitValue;
  const moneyBack = proceeds / investmentCr;
  const yearlyReturn = (Math.pow(Math.max(moneyBack, 0), 1 / v.years) - 1) * 100;
  return { proceeds, moneyBack, yearlyReturn };
}
function readReturns(root) {
  const g = k => Number(root.querySelector(`[data-slider="${k}"]`).value);
  return { entryX: g('entryX'), growthPct: g('growthPct'), exitX: g('exitX'), years: g('years') };
}

function renderReturns(c) {
  const r = c.returns, d = r.defaults;
  const wrap = h('<div class="space-y-5"></div>');

  wrap.appendChild(h(`<div class="text-[13px] text-ink-muted">Investment: <b class="text-ink font-semibold tnum">${fmtCr(r.investmentCr)}</b> · Starting yearly profit (EBITDA): <b class="text-ink font-semibold tnum">${fmtCr(r.startEbitdaCr)}</b> (${esc(r.startYear)})</div>`));

  // Two big answers.
  wrap.appendChild(h(`
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div class="result-card">
        <div class="result-kick">Money back</div>
        <div class="result-num tnum" data-out="moneyBack">—</div>
        <div class="result-sub">on ${fmtCr(r.investmentCr)} invested</div>
      </div>
      <div class="result-card">
        <div class="result-kick">Yearly return</div>
        <div class="result-num tnum" data-out="yearly">—</div>
        <div class="result-sub">compounded, per year</div>
      </div>
    </div>`));

  // Sliders + supporting chart.
  const grid = h('<div class="grid gap-5 lg:grid-cols-2 items-start"></div>');
  const sliders = h(`<div class="surface-card p-5"><div class="section-title"><span class="sec-ico">${icon('sliders', 'w-4 h-4')}</span>Your assumptions</div></div>`);
  RETURN_SLIDERS.forEach(s => sliders.appendChild(h(`
    <div class="slider-row">
      <div class="slider-head">
        <span class="slider-label">${esc(s.label)}</span>
        <span class="slider-val tnum" data-val="${s.key}">${d[s.key]}${esc(s.suffix)}</span>
      </div>
      <input type="range" class="range" data-slider="${s.key}" data-suffix="${esc(s.suffix)}" min="${s.min}" max="${s.max}" step="${s.step}" value="${d[s.key]}" aria-label="${esc(s.label)}">
    </div>`)));
  grid.appendChild(sliders);

  const chart = h(`
    <div class="surface-card p-5">
      <div class="section-title"><span class="sec-ico">${icon('coins', 'w-4 h-4')}</span>Invested vs. potential return</div>
      <div class="text-[12.5px] text-ink-muted mb-2" data-out="chartCap">—</div>
      <div class="chart-box" style="height:200px"><canvas data-chart="returns"></canvas></div>
    </div>`);
  grid.appendChild(chart);
  wrap.appendChild(grid);

  wrap.appendChild(h('<p class="text-[12px] text-ink-hint">Quick estimate — move the sliders to test assumptions. Not a full valuation.</p>'));

  wrap.querySelectorAll('[data-slider]').forEach(inp => inp.addEventListener('input', () => recomputeReturns(c, wrap)));
  requestAnimationFrame(() => recomputeReturns(c, wrap));   // set numbers (chart syncs once built)
  return wrap;
}

function recomputeReturns(c, root) {
  const v = readReturns(root);
  root.querySelectorAll('[data-slider]').forEach(inp => {
    const lab = root.querySelector(`[data-val="${inp.dataset.slider}"]`);
    if (lab) lab.textContent = inp.value + inp.dataset.suffix;
  });
  const out = computeReturns(c, v);

  root.querySelector('[data-out="moneyBack"]').textContent = out.moneyBack.toFixed(1) + '×';
  const yInt = Math.round(out.yearlyReturn);
  const yEl = root.querySelector('[data-out="yearly"]');
  yEl.textContent = yInt + '%';
  yEl.style.color = yInt >= 20 ? POS : yInt >= 10 ? '#B45309' : '#E11D48';

  const cap = root.querySelector('[data-out="chartCap"]');
  if (cap) cap.innerHTML = `Invested <b class="text-ink tnum">${fmtCr(c.returns.investmentCr)}</b> → could return <b class="text-ink tnum">${fmtCr(Math.round(out.proceeds))}</b>`;

  if (_returnsChart) {
    _returnsChart.data.datasets[0].data = [c.returns.investmentCr, Math.round(out.proceeds)];
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
    let ch = null;
    switch (cv.dataset.chart) {
      case 'ownership': ch = buildOwnershipChart(cv, c); break;
      case 'revEbitda': ch = buildRevEbitda(cv, c);      break;
      case 'margins':   ch = buildMargins(cv, c);        break;
      case 'revmix':    ch = buildRevMix(cv, c);         break;
      case 'cashDebt':  ch = buildCashDebt(cv, c);       break;
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
  const v = (panel && panel.querySelector('[data-slider]')) ? readReturns(panel) : c.returns.defaults;
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
      data: [c.returns.investmentCr, Math.round(out.proceeds)],
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
  const ds = (label, arr, hex) => ({ label, data: arr.slice(0, v.n), backgroundColor: barColors(hex, v),
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
    label, data: arr.slice(0, v.n), borderColor: hex, backgroundColor: hex, borderWidth: 2.5, tension: 0.3,
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
  if (!r.cash || !r.debt) return null;
  const ds = (label, arr, hex) => ({ label, data: arr.slice(0, v.n), backgroundColor: barColors(hex, v),
    borderRadius: 4, borderSkipped: false, maxBarThickness: 26, categoryPercentage: 0.68, barPercentage: 0.9 });
  return new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels: v.years, datasets: [ds('Cash', r.cash, POS), ds('Debt', r.debt, NEG)] },
    options: cartesianBase(false),
  });
}

function buildRevMix(canvas, c) {
  const mix = c.financials.revenueMix;
  if (!mix) return null;
  return buildDoughnut(canvas, mix.slices.map(s => s.name), mix.slices.map(s => s.pct), true);
}
function buildOwnershipChart(canvas, c) {
  const own = c.snapshot && c.snapshot.ownership;
  if (!own) return null;
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
// Excel → CSV of the best financial sheet(s) via SheetJS (capped ~40k chars).
async function parseExcel(file, cap = 40000) {
  const buf = await file.arrayBuffer();
  const wb = window.XLSX.read(buf, { type: 'array' });
  const sheetNames = wb.SheetNames.slice();
  let chosen = sheetNames.filter(n => /summary|consol|p&l|pnl|income|financial|charts/i.test(n));
  if (!chosen.length) {                                  // else the largest data sheet
    let best = null, bestSize = -1;
    sheetNames.forEach(n => {
      const ref = wb.Sheets[n] && wb.Sheets[n]['!ref'];
      const r = ref ? window.XLSX.utils.decode_range(ref) : null;
      const size = r ? (r.e.r + 1) * (r.e.c + 1) : 0;
      if (size > bestSize) { bestSize = size; best = n; }
    });
    if (best) chosen = [best];
  }
  let csv = '';
  for (const n of chosen) {
    csv += `# Sheet: ${n}\n` + window.XLSX.utils.sheet_to_csv(wb.Sheets[n]) + '\n\n';
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

/* ---- The real "Add a deal" modal: upload → AI → memo ---- */
function openAddDealModal() {
  const root = $('#modal-root');
  const sel = { im: null, excel: null, notes: null };   // chosen files

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
    <input type="file" data-file="notes" accept="application/pdf,.pdf,.txt,.md,text/plain">
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

  function renderForm(errMsg) {
    bodyEl.innerHTML = `
      ${errMsg ? `<div class="form-err mb-4">${icon('alert', 'w-4 h-4 shrink-0 mt-0.5')}<span>${esc(errMsg)}</span></div>` : ''}
      <div class="space-y-2.5">
        ${dropzone('im', 'Information Memorandum · PDF', 'Click to choose the IM (PDF)', true)}
        ${dropzone('excel', 'Financial model · Excel', 'Click to choose the model (.xlsx)', true)}
        ${dropzone('notes', 'Banker notes', 'Click to add notes (PDF or text)', false)}
      </div>
      <div class="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div class="field"><label>Company name</label><input data-basic="name" placeholder="e.g. Acme Ltd" autocomplete="off"></div>
        <div class="field"><label>Sector</label><input data-basic="sector" placeholder="e.g. Consumer" autocomplete="off"></div>
        <div class="field"><label>Banker</label><input data-basic="banker" placeholder="e.g. Axis Capital" autocomplete="off"></div>
        <div class="field"><label>Deal ask</label><input data-basic="ask" placeholder="e.g. Up to ₹300 cr" autocomplete="off"></div>
      </div>
      <p class="text-[11.5px] text-ink-hint mt-4">Files are read in your browser; only the extracted text is sent to your firm's own AI. The AI fills in every tab — you can review before Monday.</p>
      <div class="flex items-center justify-end gap-2.5 mt-5">
        <button class="modal-close hdr-btn" style="color:${BRAND.ink};background:#F2F5FB;border-color:${BRAND.border}">Close</button>
        <button class="hdr-btn" data-generate style="color:#fff;background:${BRAND.navy};border-color:${BRAND.navy}">
          ${icon('trendingUp', 'w-4 h-4')} Generate memo
        </button>
      </div>`;
    bodyEl.querySelectorAll('.modal-close').forEach(b => b.addEventListener('click', close));
    bodyEl.querySelectorAll('[data-uz]').forEach(b => b.addEventListener('click', () => fileInput(b.dataset.uz).click()));
    bodyEl.querySelector('[data-generate]').addEventListener('click', generate);
  }

  // Steps shown to the partner (plain language, no internal/model detail).
  const GEN_STEPS = [
    { icon: 'fileText', label: 'Reading the Information Memorandum' },
    { icon: 'sheet',    label: 'Reading the financial model' },
    { icon: 'scale',    label: 'Analysing the numbers & fit' },
    { icon: 'sparkles', label: 'Writing your screening memo' },
  ];
  const BAR_BASE  = [10, 32, 54, 76];   // where the bar jumps to when a step begins
  const BAR_CREEP = [28, 50, 72, 96];   // where it slowly creeps while that step runs

  // Build the working screen once and return a small controller to drive it.
  function renderWorking() {
    bodyEl.innerHTML = `
      <div class="gen-wrap">
        <div class="gen-hero"><div class="gen-hero-ic">${icon('sparkles', 'w-6 h-6', 2.2)}</div></div>
        <div class="gen-head font-display" data-head>Getting started…</div>
        <div class="gen-sub">This usually takes about a minute. It saves to your pipeline automatically.</div>
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
      </div>`;

    const barEl = bodyEl.querySelector('[data-bar]');
    const pctEl = bodyEl.querySelector('[data-pct]');
    const headEl = bodyEl.querySelector('[data-head]');
    const elapsedEl = bodyEl.querySelector('[data-elapsed]');
    const stepEls = [...bodyEl.querySelectorAll('[data-gstep]')];
    let curPct = 0, pctRAF = 0, creepTO = null, finished = false, startT = 0, timerIV = null;

    const fmtElapsed = ms => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    function startTimer() {
      if (startT) return;
      startT = performance.now();
      timerIV = setInterval(() => { if (elapsedEl) elapsedEl.textContent = fmtElapsed(performance.now() - startT) + ' elapsed'; }, 1000);
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
      elapsedText: () => (startT ? fmtElapsed(performance.now() - startT) : '0:00'),
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
      sel.im = sel.excel = sel.notes = null; captured.basics = {}; renderForm();
    });
  }

  async function generate() {
    if (!sel.im)    return renderForm('Please add the Information Memorandum (PDF).');
    if (!sel.excel) return renderForm('Please add the Excel financial model (.xlsx).');
    let writeTO = null;
    try {
      const gp = renderWorking();
      gp.stage(0);
      await ensureUploadLibs();

      const imText = await extractPdfText(sel.im);
      let imPdfBase64 = '';
      if (!imText.trim()) imPdfBase64 = await fileToBase64(sel.im);   // scanned PDF → OCR fallback

      gp.stage(1);
      const { excelText, sheetNames } = await parseExcel(sel.excel);

      let notesText = '';
      if (sel.notes) {
        notesText = /pdf$/i.test(sel.notes.name) || sel.notes.type.includes('pdf')
          ? await extractPdfText(sel.notes, 20000) : (await sel.notes.text()).slice(0, 20000);
      }

      gp.stage(2);
      const basics = { ...captured.basics };   // typed overrides captured before "working" replaced the form
      // The AI call covers "analyse" + "write"; light up the writing step partway through the wait.
      writeTO = setTimeout(() => gp.stage(3), 7000);

      const res = await fetch(apiUrl('generate'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imText, excelText, sheetNames, notesText, basics, imPdfBase64 }),
      });
      clearTimeout(writeTO);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `The request failed (${res.status}).`);
      if (!data.company) throw new Error('The AI did not return a memo. Please try again.');

      gp.stage(3);
      const builtIn = gp.elapsedText();
      gp.finish();
      addCompany(data.company);
      await new Promise(r => setTimeout(r, 650));   // let the bar fill to 100% before the success screen
      renderDone(data.company, builtIn);
    } catch (err) {
      clearTimeout(writeTO);
      console.error(err);
      renderForm((err && err.message) || 'Something went wrong — please try again.');
    }
  }

  // Capture basics before we blow away the form during "working" (so generate can read them).
  const captured = { basics: {} };
  overlay.addEventListener('input', e => {
    const b = e.target.closest('[data-basic]');
    if (b) { const v = b.value.trim(); if (v) captured.basics[b.dataset.basic] = v; else delete captured.basics[b.dataset.basic]; }
  });

  // Wire the hidden inputs → store file + re-render the form (keeps basics via captured).
  ['im', 'excel', 'notes'].forEach(k => fileInput(k).addEventListener('change', e => {
    sel[k] = e.target.files[0] || null;
    renderForm();
    // restore typed basics into the re-rendered inputs
    Object.entries(captured.basics).forEach(([key, val]) => { const i = bodyEl.querySelector(`[data-basic="${key}"]`); if (i) i.value = val; });
  }));

  const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 200); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('.modal-close').addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  renderForm();
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
