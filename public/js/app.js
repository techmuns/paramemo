'use strict';

/* =============================================================================
   Paragon Partners — Screening Memo
   app.js  ·  Phase 1 (app shell + Pipeline landing screen)

   HOW THIS IS ORGANISED (so later phases slot in cleanly)
   -----------------------------------------------------------------------------
   1. Design tokens   – JS mirror of the CSS/Tailwind theme, so charts match.
   2. Utilities       – formatting, tiny DOM + icon helpers, tooltip, toast.
   3. State + data    – single source of truth is /data/companies.json.
   4. Header          – company dropdown + export button wiring.
   5. Pipeline screen – heading, Cards/Table toggle, cards, table, add-a-deal.
   6. Charts          – revenue sparklines (Chart.js).
   7. Overlays        – add-a-deal modal, skeleton, empty + error states.
   8. Boot            – init().

   IMPORTANT: never hardcode company data here. Everything visible about a deal
   comes from companies.json. Later phases ADD fields to each company and ADD a
   per-company "memo" view — the openCompany() hook below is where that routes.
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
// Translucent version of a hex colour, for tinted chips/badges.
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

// Inline Lucide-style icons (24×24, currentColor stroke). Small, tasteful set.
const ICONS = {
  grid:       '<rect width="7" height="7" x="3" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="3" rx="1.5"/><rect width="7" height="7" x="3" y="14" rx="1.5"/><rect width="7" height="7" x="14" y="14" rx="1.5"/>',
  table:      '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M12 3v18"/>',
  plus:       '<path d="M5 12h14"/><path d="M12 5v14"/>',
  chevronDown:'<path d="m6 9 6 6 6-6"/>',
  sort:       '<path d="m8 9 4-4 4 4"/><path d="m16 15-4 4-4-4"/>',
  arrowUp:    '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  arrowDown:  '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
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
};
function icon(name, cls = 'w-4 h-4', sw = 2) {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

/* ---- Floating tooltip (data-tip="…") — positioned in <body> so it is never
 *      clipped by a card or the table's scroll container. Works on hover+focus. */
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
  // point the arrow at the target's centre (tooltip may be nudged to stay on-screen)
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
  view: 'cards',                     // 'cards' | 'table'
  sort: { key: 'fit', dir: 'asc' },  // default: screening priority (Go first)
};

async function loadCompanies() {
  // Relative path so it works when served locally (static server / wrangler dev)
  // and when served by the Worker's ASSETS binding in production.
  const res = await fetch('data/companies.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load companies.json (HTTP ${res.status})`);
  return res.json();
}

// The one hook later phases replace to open a company's memo view.
function openCompany(id) {
  const c = state.companies.find(x => x.id === id);
  if (!c) return;
  toast(`${c.shortName || c.name} — the company memo opens in the next phase`);
}

/* -----------------------------------------------------------------------------
 * 4. Header wiring (company dropdown + export button)
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

function openDropdown()  { $('#company-dd-menu').classList.remove('hidden'); $('#company-dd-btn').setAttribute('aria-expanded', 'true');  $('#company-dd-chev').style.transform = 'rotate(180deg)'; }
function closeDropdown() { $('#company-dd-menu').classList.add('hidden');    $('#company-dd-btn').setAttribute('aria-expanded', 'false'); $('#company-dd-chev').style.transform = ''; }

function initHeader() {
  initHeaderIcons();
  const btn = $('#company-dd-btn');
  btn.addEventListener('click', e => {
    e.stopPropagation();
    $('#company-dd-menu').classList.contains('hidden') ? openDropdown() : closeDropdown();
  });
  // Close on outside click / Escape.
  document.addEventListener('click', e => { if (!e.target.closest('#company-dd')) closeDropdown(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDropdown(); });

  // Export button is a placeholder in Phase 1 (tooltip explains).
  $('#export-btn').addEventListener('click', () => toast('PDF export arrives in a later phase'));
}

/* -----------------------------------------------------------------------------
 * 5. Pipeline landing screen
 * ---------------------------------------------------------------------------*/
let _sparkCharts = []; // track Chart instances so we can destroy on re-render

function renderPipeline() {
  const root = $('#pipeline');
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
  $$('#pipeline .seg-btn').forEach(b => {
    const on = b.dataset.view === view;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', String(on));
  });
  renderView();
}

// Render just the content area (cards or table) for the current view.
function renderView() {
  destroyCharts();
  hideTip(); // clear any tooltip anchored to a node we're about to remove
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
        <div class="min-w-0">
          <div class="kicker">Deal size</div>
          <div class="deal-amount tnum">${esc((c.transaction && c.transaction.headline ? c.transaction.headline.split('—')[0] : '').trim() || fmtCr(c.transaction.amountCr))}</div>
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

// Sort key → comparable value for a company.
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
function sortedCompanies() {
  const { key, dir } = state.sort, mul = dir === 'asc' ? 1 : -1;
  return [...state.companies].sort((a, b) => {
    const av = sortValue(a, key), bv = sortValue(b, key);
    return av < bv ? -mul : av > bv ? mul : 0;
  });
}

function renderTable() {
  const wrap = h('<div></div>');
  const card = h('<div class="surface-card overflow-hidden"><div class="table-scroll"></div></div>');
  const table = h('<table class="deal-table"></table>');

  // Header (sortable).
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

  // Body.
  const tbody = h('<tbody></tbody>');
  sortedCompanies().forEach(c => tbody.appendChild(renderTableRow(c)));
  table.appendChild(tbody);

  card.querySelector('.table-scroll').appendChild(table);
  wrap.appendChild(card);

  // Prominent add-a-deal affordance beneath the table (present in both views).
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
      <td class="num"><span class="row-name tnum">${fmtCr(c.transaction.amountCr)}</span><span class="row-sub">${esc(c.transaction.type)}</span></td>
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
  renderView(); // table only; cheap enough to re-render fully
}

/* -----------------------------------------------------------------------------
 * 6. Revenue sparklines (Chart.js)
 * ---------------------------------------------------------------------------*/
function destroyCharts() { _sparkCharts.forEach(ch => ch.destroy()); _sparkCharts = []; }

function initSparklines() {
  $$('#pipeline-content canvas[data-spark]').forEach(canvas => {
    const c = state.companies.find(x => x.id === canvas.dataset.spark);
    if (c && c.revenueSpark) _sparkCharts.push(buildSparkline(canvas, c.revenueSpark));
  });
}

// A clean sparkline: navy line, soft area fill, hidden axes, hover tooltip only.
// Forecast years (after `actualsThrough`) render dashed to separate est. from actual.
function buildSparkline(canvas, spark) {
  const { years, values, actualsThrough } = spark;
  const actualsIdx = years.indexOf(actualsThrough);
  const ctx = canvas.getContext('2d');

  // Vertical gradient fill under the line.
  const grad = ctx.createLinearGradient(0, 0, 0, 60);
  grad.addColorStop(0, tint(BRAND.navy, .16));
  grad.addColorStop(1, tint(BRAND.navy, 0));

  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: years,
      datasets: [{
        data: values,
        borderColor: BRAND.navy,
        borderWidth: 2,
        fill: true,
        backgroundColor: grad,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 4.5,
        pointBackgroundColor: BRAND.gold,
        pointBorderColor: '#fff',
        pointBorderWidth: 1.5,
        pointHoverBorderWidth: 2,
        // Dash the segments that end in a forecast year.
        segment: { borderDash: c => (c.p1DataIndex > actualsIdx ? [4, 3] : undefined) },
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 650 },
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 4, bottom: 2, left: 1, right: 1 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          backgroundColor: '#111827',
          padding: 9,
          cornerRadius: 8,
          titleColor: '#C7D2FE',
          titleFont: { family: 'Sora', size: 11, weight: '600' },
          bodyColor: '#fff',
          bodyFont: { family: 'Sora', size: 13, weight: '600' },
          callbacks: {
            title: items => {
              const lbl = items[0].label;
              return lbl + (years.indexOf(lbl) > actualsIdx ? '  · estimate' : '');
            },
            label: item => fmtCr(item.parsed.y),
          },
        },
      },
      scales: { x: { display: false }, y: { display: false, beginAtZero: false } },
    },
  });
}

/* -----------------------------------------------------------------------------
 * 7. Overlays: add-a-deal modal, skeleton, empty + error states
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
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });     // click backdrop
  overlay.querySelectorAll('.modal-close').forEach(b => b.addEventListener('click', close));
  document.addEventListener('keydown', onKey);

  root.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  overlay.querySelector('.modal-close').focus();
}

// Shimmer placeholders shown while companies.json loads.
function renderSkeleton() {
  const root = $('#pipeline');
  root.innerHTML = `
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
    ? 'The data file can’t be read from a file:// path. Serve the folder over HTTP — e.g. “npx serve public” or “npx wrangler dev”.'
    : 'Please refresh to try again.';
  $('#pipeline').innerHTML = `
    <div class="surface-card grid place-items-center text-center px-6 py-16">
      <span class="grid place-items-center w-14 h-14 rounded-2xl mb-4" style="background:${tint('#E11D48', .1)};color:#E11D48">${icon('alert', 'w-7 h-7')}</span>
      <h3 class="font-display text-[18px] font-semibold text-ink">Couldn’t load the pipeline</h3>
      <p class="text-[13.5px] text-ink-muted mt-1 max-w-md">${esc(hint)}</p>
      <p class="text-[11.5px] text-ink-hint mt-3 font-mono">${esc(err && err.message || err)}</p>
    </div>`;
}

/* -----------------------------------------------------------------------------
 * 8. Boot
 * ---------------------------------------------------------------------------*/
async function init() {
  // Chart.js global defaults (fonts/colours match the brand).
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
    renderPipeline();
  } catch (err) {
    console.error(err);
    renderError(err);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
