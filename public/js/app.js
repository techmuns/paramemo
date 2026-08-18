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

// Resolve the data file relative to THIS script's own URL (captured while
// document.currentScript is still valid). app.js has already loaded, so its URL
// is a known-good anchor — this makes the fetch robust whether the app is served
// from the domain root, a sub-path, or a preview host, not just "/".
const DATA_URL = (() => {
  const src = document.currentScript && document.currentScript.src;
  try { return src ? new URL('../data/companies.json', src).href : 'data/companies.json'; }
  catch (_) { return 'data/companies.json'; }
})();

async function loadCompanies() {
  // Try the script-anchored URL first, then a plain document-relative path.
  const tried = [];
  let status = 0;
  for (const url of [DATA_URL, 'data/companies.json']) {
    if (tried.includes(url)) continue;
    tried.push(url);
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (res.ok) return res.json();
      status = res.status;
    } catch (_) { /* network error — try the next candidate */ }
  }
  throw new Error(`Could not load companies.json${status ? ` (HTTP ${status})` : ''}`);
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
const LIVE_TABS = ['snapshot', 'financials'];       // built now; the rest are "Coming soon"
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

  // Export button is a placeholder through these phases (tooltip explains).
  $('#export-btn').addEventListener('click', () => toast('PDF export arrives in a later phase'));
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

  const back = h(`<button class="back-btn" type="button">${icon('arrowLeft', 'w-4 h-4', 2.4)}<span>Pipeline</span></button>`);
  back.addEventListener('click', goHome);
  shell.appendChild(back);

  shell.appendChild(renderIdentityStrip(c));
  shell.appendChild(renderTabBar(c));
  shell.appendChild(h('<div id="tab-panel"></div>'));
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
    { key: 'revenue',        label: 'Revenue',        kind: 'cr'  },
    { key: 'growthPct',      label: 'Growth',         kind: 'pct', bar: true },
    { key: 'grossMarginPct', label: 'Gross margin',   kind: 'pct', bar: true },
    { key: 'ebitda',         label: 'EBITDA',         kind: 'cr'  },
    { key: 'ebitdaPct',      label: 'EBITDA margin',  kind: 'pct', bar: true },
    { key: 'pat',            label: 'PAT (net profit)', kind: 'cr' },
    { key: 'patPct',         label: 'PAT margin',     kind: 'pct', bar: true },
  ]},
  { title: 'Returns', rows: [
    { key: 'roePct',  label: 'Return on equity',  kind: 'pct', bar: true },
    { key: 'rocePct', label: 'Return on capital', kind: 'pct', bar: true },
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

  // Header
  let head = '<thead><tr><th class="rowhead">&nbsp;</th>';
  v.years.forEach((y, i) => {
    const cls = (v.isForecast(i) ? 'fc' : '') + (i === v.actualsCut ? ' fc-start' : '');
    head += `<th class="${cls}">${esc(y)}</th>`;
  });
  head += '</tr></thead>';
  table.innerHTML = head;

  // Body
  const tbody = h('<tbody></tbody>');
  const colCount = v.years.length + 1;
  FIN_GROUPS.forEach(group => {
    const present = group.rows.filter(r => Array.isArray(rows[r.key]));
    if (!present.length) return;                                   // skip empty groups cleanly
    tbody.appendChild(h(`<tr class="group"><td colspan="${colCount}">${esc(group.title)}</td></tr>`));
    present.forEach(r => {
      const visible = rows[r.key].slice(0, v.n);
      const maxAbs = Math.max(1, ...visible.filter(x => x != null).map(x => Math.abs(x)));
      let tr = `<tr><td class="rowhead">${esc(r.label)}</td>`;
      visible.forEach((val, i) => {
        const fcCls = (v.isForecast(i) ? 'fc' : '') + (i === v.actualsCut ? ' fc-start' : '');
        tr += finCell(val, r, maxAbs, fcCls);
      });
      tbody.appendChild(h(tr + '</tr>'));
    });
  });
  table.appendChild(tbody);
  card.querySelector('.fin-scroll').appendChild(table);
  return card;
}

// One financial cell. cr → plain number (red if negative); pct → number + mini-bar.
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
  return `<td class="val ${neg ? 'neg' : ''} ${fcCls}">${fmtNum(val)}</td>`;
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

/* -----------------------------------------------------------------------------
 * 8. Charts (Chart.js) — sparklines (shape-scaled) + full charts (zero-based)
 * ---------------------------------------------------------------------------*/
let _charts = []; // every live Chart instance; destroyed on any re-render
function destroyCharts() { _charts.forEach(ch => ch.destroy()); _charts = []; }

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
    }
    if (ch) _charts.push(ch);
  });
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
function openAddDealModal() {
  const root = $('#modal-root');
  const overlay = h(`
    <div class="modal-overlay" role="dialog" aria-modal="true" aria-label="Add a deal">
      <div class="modal">
        <div class="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-[#EEF1F6]">
          <div>
            <h2 class="font-display text-[18px] font-semibold text-ink">Add a deal</h2>
            <p class="text-[13px] text-ink-muted mt-0.5">Build a screening memo from a banker's materials.</p>
          </div>
          <button class="modal-close text-ink-hint hover:text-ink transition-colors -mr-1" aria-label="Close">${icon('x', 'w-5 h-5')}</button>
        </div>

        <div class="px-6 py-5">
          <div class="dropzone" aria-disabled="true">
            <span class="grid place-items-center w-12 h-12 rounded-full" style="background:${tint(BRAND.navy, .08)};color:${BRAND.navy}">${icon('upload', 'w-6 h-6')}</span>
            <div class="font-display font-semibold text-[14.5px] text-ink">Upload the IM (PDF) + Excel model here</div>
            <div class="text-[12.5px]">Automatic reading &amp; memo-building is coming in a later phase.</div>
            <div class="flex flex-wrap items-center justify-center gap-2 mt-1">
              <span class="file-chip">${icon('fileText', 'w-4 h-4')} Information Memorandum · PDF</span>
              <span class="file-chip">${icon('sheet', 'w-4 h-4')} Financial model · Excel</span>
            </div>
          </div>
        </div>

        <div class="flex items-center justify-end gap-2.5 px-6 pb-5">
          <button class="modal-close hdr-btn" style="color:${BRAND.ink};background:#F2F5FB;border-color:${BRAND.border}">Close</button>
          <button class="hdr-btn is-disabled" style="color:#fff;background:${BRAND.navy};border-color:${BRAND.navy}" aria-disabled="true" data-tip="Coming in a later phase">
            ${icon('trendingUp', 'w-4 h-4')} Build memo
          </button>
        </div>
      </div>
    </div>`);

  const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 200); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('.modal-close').forEach(b => b.addEventListener('click', close));
  document.addEventListener('keydown', onKey);

  root.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  overlay.querySelector('.modal-close').focus();
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
