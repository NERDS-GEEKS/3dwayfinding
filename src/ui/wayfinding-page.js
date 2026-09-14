/**
 * Standalone `/wayfinding` page — plan a route between two POIs inside the
 * Matterport space.
 *
 * Separate from the editor on purpose: the editor's Matterport view exists to
 * place POIs, and its toolbars, gizmos and place-handlers all assume that. This
 * page mounts the same Showcase host with none of that authoring chrome, so the
 * space is purely for viewing a route.
 *
 * The navmesh here is the **uploaded** `.navmesh` only
 * (`ensureNavMeshAvailable({ allowGenerate: false })`). Baking one from the
 * geometric mesh takes tens of seconds and can differ from what the AR
 * experience actually ships — a wayfinding preview that disagrees with the live
 * app would be worse than no preview, so if the upload is missing this page says
 * so rather than quietly generating a different mesh.
 */

import '../styles/global.css';
import '../styles/enterprise-theme.css';
import '../styles/glass-theme.css';
import '../styles/glass-animations.css';
import '../styles/wayfinding.css';
import '../styles/wayfinding-chat.css';

import { initTheme } from '../config/theme.js';
import { BRAND_NAME } from '../config/brand.js';
import { iconNavigate } from './icons.js';
import { renderForm } from './form.js';
import { showToast } from './toast.js';
import { authenticateLoginNavme, insertWayfindingFeedback } from '../services/supabase.js';
import { setPoiSession, getPoiType } from '../config/poi-session.js';
import { getProjectSession, clearProjectSession } from '../config/project-session.js';

import { localizeAgainstMap, openRearCamera } from '../ar/vps-localize.js';
import { fetchMultisetConfig } from '../services/multiset.js';
import { isSuperAdminMapRole } from '../ar/pois.js';
import { poisData, hydratePoisFromSupabase } from '../ar/pois.js';
import {
  getStairChains,
  hydrateStairChainsFromSupabase,
  stairChainsData,
  addStairChain,
  saveStairChain,
  removeStairChain,
} from '../ar/stair-chains.js';
import {
  floorsData,
  hydrateFloorsFromSupabase,
  getFloorById,
  getFloorNameById,
} from '../ar/floors.js';
import {
  categoriesData,
  hydrateCategoriesFromSupabase,
  getCategoryById,
  getCategoryLabel,
} from '../ar/categories.js';
import { renderCategoryIcon } from '../config/category-icons.js';
import { initWayfindingChat } from './wayfinding-chat.js';
import {
  hydrateMediaFromSupabase,
  getActiveMatterportUrl,
  getActiveNavMeshMap,
} from '../ar/media.js';
import { ensureNavMeshAvailable, hasNavMesh } from '../ar/navigation-mesh.js';
import {
  ensureMatterportHost,
  loadMatterportMap,
  isMatterportMapActive,
  setMatterportNavRouteOverlay,
  splitRouteAtLevelChanges,
  clearMatterportNavRouteOverlay,
  matterportSweepPath,
  matterportGoToNearestSweep,
  matterportSnapPathToSweeps,
  matterportSetViewMode,
  getMatterportCameraPose,
  matterportCurrentSweep,
  matterportListSweeps,
  matterportFacePoint,
  onMatterportSweepChange,
  matterportSweepPathVia,
  setMatterportStairChains,
} from '../ar/matterport-map.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Straight-line length of a polyline, in metres. */
function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    total += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return total;
}

/** World position of a POI from its stored coordinates. */
function poiPosition(poi) {
  if (!poi) return null;
  const x = Number(poi.pos_x);
  const y = Number(poi.pos_y);
  const z = Number(poi.pos_z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z };
}

/**
 * @param {HTMLElement} container
 */
/**
 * @param {HTMLElement} container
 * @param {{ requireLogin?: boolean }} [opts] requireLogin:false skips the
 *   project login entirely — the standalone wayfinding app has no dashboard
 *   session to inherit, so it goes straight to the project picker instead.
 */
/** Project opened on a cold standalone load. */
const DEFAULT_PROJECT = 'VITM';

export function initWayfindingPage(container, opts = {}) {
  const requireLogin = opts.requireLogin !== false;
  /** Wayfinding is light-only: a dark UI over a lit photographic space reads
   * as a rendering fault, and the trail colours are tuned for light chrome. */
  const forceLight = opts.forceLight === true;
  if (forceLight) {
    // Set before initTheme so no dark frame is ever painted.
    document.documentElement.setAttribute('data-theme', 'light');
    document.documentElement.style.colorScheme = 'light';
  } else {
    initTheme();
  }
  container.innerHTML = '';

  const page = document.createElement('div');
  page.className = 'wf-page';
  page.innerHTML = `
    <div class="wf-localize" id="wf-localize">
      <video class="wf-localize-video" id="wf-localize-video" playsinline muted autoplay></video>
      <div class="wf-localize-scrim"></div>
      <div class="wf-localize-body">
        <div class="wf-localize-reticle" aria-hidden="true"></div>
        <h1 class="wf-localize-title">Find where you are</h1>
        <p class="wf-localize-copy" id="wf-localize-status">
          Point your camera at the space around you and move slowly.
        </p>
        <button type="button" class="wf-localize-start" id="wf-localize-start" hidden>Start camera</button>
        <button type="button" class="wf-localize-skip" id="wf-localize-skip">
          Skip — pick a start instead
        </button>
      </div>
    </div>

    <header class="wf-bar">
      <a href="/" class="wf-back" aria-label="Back">
        <span class="wf-back-chevron" aria-hidden="true">‹</span>
        <img src="/NavMe_wb.png" alt="${BRAND_NAME}" class="wf-bar-logo" />
      </a>

      <div class="wf-bar-distance hidden" id="wf-distance">
        <span class="wf-distance-value" id="wf-distance-value">—</span>
        <span class="wf-distance-label">to go</span>
      </div>
    </header>

    <main class="wf-main hidden" id="wf-main">
      <div class="wf-stage">
        <div class="wf-space" id="wf-space"></div>
        <div class="wf-space-empty" id="wf-space-empty">
          <p>No 3D space is linked to this project.</p>
          <p class="wf-hint">Add a Matterport link in Media, then reload this page.</p>
        </div>

        <p class="wf-status" id="wf-status">Loading project…</p>

        <!-- Tapping a field opens the search panel; picking a destination routes
             immediately, so there is no separate Navigate step. -->
        <div class="wf-dock is-loading">
          <div class="wf-picker-slot">
            <button type="button" class="wf-picker" id="wf-pick-from" data-role="from">
              <span class="wf-picker-label">Start</span>
              <span class="wf-picker-value" id="wf-from-value">Choose start</span>
            </button>
            <button type="button" class="wf-picker-x" id="wf-clear-from"
                    title="Clear start" aria-label="Clear start" hidden>×</button>
          </div>

          <div class="wf-picker-slot">
            <button type="button" class="wf-picker" id="wf-pick-to" data-role="to">
              <span class="wf-picker-label">Destination</span>
              <span class="wf-picker-value" id="wf-to-value">Choose destination</span>
            </button>
            <button type="button" class="wf-picker-x" id="wf-clear-to"
                    title="Clear destination" aria-label="Clear destination" hidden>×</button>
          </div>

          <button type="button" class="wf-icon-btn wf-icon-btn--clear" id="wf-clear" title="Clear route" aria-label="Clear route">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <!-- Destination search, modelled on the AR experience's panel. -->
        <div class="wf-search-overlay" id="wf-search-overlay" hidden>
          <div class="wf-search-panel" role="dialog" aria-modal="true" aria-labelledby="wf-search-title">
            <div class="wf-search-header">
              <div class="wf-search-header-top">
                <h2 class="wf-search-title" id="wf-search-title">Choose destination</h2>
                <button type="button" class="wf-search-close" id="wf-search-close" aria-label="Close">
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
                  </svg>
                </button>
              </div>
              <input type="text" class="wf-search-input" id="wf-search-input"
                     placeholder="Search destinations…" autocomplete="off"
                     autocapitalize="none" spellcheck="false" inputmode="search" />
              <div class="wf-search-pills" id="wf-search-pills" role="tablist" aria-label="Categories"></div>
            </div>
            <ul class="wf-search-results" id="wf-search-results" role="listbox"></ul>
          </div>
        </div>
      </div>
    </main>

    <div class="wf-arrived hidden" id="wf-arrived" role="alertdialog" aria-modal="false"
         aria-labelledby="wf-arrived-title">
      <div class="wf-arrived-card">
        <span class="wf-arrived-tick" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 6 9 17l-5-5"/>
          </svg>
        </span>
        <strong class="wf-arrived-title" id="wf-arrived-title">Destination reached</strong>
        <span class="wf-arrived-name" id="wf-arrived-name"></span>
        <p class="wf-arrived-ask" id="wf-arrived-ask">How was this route?</p>
        <div class="wf-arrived-feedback" id="wf-arrived-feedback" role="group" aria-label="Route feedback">
          <button type="button" class="wf-thumb wf-thumb--up" id="wf-thumb-up"
                  data-rating="up" aria-label="Thumbs up" title="Helpful">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M7 10v12"/>
              <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>
            </svg>
          </button>
          <button type="button" class="wf-thumb wf-thumb--down" id="wf-thumb-down"
                  data-rating="down" aria-label="Thumbs down" title="Not helpful">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M17 14V2"/>
              <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/>
            </svg>
          </button>
        </div>
        <p class="wf-arrived-thanks hidden" id="wf-arrived-thanks">Thanks for your feedback.</p>
        <button type="button" class="btn-save wf-arrived-done" id="wf-arrived-done">Done</button>
      </div>
    </div>

    <div class="wf-stairs hidden" id="wf-stairs" aria-label="Edit stairs">
      <div class="wf-stairs-head">
        <strong>Edit stairs</strong>
        <button type="button" class="wf-stairs-close" id="wf-stairs-close" aria-label="Close">×</button>
      </div>
      <p class="wf-stairs-hint">
        Walk to each scan point of the flight in order, lowest step first, and
        press <em>Add current point</em>.
      </p>
      <div class="wf-stairs-row">
        <input type="text" id="wf-stairs-name" class="wf-stairs-name" placeholder="e.g. Ground → Floor 1" />
      </div>
      <div class="wf-stairs-row">
        <select id="wf-stairs-from" class="map-display-select"></select>
        <span>→</span>
        <select id="wf-stairs-to" class="map-display-select"></select>
      </div>
      <div class="wf-stairs-points" id="wf-stairs-points"></div>
      <div class="wf-stairs-actions">
        <button type="button" class="btn-secondary" id="wf-stairs-add">Add current point</button>
        <button type="button" class="btn-secondary" id="wf-stairs-undo">Undo</button>
        <button type="button" class="btn-save" id="wf-stairs-save">Save flight</button>
      </div>
      <ul class="wf-stairs-list" id="wf-stairs-list"></ul>
    </div>

  `;
  container.appendChild(page);


  const mainEl = page.querySelector('#wf-main');
  const modeSel = page.querySelector('#wf-mode');
  const statusEl = page.querySelector('#wf-status');
  const navmeshStateEl = page.querySelector('#wf-navmesh-state');
  const distanceEl = page.querySelector('#wf-distance');
  const distanceValueEl = page.querySelector('#wf-distance-value');
  const spaceEl = page.querySelector('#wf-space');
  const spaceEmptyEl = page.querySelector('#wf-space-empty');
  const fromValueEl = page.querySelector('#wf-from-value');
  const toValueEl = page.querySelector('#wf-to-value');
  const clearFromBtn = page.querySelector('#wf-clear-from');
  const clearToBtn = page.querySelector('#wf-clear-to');
  const searchOverlay = page.querySelector('#wf-search-overlay');
  const searchInput = page.querySelector('#wf-search-input');
  const searchResults = page.querySelector('#wf-search-results');
  const searchTitle = page.querySelector('#wf-search-title');
  const searchPills = page.querySelector('#wf-search-pills');
  /** Active category filter; null means All. */
  let activeCategoryId = null;
  /** Height of the walkthrough camera above the floor plane, in metres. */
  const CAMERA_ABOVE_FLOOR_M = 1.3;
  /** Floor nearest the camera when the panel opened — resolved from slice_y. */
  let currentFloorId = null;

  /** Chosen POI indices; -1 until picked. */
  let fromIdx = -1;
  let toIdx = -1;
  /** Which field the open search panel is filling. */
  let pickingRole = null;

  let busy = false;
  let navmeshReady = false;
  /** Scan points the current route runs through, for off-route detection. */
  let routeSweepIds = new Set();
  /** Drawn polyline, used for off-route detection when there are no sweep ids. */
  let routeWorldPoints = [];
  /**
   * A cross-floor route is shown one leg at a time — walk to the stairs, climb
   * them, walk to the destination — because drawing all of it at once puts the
   * far-floor half in the air behind a ceiling, competing with the part you are
   * actually walking.
   */
  let routeLegs = [];
  let activeLeg = 0;
  /** Unsubscribe for the arrival listener that turns the view. */
  let stopSweepWatch = null;
  let routeSource = 'sweeps';
  /** Scan numbers for the drawn route, parallel to routeDrawPoints. */
  let routeSweepNumbers = [];
  /** The points the numbers line up with. */
  let routeDrawPoints = [];
  let routeActive = false;
  let rerouting = false;
  let lastKnownSweepId = null;
  let offRouteTimer = null;

  function setStatus(text, tone = '') {
    // Success is already obvious from the drawn route, so the green toast is
    // suppressed. Warnings and errors still speak up — those are not obvious.
    if (tone === 'ok') {
      if (statusEl) statusEl.hidden = true;
      return;
    }
    if (!statusEl) return;
    statusEl.hidden = false;
    statusEl.textContent = text;
    statusEl.className = `wf-status${tone ? ` is-${tone}` : ''}`;
  }

  function poiName(i) {
    return poisData[i]?.poi_name ?? `POI ${i + 1}`;
  }

  function syncPickers() {
    if (fromValueEl) {
      // A localized session starts from the user, not a POI — say so, rather
      // than showing an empty picker they are not required to fill.
      const localizedStart = fromIdx < 0 && localizedPos;
      fromValueEl.textContent = fromIdx >= 0
        ? poiName(fromIdx)
        : localizedStart
          ? 'Your location'
          : 'Choose start';
      fromValueEl.classList.toggle('is-empty', fromIdx < 0 && !localizedStart);
      fromValueEl.classList.toggle('is-you', Boolean(localizedStart));
    }
    if (toValueEl) {
      toValueEl.textContent = toIdx >= 0 ? poiName(toIdx) : 'Choose destination';
      toValueEl.classList.toggle('is-empty', toIdx < 0);
    }
    // Per-field X: only when that end actually has something to clear.
    if (clearFromBtn) clearFromBtn.hidden = !(fromIdx >= 0 || localizedPos);
    if (clearToBtn) clearToBtn.hidden = toIdx < 0;
  }

  /** Kept for the boot path — POIs arrive after the page is built. */
  function fillPoiSelects() {
    syncPickers();
  }

  /** Straight-line metres from the scan point you are standing on. */
  function distanceFromHere(poi) {
    const pose = getMatterportCameraPose();
    const cam = pose?.position;
    if (!cam) return null;
    const x = Number(poi.pos_x);
    const y = Number(poi.pos_y);
    const z = Number(poi.pos_z);
    if (![x, y, z].every(Number.isFinite)) return null;
    // The camera sits at eye height on a sweep; POIs are stored at floor level.
    // Comparing like with like keeps a POI at your feet from ranking behind one
    // across the room purely because of the 1.5 m offset.
    return Math.hypot(x - cam.x, y - (cam.y - 1.5), z - cam.z);
  }

  function formatMetres(m) {
    if (!Number.isFinite(m)) return '';
    if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
    if (m >= 100) return `${Math.round(m)} m`;
    return `${m.toFixed(1)} m`;
  }

  function poiCategoryIds(poi) {
    if (Array.isArray(poi?.category_ids) && poi.category_ids.length) return poi.category_ids;
    return poi?.category_type ? [String(poi.category_type)] : [];
  }


  /**
   * Floor the camera is on, by nearest slice_y — the same rule the AR panel
   * uses. Resolved once when the panel opens, not tracked live, so the list
   * cannot reshuffle under the user's finger while they read it.
   */
  function resolveCurrentFloorId() {
    if (!floorsData.length) return null;
    const pose = getMatterportCameraPose();
    const y = Number(pose?.position?.y);
    if (!Number.isFinite(y)) return null;
    // Camera sits above the floor plane. 1.3 m is measured from this space's
    // own scan clusters (sweep medians sit 1.27-1.32 m above each floor's
    // slice_y), not assumed from a nominal tripod height.
    const floorY = y - CAMERA_ABOVE_FLOOR_M;
    let best = null;
    let bestD = Infinity;
    for (const f of floorsData) {
      const d = Math.abs(Number(f.slice_y) - floorY);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    return best?.id ?? null;
  }

  function floorNameOf(poi) {
    const id = poi?.floor_id ? String(poi.floor_id) : '';
    if (!id) return '';
    return getFloorNameById(id) || '';
  }

  /** Vertical distance from the camera's floor, for ordering other floors. */
  function floorDelta(poi) {
    const f = poi?.floor_id ? getFloorById(String(poi.floor_id)) : null;
    const pose = getMatterportCameraPose();
    const camY = Number(pose?.position?.y);
    if (!Number.isFinite(camY)) return Number.POSITIVE_INFINITY;
    const base = camY - CAMERA_ABOVE_FLOOR_M;
    if (f && Number.isFinite(Number(f.slice_y))) return Math.abs(Number(f.slice_y) - base);
    const py = Number(poi?.pos_y);
    return Number.isFinite(py) ? Math.abs(py - base) : Number.POSITIVE_INFINITY;
  }


  function renderCategoryPills() {
    if (!searchPills) return;
    // Only categories actually in use — an empty filter is worse than no pill.
    const used = new Set();
    for (const poi of poisData) for (const id of poiCategoryIds(poi)) used.add(id);

    const pills = [{ id: null, label: 'All', iconKey: 'circle-check' }];
    for (const cat of categoriesData) {
      if (!used.has(String(cat.id))) continue;
      pills.push({
        id: String(cat.id),
        label: getCategoryLabel(cat.id) || cat.name || 'Category',
        iconKey: cat.icon_key,
      });
    }

    searchPills.innerHTML = pills
      .map((p) => {
        const active = (p.id ?? null) === activeCategoryId;
        return `<button type="button" role="tab" class="wf-pill${active ? ' is-active' : ''}"
                  data-cat="${p.id ?? ''}" aria-selected="${active}">
                  <span class="wf-pill-icon" aria-hidden="true">${renderCategoryIcon(p.iconKey)}</span>
                  <span>${escapeHtml(p.label)}</span>
                </button>`;
      })
      .join('');
  }

  function renderSearchResults(query) {
    if (!searchResults) return;
    const q = String(query ?? '').trim().toLowerCase();
    const exclude = pickingRole === 'from' ? toIdx : fromIdx;

    const rows = [];
    for (let i = 0; i < poisData.length; i += 1) {
      if (i === exclude) continue; // cannot start and end at the same POI
      const poi = poisData[i];
      const name = poiName(i);
      if (q && !name.toLowerCase().includes(q)) continue;
      if (activeCategoryId && !poiCategoryIds(poi).includes(activeCategoryId)) continue;
      rows.push({
        i,
        name,
        dist: distanceFromHere(poi),
        floor: floorNameOf(poi),
        // 0 = your floor, 1 = another tagged floor, 2 = untagged.
        tier: currentFloorId
          ? String(poi.floor_id ?? '') === currentFloorId
            ? 0
            : poi.floor_id
              ? 1
              : 2
          : 0,
        delta: floorDelta(poi),
      });
    }

    // Your own floor first, then the nearest other floor, then distance within
    // it. Without the floor tier a POI two storeys up can sit above one in the
    // next room purely because the straight line is shorter — which is not what
    // "nearest" means to someone on foot.
    rows.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.tier === 1 && a.delta !== b.delta) return a.delta - b.delta;
      const aOk = Number.isFinite(a.dist);
      const bOk = Number.isFinite(b.dist);
      if (aOk && bOk) return a.dist - b.dist;
      if (aOk) return -1;
      if (bOk) return 1;
      return a.name.localeCompare(b.name);
    });

    const shown = rows.slice(0, 200); // keep long lists responsive

    if (!shown.length) {
      searchResults.innerHTML = `<li class="wf-search-empty">${
        q || activeCategoryId
          ? 'No destination matches'
          : 'No destinations on this map yet'
      }</li>`;
      return;
    }

    searchResults.innerHTML = shown
      .map(
        (r) =>
          `<li><button type="button" class="wf-search-item" data-idx="${r.i}" role="option">
             <span class="wf-search-item-label">${escapeHtml(r.name)}</span>
             ${r.floor ? `<span class="wf-search-item-floor">${escapeHtml(r.floor)}</span>` : ''}
             ${r.dist != null ? `<span class="wf-search-item-dist">${formatMetres(r.dist)}</span>` : ''}
           </button></li>`,
      )
      .join('');
  }

  function openSearch(role) {
    pickingRole = role;
    if (searchTitle) {
      searchTitle.textContent = role === 'from' ? 'Choose start' : 'Choose destination';
    }
    if (searchInput) searchInput.value = '';
    activeCategoryId = null;
    // Which floor you are on can change between opens — re-resolve each time.
    // Still needed: results are ordered your-floor-first even without a filter.
    currentFloorId = resolveCurrentFloorId();
    renderCategoryPills();
    renderSearchResults('');
    if (searchOverlay) searchOverlay.hidden = false;
    // Focus after paint so the mobile keyboard does not fight the open animation.
    setTimeout(() => searchInput?.focus(), 60);
  }

  function closeSearch() {
    if (searchOverlay) searchOverlay.hidden = true;
    pickingRole = null;
  }

  /**
   * Picking a POI is the whole interaction: as soon as both ends are known the
   * route runs. No separate Navigate button.
   */
  async function choosePoi(idx) {
    if (pickingRole === 'from') fromIdx = idx;
    else if (pickingRole === 'to') toIdx = idx;
    const role = pickingRole;
    closeSearch();
    syncPickers();

    if (role === 'from') {
      // Walk to the start, then turn to face its marker so the camera isn’t
      // left on Matterport’s leftover sweep heading.
      const a = poiPosition(poisData[fromIdx]);
      if (a && isMatterportMapActive()) {
        setStatus('Moving to the start…');
        await matterportGoToNearestSweep(a, a);
      }
    }

    if (toIdx >= 0 && (localizedPos || fromIdx >= 0)) await runNavigate();
    else setStatus(localizedPos || fromIdx >= 0 ? 'Choose a destination.' : 'Choose a start.');
  }

  /** Navmesh is only needed for navmesh mode; camera-point mode never touches it. */


  /**
   * Which declared flights a trip has to use, in order.
   *
   * Chains carry the NavMe floors they join, so the floors form a small graph
   * and the flights between two of them are just the shortest path across it.
   * Breadth-first because the fewest flights is always the right answer — a
   * route that climbs and descends again is never what someone wants.
   *
   * @param {string|null} fromFloorId
   * @param {string|null} toFloorId
   * @returns {number[][]} chains oriented in the direction of travel
   */
  function chainsBetweenFloors(fromFloorId, toFloorId) {
    if (!fromFloorId || !toFloorId || fromFloorId === toFloorId) return [];
    if (!stairChainsData.length) return [];

    // Undirected edges: a flight can be walked either way.
    const edges = new Map();
    for (const c of stairChainsData) {
      if (!c.from_floor_id || !c.to_floor_id || c.sweep_numbers.length < 2) continue;
      for (const [a, b, reversed] of [
        [c.from_floor_id, c.to_floor_id, false],
        [c.to_floor_id, c.from_floor_id, true],
      ]) {
        if (!edges.has(a)) edges.set(a, []);
        edges.get(a).push({ to: b, chain: c, reversed });
      }
    }

    const prev = new Map([[fromFloorId, null]]);
    const queue = [fromFloorId];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === toFloorId) break;
      for (const e of edges.get(cur) ?? []) {
        if (prev.has(e.to)) continue;
        prev.set(e.to, { from: cur, edge: e });
        queue.push(e.to);
      }
    }
    if (!prev.has(toFloorId)) return [];

    const out = [];
    for (let f = toFloorId; prev.get(f); f = prev.get(f).from) {
      const { chain, reversed } = prev.get(f).edge;
      const nums = chain.sweep_numbers.slice();
      out.unshift(reversed ? nums.reverse() : nums);
    }
    return out;
  }


  /**
   * The NavMe floor a world height belongs to.
   *
   * Used when the start is a localized position rather than a POI: the floor
   * decides which declared staircases a cross-floor route must walk.
   */
  function floorIdAtY(y) {
    if (!floorsData.length || !Number.isFinite(Number(y))) return null;
    let best = null;
    let bestD = Infinity;
    for (const f of floorsData) {
      const d = Math.abs(Number(f.slice_y) - Number(y));
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    return best?.id ?? null;
  }

  /** The NavMe floor a POI sits on. */
  function floorIdOf(poi) {
    return poi?.floor_id ? String(poi.floor_id) : null;
  }



  /**
   * Publish the on-screen keyboard height as --wf-kb.
   *
   * visualViewport shrinks when the keyboard opens; the difference against
   * innerHeight is the keyboard. CSS lifts the sheet by that amount, so the
   * input and first results stay visible instead of sitting behind it.
   * Resizing the page itself is avoided deliberately — that reflows the
   * Matterport iframe and causes a visible full-screen repaint.
   */
  function trackKeyboardInset() {
    const vv = window.visualViewport;
    if (!vv) return;
    let raf = 0;
    const apply = () => {
      raf = 0;
      const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      // Ignore browser-chrome jitter; only a real keyboard is this tall.
      const kb = inset > 120 ? inset : 0;
      document.documentElement.style.setProperty('--wf-kb', `${kb}px`);
    };
    const onChange = () => {
      if (raf) return;
      raf = requestAnimationFrame(apply);
    };
    vv.addEventListener('resize', onChange);
    vv.addEventListener('scroll', onChange);
    apply();
  }
  trackKeyboardInset();

  // ---- Project picker ---------------------------------------------------

  /**
   * Fill the picker with every project that has a Matterport space.
   *
   * This page runs standalone, so it cannot inherit a project from the
   * dashboard's session — it has to offer the choice itself. Picking one sets
   * the poi_type session that every Supabase read is scoped by, so POIs,
   * floors, media, navmesh and stair chains all follow the selection.
   */
  /**
   * Open the project this app is built for. The picker was removed — this is
   * a single-space app, so the project is fixed rather than chosen.
   */
  async function fillProjectPicker() {
    if (getPoiType()) return;
    setPoiSession({ poiType: DEFAULT_PROJECT });
  }


  // ---- Arrival popup ----------------------------------------------------
  const arrivedEl = page.querySelector('#wf-arrived');
  const arrivedNameEl = page.querySelector('#wf-arrived-name');
  const arrivedAskEl = page.querySelector('#wf-arrived-ask');
  const arrivedFeedbackEl = page.querySelector('#wf-arrived-feedback');
  const arrivedThanksEl = page.querySelector('#wf-arrived-thanks');
  const thumbUpBtn = page.querySelector('#wf-thumb-up');
  const thumbDownBtn = page.querySelector('#wf-thumb-down');
  /** Prevent double-submits while a rating is in flight. */
  let feedbackBusy = false;
  let feedbackSent = false;

  function resetArrivedFeedback() {
    feedbackBusy = false;
    feedbackSent = false;
    arrivedAskEl?.classList.remove('hidden');
    arrivedFeedbackEl?.classList.remove('hidden');
    arrivedThanksEl?.classList.add('hidden');
    for (const btn of [thumbUpBtn, thumbDownBtn]) {
      if (!btn) continue;
      btn.disabled = false;
      btn.classList.remove('is-selected', 'is-dimmed');
    }
  }

  /**
   * Announce arrival.
   *
   * Shown as a card rather than only a status line: the status sits in a
   * corner and is easy to walk straight past, and arriving is the one moment
   * the route has something to say. It does not block the view — the space
   * stays visible and draggable behind it.
   */
  function showArrived(name) {
    if (!arrivedEl) return;
    // Full sentence, not a bare label — the name is the useful part.
    if (arrivedNameEl) {
      arrivedNameEl.textContent = name ? `You have arrived at ${name}.` : '';
    }
    resetArrivedFeedback();
    arrivedEl.classList.remove('hidden');
    // Next frame, so the entry transition actually runs.
    requestAnimationFrame(() => arrivedEl.classList.add('is-in'));
  }

  function hideArrived() {
    if (!arrivedEl) return;
    arrivedEl.classList.remove('is-in');
    // Match the CSS transition before hiding, or it vanishes without fading.
    setTimeout(() => arrivedEl.classList.add('hidden'), 200);
  }

  async function submitArrivalFeedback(rating) {
    if (feedbackBusy || feedbackSent) return;
    feedbackBusy = true;
    const chosen = rating === 'up' ? thumbUpBtn : thumbDownBtn;
    const other = rating === 'up' ? thumbDownBtn : thumbUpBtn;
    chosen?.classList.add('is-selected');
    other?.classList.add('is-dimmed');
    if (thumbUpBtn) thumbUpBtn.disabled = true;
    if (thumbDownBtn) thumbDownBtn.disabled = true;

    const destPoi = toIdx >= 0 ? poisData[toIdx] : null;
    try {
      await insertWayfindingFeedback({
        rating,
        destinationName: destPoi?.poi_name ?? arrivedNameEl?.textContent ?? '',
        destinationId: destPoi?.id ?? null,
        fromName:
          fromIdx >= 0
            ? poiName(fromIdx)
            : localizedPos
              ? 'Your location'
              : '',
        poiType: getPoiType(),
      });
      feedbackSent = true;
      arrivedAskEl?.classList.add('hidden');
      arrivedFeedbackEl?.classList.add('hidden');
      arrivedThanksEl?.classList.remove('hidden');
      showToast(rating === 'up' ? 'Thanks — glad it helped.' : 'Thanks — we’ll improve this.', 'success');
    } catch (err) {
      console.warn('[wayfinding] feedback save failed', err);
      showToast('Could not save feedback. Please try again.', 'error');
      resetArrivedFeedback();
    } finally {
      feedbackBusy = false;
    }
  }

  page.querySelector('#wf-arrived-feedback')?.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('.wf-thumb');
    if (!btn) return;
    const rating = btn.dataset.rating === 'up' ? 'up' : 'down';
    void submitArrivalFeedback(rating);
  });

  page.querySelector('#wf-arrived-done')?.addEventListener('click', () => {
    hideArrived();
    void runClear();
  });

  // ---- Stairs editor (super admin only) --------------------------------
  const stairsEl = page.querySelector('#wf-stairs');
  const stairsNameEl = page.querySelector('#wf-stairs-name');
  const stairsFromEl = page.querySelector('#wf-stairs-from');
  const stairsToEl = page.querySelector('#wf-stairs-to');
  const stairsPointsEl = page.querySelector('#wf-stairs-points');
  const stairsListEl = page.querySelector('#wf-stairs-list');
  /** Scan numbers picked for the flight being built, in walking order. */
  let stairDraft = [];
  let editingChainId = null;

  function renderStairDraft() {
    if (!stairsPointsEl) return;
    stairsPointsEl.innerHTML = stairDraft.length
      ? stairDraft.map((n, i) => `<span class="wf-stairs-chip">${i + 1}. Scan ${n}</span>`).join('')
      : '<span class="wf-stairs-empty">No points yet — walk to the lowest step and add it.</span>';
  }

  function renderStairList() {
    if (!stairsListEl) return;
    if (!stairChainsData.length) {
      stairsListEl.innerHTML = '<li class="wf-stairs-empty">No flights saved yet.</li>';
      return;
    }
    stairsListEl.innerHTML = stairChainsData
      .map(
        (c) => `<li>
          <span class="wf-stairs-list-name">${escapeHtml(c.name)}</span>
          <span class="wf-stairs-list-pts">${c.sweep_numbers.join(' → ')}</span>
          <button type="button" class="wf-stairs-edit" data-id="${c.id}">Edit</button>
          <button type="button" class="wf-stairs-del" data-id="${c.id}">Delete</button>
        </li>`,
      )
      .join('');
  }

  function fillStairFloorSelects() {
    const opts = floorsData
      .map((f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`)
      .join('');
    if (stairsFromEl) stairsFromEl.innerHTML = `<option value="">From floor…</option>${opts}`;
    if (stairsToEl) stairsToEl.innerHTML = `<option value="">To floor…</option>${opts}`;
  }

  /** Add the scan point the camera is standing on to the draft. */
  async function addCurrentStairPoint() {
    const here = await matterportCurrentSweep();
    if (!here.ok) return setStatus(here.error || 'No scan point here.', 'error');
    const listed = await matterportListSweeps();
    if (!listed.ok) return setStatus(listed.error, 'error');
    const n = listed.sweeps.findIndex((sw) => sw.id === here.sweep.id);
    if (n < 0) return setStatus('Could not identify that scan point.', 'error');
    if (stairDraft[stairDraft.length - 1] === n) {
      return setStatus(`Scan ${n} is already the last point.`, 'warn');
    }
    stairDraft.push(n);
    renderStairDraft();
    setStatus(`Added scan ${n} (${stairDraft.length} point${stairDraft.length === 1 ? '' : 's'}).`, 'ok');
  }

  async function saveStairDraft() {
    if (stairDraft.length < 2) {
      return setStatus('A flight needs at least two scan points.', 'warn');
    }
    const name =
      String(stairsNameEl?.value ?? '').trim() ||
      `Stairs ${stairDraft[0]} → ${stairDraft[stairDraft.length - 1]}`;
    const patch = {
      name,
      from_floor_id: stairsFromEl?.value || null,
      to_floor_id: stairsToEl?.value || null,
      sweep_numbers: stairDraft.slice(),
    };
    try {
      if (editingChainId) await saveStairChain(editingChainId, patch);
      else await addStairChain(patch);
      // The router must pick the change up immediately.
      await setMatterportStairChains(getStairChains());
      stairDraft = [];
      editingChainId = null;
      if (stairsNameEl) stairsNameEl.value = '';
      renderStairDraft();
      renderStairList();
      setStatus(`Saved “${name}”.`, 'ok');
    } catch (err) {
      console.error('[wayfinding] save stairs failed', err);
      setStatus(err?.message ?? 'Could not save that flight.', 'error');
    }
  }

  stairsEl?.querySelector('#wf-stairs-add')?.addEventListener('click', () => void addCurrentStairPoint());
  stairsEl?.querySelector('#wf-stairs-undo')?.addEventListener('click', () => {
    stairDraft.pop();
    renderStairDraft();
  });
  stairsEl?.querySelector('#wf-stairs-save')?.addEventListener('click', () => void saveStairDraft());
  stairsEl?.querySelector('#wf-stairs-close')?.addEventListener('click', () => {
    stairsEl.classList.add('hidden');
  });
  stairsListEl?.addEventListener('click', async (e) => {
    const edit = e.target?.closest?.('.wf-stairs-edit');
    const del = e.target?.closest?.('.wf-stairs-del');
    if (edit) {
      const c = stairChainsData.find((x) => x.id === edit.dataset.id);
      if (!c) return;
      editingChainId = c.id;
      stairDraft = c.sweep_numbers.slice();
      if (stairsNameEl) stairsNameEl.value = c.name;
      if (stairsFromEl) stairsFromEl.value = c.from_floor_id ?? '';
      if (stairsToEl) stairsToEl.value = c.to_floor_id ?? '';
      renderStairDraft();
      return;
    }
    if (del) {
      try {
        await removeStairChain(del.dataset.id);
        await setMatterportStairChains(getStairChains());
        renderStairList();
        setStatus('Flight deleted.', 'ok');
      } catch (err) {
        setStatus(err?.message ?? 'Could not delete that flight.', 'error');
      }
    }
  });

  /**
   * Tell the router which scan points form each staircase, so a cross-floor
   * route walks every step instead of taking the graph's skip links.
   */
  async function declareStairChains() {
    try {
      await hydrateStairChainsFromSupabase();
      const chains = getStairChains();
      if (chains.length) await setMatterportStairChains(chains);
      renderStairList();
      // Editing flights is a super-admin job: it changes how everyone routes.
      if (isSuperAdminMapRole()) {
        fillStairFloorSelects();
        renderStairDraft();
        stairsEl?.classList.remove('hidden');
      }
    } catch (err) {
      console.warn('[wayfinding] could not declare stair chains', err);
    }
  }

  async function prepareNavmesh() {
    const uploaded = getActiveNavMeshMap();
    if (!uploaded) {
      navmeshReady = false;
      if (navmeshStateEl) {
        navmeshStateEl.textContent = 'No .navmesh uploaded for this project.';
        navmeshStateEl.className = 'wf-navmesh-state is-warn';
      }
      return;
    }
    if (navmeshStateEl) navmeshStateEl.textContent = 'Loading uploaded navmesh…';
    try {
      // allowGenerate:false — never silently bake a different mesh. See file header.
      const res = await ensureNavMeshAvailable({ allowGenerate: false, visualize: false });
      navmeshReady = Boolean(res?.success) && hasNavMesh();
      if (navmeshStateEl) {
        navmeshStateEl.textContent = navmeshReady
          ? `Loaded: ${uploaded.label || uploaded.media_url?.split('/').pop() || 'uploaded .navmesh'}`
          : res?.error || 'Uploaded navmesh could not be loaded.';
        navmeshStateEl.className = `wf-navmesh-state ${navmeshReady ? 'is-ok' : 'is-error'}`;
      }
    } catch (err) {
      navmeshReady = false;
      if (navmeshStateEl) {
        navmeshStateEl.textContent = err?.message ?? 'Navmesh load failed.';
        navmeshStateEl.className = 'wf-navmesh-state is-error';
      }
    }
  }

  /** Stats from the last hybrid snap, surfaced in the status line. */
  let lastSnapStats = null;

  /**
   * Predicate used to keep hybrid routes on walkable ground. Delegates to the
   * router's own navmesh query so both agree on what "on the navmesh" means.
   */
  async function buildNavmeshProbe() {
    if (!hasNavMesh()) return null;
    try {
      const { createNavmeshProbe } = await import('../ar/navigation-route.js');
      return createNavmeshProbe({ toleranceM: 1.0 });
    } catch (err) {
      console.warn('[wayfinding] navmesh probe unavailable', err);
      return null;
    }
  }

  /**
   * Re-route when you walk onto a scan point that is not on the current route.
   *
   * Polled rather than driven by a camera event: Matterport fires pose updates
   * continuously while moving, and re-routing mid-transition would rebuild the
   * trail dozens of times per move. Sampling on a timer and acting only when
   * the scan point you are standing on actually CHANGES keeps it to one
   * re-route per wrong turn.
   */

  /**
   * Turn to face the next scan point ahead on the route.
   *
   * "Ahead" is the first point on the active leg that is more than a stride
   * away from where you stand — the nearest point is usually underfoot, and
   * aiming at it would spin the view at random. Called when a route is drawn
   * and each time you arrive somewhere new, so the direction to walk is always
   * centre-screen.
   */
  const FACE_MIN_AHEAD_M = 1.2;
  async function faceNextPoint() {
    if (!routeActive) return;
    const leg = routeLegs[activeLeg];
    const pts = leg?.points ?? [];
    if (pts.length < 2) return;
    let here;
    try {
      here = await matterportCurrentSweep();
    } catch {
      return;
    }
    if (!here?.ok) return;
    const cam = here.sweep;

    // Walk forward from the closest point so we aim along the route, not back
    // down it.
    let nearestIdx = 0;
    let nearestD = Infinity;
    for (let i = 0; i < pts.length; i += 1) {
      const d = Math.hypot(pts[i].x - cam.x, pts[i].z - cam.z);
      if (d < nearestD) {
        nearestD = d;
        nearestIdx = i;
      }
    }
    let target = null;
    for (let i = nearestIdx; i < pts.length; i += 1) {
      const d = Math.hypot(pts[i].x - cam.x, pts[i].z - cam.z);
      if (d >= FACE_MIN_AHEAD_M) {
        target = pts[i];
        break;
      }
    }
    // Near the end of a leg there is nothing further ahead — aim at its end.
    if (!target) target = pts[pts.length - 1];
    // Stairs read better with pitch; flat runs stay level.
    await matterportFacePoint(target, { pitch: leg.kind === 'stairs' });
  }
  /**
   * Stop the route when the last scan point is reached.
   *
   * Measured against the end of the FINAL leg, so arriving at the top of a
   * staircase mid-route is not mistaken for arriving at the destination.
   */
  const ARRIVED_M = 3;
  async function checkArrived(sweep) {
    if (!routeActive) return false;
    // Measured against the FINAL leg's last point, whichever leg is showing.
    // Gating on the active leg looked safer but was wrong: reach the
    // destination by lift, or miss a leg advance, and arrival never fires.
    // The end of the last leg is the destination by definition, so the
    // distance test alone cannot mistake a staircase top for it.
    const leg = routeLegs[routeLegs.length - 1];
    const end = leg?.points?.[leg.points.length - 1];
    if (!end) return false;
    const d = Math.hypot(sweep.x - end.x, sweep.y - end.y, sweep.z - end.z);
    if (d > ARRIVED_M) return false;

    routeActive = false;
    stopOffRouteWatch();
    stopSweepWatch?.();
    stopSweepWatch = null;
    const toName = toIdx >= 0 ? poiName(toIdx) : 'your destination';
    setStatus(`You have arrived at ${toName}`, 'ok');
    distanceEl?.classList.add('hidden');
    showArrived(toName);
    // Leave the trail drawn: it shows where you came from, and clearing it the
    // instant you arrive reads as the route having failed.
    return true;
  }


  /**
   * Reveal the start/destination dock.
   *
   * Held back until the space has finished loading: offering a destination
   * picker over a half-drawn view invites a route request against a space that
   * cannot yet answer it, and the dock covering the loading progress made it
   * look stalled.
   */
  function revealDock() {
    page.querySelector('.wf-dock')?.classList.remove('is-loading');
  }


  // ---- Localization gate ------------------------------------------------
  const localizeEl = page.querySelector('#wf-localize');
  const localizeVideoEl = page.querySelector('#wf-localize-video');
  const localizeStatusEl = page.querySelector('#wf-localize-status');
  /** Where the user actually is, from VPS. Origin for the first route. */
  let localizedPos = null;
  let localizeStream = null;

  function setLocalizeStatus(msg) {
    if (localizeStatusEl) localizeStatusEl.textContent = msg;
  }

  function closeLocalizeGate() {
    localizeStream?.getTracks?.().forEach((t) => t.stop());
    localizeStream = null;
    if (localizeVideoEl) localizeVideoEl.srcObject = null;
    localizeEl?.classList.add('is-done');
  }

  /**
   * Localize, then stand at the matching scan point.
   *
   * The VPS pose is in the same space as the project's POIs and the Matterport
   * scan points, so the returned position can be handed straight to the
   * nearest-scan-point search — which is what puts the walkthrough where the
   * user is really standing before they pick a destination.
   */
  async function runLocalization() {
    try {
      setLocalizeStatus('Opening camera…');
      localizeStream = await openRearCamera();
      if (localizeVideoEl) {
        localizeVideoEl.srcObject = localizeStream;
        await localizeVideoEl.play().catch(() => {});
      }
      // Map code and credentials both come from the project's row, so nothing
      // MultiSet-related has to be configured at build time.
      const cfg = await fetchMultisetConfig(getPoiType() || DEFAULT_PROJECT);
      setLocalizeStatus('Scanning…');
      const pos = await localizeAgainstMap({
        ...cfg,
        video: localizeVideoEl,
        onStatus: setLocalizeStatus,
      });
      localizedPos = pos;
      setLocalizeStatus('Found you — opening the space…');

      // The space may still be loading; wait for it before moving.
      for (let i = 0; i < 60 && !isMatterportMapActive(); i += 1) {
        await new Promise((r) => setTimeout(r, 400));
      }
      const moved = await matterportGoToNearestSweep(pos);
      if (!moved.ok) console.warn('[wayfinding] could not stand at the localized point', moved.error);

      closeLocalizeGate();
      syncPickers();
      revealDock();
      setStatus('Choose a destination.');
      // Both pickers stay on screen — the start reads "Your location" and can
      // still be overridden. Only the destination is asked for, so open that
      // one for them rather than making them tap it.
      openSearch('to');
    } catch (err) {
      console.error('[wayfinding] localization failed', err);
      setLocalizeStatus(err?.message ?? 'Could not find you — try again.');
      const btn = page.querySelector('#wf-localize-start');
      if (btn) {
        btn.hidden = false;
        btn.textContent = 'Try again';
      }
    }
  }

  page.querySelector('#wf-localize-skip')?.addEventListener('click', () => {
    // No localized position, so the normal two-picker flow applies.
    closeLocalizeGate();
    syncPickers();
    revealDock();
    setStatus(poisData.length ? 'Pick a start and a destination.' : 'No POIs on this project.');
  });

  page.querySelector('#wf-localize-start')?.addEventListener('click', (e) => {
    e.currentTarget.hidden = true;
    void runLocalization();
  });

  // Start scanning without being asked. Some browsers — iOS Safari in
  // particular — refuse getUserMedia outside a user gesture; runLocalization
  // surfaces the button again if that happens, so the flow still has a way
  // forward rather than sitting on a dead screen.
  void runLocalization();

  /** Human label for a leg, e.g. "Leg 2 of 3 · Take the stairs up". */
  function legLabel(i) {
    const leg = routeLegs[i];
    if (!leg) return '';
    const of = ` (${i + 1}/${routeLegs.length})`;
    if (leg.kind === 'stairs') {
      const pts = leg.points;
      const up = pts[pts.length - 1].y > pts[0].y;
      return `${up ? 'Take the stairs up' : 'Take the stairs down'}${of}`;
    }
    if (i === 0) return `Walk to the stairs${of}`;
    if (i === routeLegs.length - 1) return `Walk to the destination${of}`;
    return `Continue walking${of}`;
  }

  /** Metres still to walk from a world position along the planned route. */
  function remainingRouteMetres(fromPos) {
    const pts = routeDrawPoints.length >= 2 ? routeDrawPoints : routeWorldPoints;
    if (!fromPos || pts.length < 2) return null;
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < pts.length; i += 1) {
      const p = pts[i];
      const d = (p.x - fromPos.x) ** 2 + (p.z - fromPos.z) ** 2;
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    let rem = 0;
    for (let i = bestI + 1; i < pts.length; i += 1) {
      const a = pts[i - 1];
      const b = pts[i];
      rem += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    }
    return rem;
  }

  function updateDistanceDisplay(metres) {
    if (!distanceEl || !distanceValueEl) return;
    if (!Number.isFinite(metres) || metres < 0) {
      distanceEl.classList.add('hidden');
      return;
    }
    distanceValueEl.textContent =
      metres >= 100 ? `${Math.round(metres)} m` : `${metres.toFixed(1)} m`;
    distanceEl.classList.remove('hidden');
  }

  /** Destination name shown on the route end tag in the 3D view. */
  function destinationLabel() {
    return toIdx >= 0 ? poiName(toIdx) : '';
  }

  /** World position of the chosen destination POI, for the floating name tag. */
  function destinationPosition() {
    return toIdx >= 0 ? poiPosition(poisData[toIdx]) : null;
  }

  /** Options shared by every route overlay draw. */
  function routeOverlayOpts(extra = {}) {
    return {
      destinationLabel: destinationLabel(),
      destinationPosition: destinationPosition(),
      ...extra,
    };
  }

  /** Draw only the leg the user is on. */
  async function drawActiveLeg() {
    const leg = routeLegs[activeLeg];
    if (!leg) return { ok: false };
    // Number the steps on a staircase, so the drawn route can be checked
    // against Matterport's own scan list. Numbering a long corridor would just
    // be clutter, so only stair legs get labels.
    const labels =
      leg.kind === 'stairs' && routeSweepNumbers.length
        ? leg.points.map((p) => {
            const i = routeDrawPoints.findIndex(
              (q) => q.x === p.x && q.y === p.y && q.z === p.z,
            );
            return i >= 0 ? routeSweepNumbers[i] : null;
          })
        : null;
    return setMatterportNavRouteOverlay(leg.points, routeOverlayOpts({
      source: routeSource,
      labels,
    }));
  }

  /**
   * Advance when the user reaches the end of the current leg.
   * Compared in 3D so arriving at the foot of the stairs does not count as
   * reaching the top of them.
   */
  const LEG_ARRIVE_M = 3;
  async function maybeAdvanceLeg(sweep) {
    if (activeLeg >= routeLegs.length - 1) return false;
    const leg = routeLegs[activeLeg];
    const end = leg?.points?.[leg.points.length - 1];
    if (!end) return false;
    const d = Math.hypot(sweep.x - end.x, sweep.y - end.y, sweep.z - end.z);
    if (d > LEG_ARRIVE_M) return false;
    activeLeg += 1;
    await drawActiveLeg();
    setStatus(legLabel(activeLeg), 'ok');
    return true;
  }

  const OFF_ROUTE_POLL_MS = 1200;
  /** How far off a navmesh polyline counts as having left the route. */
  const OFF_ROUTE_M = 3;

  function stopOffRouteWatch() {
    if (offRouteTimer) {
      clearInterval(offRouteTimer);
      offRouteTimer = null;
    }
  }

  function startOffRouteWatch() {
    stopOffRouteWatch();
    offRouteTimer = setInterval(() => {
      void checkOffRoute();
    }, OFF_ROUTE_POLL_MS);
  }

  async function checkOffRoute() {
    // Never fight an in-flight navigate, and only while a route is on screen.
    if (!routeActive || busy || rerouting) return;
    if (toIdx < 0 || !isMatterportMapActive()) return;

    let here;
    try {
      here = await matterportCurrentSweep();
    } catch {
      return;
    }
    if (!here?.ok) return;

    const id = here.sweep.id;
    // Only act on an actual change of scan point — standing still is not a turn.
    if (id === lastKnownSweepId) return;
    lastKnownSweepId = id;

    // Arrived at the destination?
    if (await checkArrived(here.sweep)) return;

    // Remaining walk distance shrinks as you move along the route.
    updateDistanceDisplay(remainingRouteMetres(here.sweep));

    // Reached the end of this leg? Show the next one instead of re-routing.
    if (await maybeAdvanceLeg(here.sweep)) {
      void faceNextPoint();
      return;
    }
    // Moved to a new scan point on the route — re-aim at what comes next.
    void faceNextPoint();

    // Still on the planned route: nothing to do.
    if (routeSweepIds.size) {
      if (routeSweepIds.has(id)) return;
    } else if (routeWorldPoints.length >= 2) {
      // Navmesh mode: no scan points to match, so ask how far the sweep you
      // just stepped onto sits from the drawn path.
      const sw = here.sweep;
      let best = Infinity;
      for (let i = 1; i < routeWorldPoints.length; i += 1) {
        const a = routeWorldPoints[i - 1];
        const b = routeWorldPoints[i];
        const abx = b.x - a.x;
        const abz = b.z - a.z;
        const len2 = abx * abx + abz * abz;
        let t = 0;
        if (len2 > 1e-9) {
          t = ((sw.x - a.x) * abx + (sw.z - a.z) * abz) / len2;
          t = Math.max(0, Math.min(1, t));
        }
        const dx = sw.x - (a.x + abx * t);
        const dz = sw.z - (a.z + abz * t);
        const d2 = dx * dx + dz * dz;
        if (d2 < best) best = d2;
      }
      if (Math.sqrt(best) <= OFF_ROUTE_M) return;
    } else {
      return; // nothing to compare against yet
    }

    rerouting = true;
    try {
      // runNavigate already pins the start to the scan point you stand on, so
      // the rebuilt route simply picks you up where you are. Silent, and with
      // no camera move, so walking off-route feels like the trail re-joining
      // you rather than the page refreshing.
      await runNavigate({ silent: true });
    } finally {
      rerouting = false;
    }
  }

  /**
   * @param {{ silent?: boolean }} [opts] silent suppresses the progress status,
   *   used by the automatic off-route rebuild so walking around does not make
   *   the status line flicker between "finding" and the result.
   */
  async function runNavigate(opts = {}) {
    if (busy) return;
    // Localized sessions have no Start POI: the start is wherever you are.
    if (!localizedPos && fromIdx < 0) return setStatus('Choose a start.', 'warn');
    if (toIdx < 0) return setStatus('Choose a destination.', 'warn');
    if (!localizedPos && fromIdx === toIdx) {
      return setStatus('Start and destination are the same POI.', 'warn');
    }
    if (!isMatterportMapActive()) return setStatus('The 3D space is still loading.', 'warn');

    const from = fromIdx;
    const to = toIdx;
    const mode = modeSel?.value === 'navmesh'
      ? 'navmesh'
      : modeSel?.value === 'sweeps'
        ? 'sweeps'
        : 'hybrid';
    if (mode === 'navmesh' && !navmeshReady) {
      return setStatus('No usable navmesh — upload one, or use camera points.', 'error');
    }

    // A Start POI, once chosen, overrides the localized position — the user
    // has said explicitly where they want to begin.
    const a = from >= 0 ? poiPosition(poisData[from]) : localizedPos;
    const b = poiPosition(poisData[to]);
    if (!a || !b) return setStatus('Those POIs have no stored position.', 'error');

    busy = true;
    hideArrived();
    const silent = opts.silent === true;
    if (!silent) setStatus('Finding a route…');

    try {
      let points = [];
      let routeIds = [];

      // Route from the scan point you are standing on, not from the POI marker.
      // Selecting a start already walks the camera there, so in the normal flow
      // this IS the start — but if you then move, the route follows your feet.
      let startSweepId = null;
      try {
        const here = await matterportCurrentSweep();
        if (here.ok) {
          startSweepId = here.sweep.id;
          // Baseline for off-route detection, so the freshly built route is
          // never immediately treated as a wrong turn.
          lastKnownSweepId = startSweepId;
        }
      } catch {
        /* no camera pose yet — fall back to the POI-nearest sweep */
      }

      // Flights required for this trip, from the NavMe floors on each chain.
      const viaChains = chainsBetweenFloors(
        // Localized: derive the floor from the position itself — there is no
        // Start POI to read it from, and without this a cross-floor route
        // would silently skip the declared staircases.
        from >= 0 ? floorIdOf(poisData[from]) : floorIdAtY(localizedPos?.y),
        floorIdOf(poisData[to]),
      );

      let usedMode = mode;
      /** True when the route was built through declared staircases. */
      let usedStairChains = false;
      lastSnapStats = null;
      if (mode === 'hybrid') {
        if (viaChains.length) {
          // Crossing floors: the declared flights are not optional, so route
          // through them rather than letting the navmesh pick a way up.
          const res = await matterportSweepPathVia(a, b, viaChains, { startSweepId });
          if (res.ok && res.points.length >= 2) {
            points = res.points;
            routeIds = res.sweepIds ?? [];
            routeSweepNumbers = res.sweepNumbers ?? [];
            usedStairChains = true;
          }
        }
        if (points.length < 2) {
          // Shape from the navmesh, vertices from the camera points: follows real
          // walkable geometry without ever landing somewhere you cannot stand.
          const { navigateBetweenPois, getNavigationPathWorldPoints } = await import(
            '../ar/navigation-controller.js'
          );
          if (!navmeshReady) {
            setStatus('Hybrid needs the uploaded navmesh — falling back to camera points.', 'warn');
          }
          let dense = [];
          if (navmeshReady) {
            const res = await navigateBetweenPois(Number(from), Number(to), { showVisual: false });
            if (res.ok) {
              dense = res.pathPoints?.length >= 2 ? res.pathPoints : getNavigationPathWorldPoints();
            }
          }
          if (dense.length >= 2) {
            const snapped = await matterportSnapPathToSweeps(dense, {
              isOnNavmesh: await buildNavmeshProbe(),
              startSweepId,
            });
            if (snapped.ok) {
              points = snapped.points;
              routeIds = snapped.sweepIds ?? [];
              routeSweepNumbers = snapped.sweepNumbers ?? [];
              lastSnapStats = snapped;
            }
          }
          // No navmesh, or nothing snapped — the sweep graph still gets you there.
          if (points.length < 2) {
            usedMode = 'sweeps';
            const res = viaChains.length
              ? await matterportSweepPathVia(a, b, viaChains, { startSweepId })
              : await matterportSweepPath(a, b, { startSweepId });
            if (!res.ok) {
              await clearMatterportNavRouteOverlay();
              return setStatus(res.error || 'No route found.', 'error');
            }
            points = res.points;
            routeIds = res.sweepIds ?? [];
            routeSweepNumbers = res.sweepNumbers ?? [];
          }
        }
      } else if (mode === 'sweeps') {
        const res = viaChains.length
          ? await matterportSweepPathVia(a, b, viaChains, { startSweepId })
          : await matterportSweepPath(a, b, { startSweepId });
        if (!res.ok) {
          await clearMatterportNavRouteOverlay();
          return setStatus(res.error || 'No camera-point route found.', 'error');
        }
        if (viaChains.length) usedStairChains = true;
        // Draw ONLY sweep positions. POI coordinates come from the AR/navmesh
        // space and do not share a vertical origin with Matterport, so splicing
        // them into the drawn path made the trail climb the building facade.
        // They are still what selects the nearest sweeps — just not drawn.
        points = res.points;
        routeIds = res.sweepIds ?? [];
        routeSweepNumbers = res.sweepNumbers ?? [];
      } else {
        const { navigateToPoi, navigateBetweenPois, getNavigationPathWorldPoints } =
          await import('../ar/navigation-controller.js');
        // navigateToPoi routes from the walkable origin — in Matterport that is
        // the Showcase camera, i.e. the scan point you are standing on. That is
        // what makes the navmesh route start at your feet like the other modes,
        // and re-start from wherever you are when it rebuilds.
        let res = await navigateToPoi(Number(to), { showVisual: false });
        if (!res.ok) {
          // No usable origin (no camera pose yet) — fall back to POI → POI.
          res = await navigateBetweenPois(Number(from), Number(to), { showVisual: false });
        }
        if (!res.ok) {
          await clearMatterportNavRouteOverlay();
          return setStatus(res.error || 'No route found on the navmesh.', 'error');
        }
        points = res.pathPoints?.length >= 2 ? res.pathPoints : getNavigationPathWorldPoints();
      }

      if (points.length < 2) return setStatus('Route produced no drawable points.', 'error');

      // Draw the sweep positions exactly as they are. In walkthrough you are
      // already standing on a sweep, so there is nothing to prepend — and an
      // extra non-sweep vertex would put a dot off the scan rings.
      const drawPoints = points;

      routeSource = mode === 'navmesh' ? 'navmesh' : 'sweeps';
      routeDrawPoints = drawPoints;
      // Break the route where it changes level, then show only the first leg.
      routeLegs = splitRouteAtLevelChanges(drawPoints);
      activeLeg = 0;
      const overlay = routeLegs.length
        ? await drawActiveLeg()
        : await setMatterportNavRouteOverlay(drawPoints, routeOverlayOpts({
            source: routeSource,
          }));
      if (!overlay?.ok) {
        return setStatus(overlay?.error || 'Could not draw the route.', 'error');
      }

      // Remember which scan points this route runs through, so stepping onto a
      // scan point that is not on it can trigger a re-route.
      routeSweepIds = new Set(routeIds);
      // Navmesh routes have no scan-point list, so off-route is measured
      // against the polyline instead. Without this the empty set made EVERY
      // move look off-route, rebuilding the path on every single step.
      routeWorldPoints = routeIds.length ? [] : points.map((q) => ({ x: q.x, y: q.y, z: q.z }));
      hideArrived();
      routeActive = true;
      startOffRouteWatch();
      // Turn the moment the walkthrough lands on a scan point, rather than up
      // to a poll interval later — the poll stays as the safety net.
      stopSweepWatch?.();
      stopSweepWatch = onMatterportSweepChange(() => {
        void (async () => {
          try {
            const here = await matterportCurrentSweep();
            if (here?.ok && routeActive) {
              updateDistanceDisplay(remainingRouteMetres(here.sweep));
            }
          } catch {
            /* ignore pose read failures mid-walk */
          }
          void faceNextPoint();
        })();
      });
      // Point the view down the route. Must follow routeActive — faceNextPoint
      // bails when no route is live, which is why calling it at draw time
      // silently did nothing.
      void faceNextPoint();

      const metres = polylineLength(points);
      updateDistanceDisplay(metres);

      const fromName = poisData[Number(from)]?.poi_name ?? 'start';
      const toName = poisData[Number(to)]?.poi_name ?? 'destination';
      // Report the navmesh check: how many scan points on the chosen route are
      // off the navmesh (0 is the goal), not just the space-wide count.
      const check =
        usedMode === 'hybrid' && lastSnapStats?.totalSweeps
          ? lastSnapStats.offNavmeshOnRoute
            ? ` · ${lastSnapStats.offNavmeshOnRoute} off-navmesh point${
                lastSnapStats.offNavmeshOnRoute === 1 ? '' : 's'
              }`
            : ' · all points on navmesh'
          : '';
      const modeLabel =
        usedMode === 'hybrid'
          ? `hybrid · navmesh via camera points${check}`
          : usedMode === 'sweeps'
            ? mode === 'hybrid'
              ? 'camera points (navmesh unavailable)'
              : 'camera points'
            : 'navmesh';
      const routeLabel = usedStairChains
        ? `via ${viaChains.length} ${viaChains.length === 1 ? 'staircase' : 'staircases'}`
        : modeLabel;
      setStatus(
        routeLegs.length > 1
          ? `${fromName} → ${toName} · ${legLabel(0)}`
          : `${fromName} → ${toName} · ${routeLabel}`,
        'ok',
      );
    } catch (err) {
      console.error('[wayfinding] navigate failed', err);
      setStatus(err?.message ?? 'Navigation failed.', 'error');
      showToast(err?.message ?? 'Navigation failed', 'error');
    } finally {
      busy = false;
    }
  }

  async function runClear() {
    // Stop watching first: a poll landing mid-clear would rebuild the route we
    // are in the middle of tearing down.
    routeActive = false;
    hideArrived();
    stopOffRouteWatch();
    stopSweepWatch?.();
    stopSweepWatch = null;
    routeSweepIds = new Set();
    routeWorldPoints = [];
    routeLegs = [];
    activeLeg = 0;
    routeSweepNumbers = [];
    routeDrawPoints = [];
    lastKnownSweepId = null;
    await clearMatterportNavRouteOverlay();
    distanceEl?.classList.add('hidden');
    setStatus('Route cleared.');
  }

  // A route watcher outliving the page would keep polling the SDK forever.
  const stopAllWatches = () => {
    stopOffRouteWatch();
    stopSweepWatch?.();
    stopSweepWatch = null;
  };
  window.addEventListener('beforeunload', stopAllWatches);
  window.addEventListener('pagehide', stopAllWatches);

  /** Load POIs, media, the Matterport space and the navmesh for this project. */
  async function boot() {
    setStatus('Loading project…');
    try {
      // Must run first: every read below is scoped by the selected project.
      await fillProjectPicker();

      // The Matterport iframe is by far the slowest part of a cold load, and
      // it only needs the space URL. Fetch media first, start the space
      // downloading, and hydrate everything else while it does — rather than
      // making the user wait for POIs, categories and floors before the 3D
      // view has even begun.
      await hydrateMediaFromSupabase();
      const url = getActiveMatterportUrl();
      if (!url) {
        spaceEl?.classList.add('hidden');
        spaceEmptyEl?.classList.add('is-visible');
        setStatus('No 3D space linked to this project.', 'error');
        return;
      }

      ensureMatterportHost(spaceEl);
      const spaceLoading = loadMatterportMap(url, {
        // Strip the Showcase control bar — this page is walkthrough-only.
        minimalChrome: true,
        onStatus: (msg, kind) => setStatus(msg, kind === 'error' ? 'error' : ''),
      });

      // The chat answers from POI data, not from the space, so it opens as
      // soon as the POIs land rather than waiting on the Matterport iframe —
      // by far the slowest part of a cold load.
      const dataLoading = Promise.all([
        hydratePoisFromSupabase(),
        hydrateCategoriesFromSupabase().catch(() => []),
        // Floors are optional — a project without them just loses the filter.
        hydrateFloorsFromSupabase().catch(() => []),
      ]);

      void dataLoading.then(() => chat.element.classList.add('is-ready'));

      const [loaded] = await Promise.all([spaceLoading, dataLoading]);
      fillPoiSelects();

      if (!loaded.ok) {
        setStatus(loaded.error || 'Could not load the 3D space.', 'error');
        return;
      }

      // Lock to walkthrough: dollhouse/floorplan are hidden, and any route
      // drawing must not leave the viewer in an overhead mode.
      try {
        await matterportSetViewMode('inside');
      } catch {
        /* already inside, or the SDK rejected it — not worth failing over */
      }

      // Usable now: the pickers work, and a route cannot be requested faster
      // than a person can choose two POIs.
      setStatus(poisData.length ? 'Pick a start and a destination.' : 'No POIs on this project.');
      revealDock();

      // Stair chains and the navmesh are only needed once Navigate is pressed,
      // so they finish in the background instead of holding up the first paint.
      void (async () => {
        try {
          await declareStairChains();
          await prepareNavmesh();
        } catch (err) {
          console.warn('[wayfinding] background setup failed', err);
        }
      })();
    } catch (err) {
      console.error('[wayfinding] boot failed', err);
      setStatus(err?.message ?? 'Could not load this project.', 'error');
    }
  }

  page.querySelector('#wf-pick-from')?.addEventListener('click', (e) => {
    e.preventDefault();
    openSearch('from');
  });
  page.querySelector('#wf-pick-to')?.addEventListener('click', (e) => {
    e.preventDefault();
    openSearch('to');
  });

  searchInput?.addEventListener('input', () => renderSearchResults(searchInput.value));
  searchPills?.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('.wf-pill');
    if (!btn) return;
    activeCategoryId = btn.dataset.cat || null;
    renderCategoryPills();
    renderSearchResults(searchInput?.value ?? '');
  });
  searchResults?.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('.wf-search-item');
    if (!btn) return;
    const idx = Number(btn.dataset.idx);
    if (Number.isInteger(idx)) void choosePoi(idx);
  });
  page.querySelector('#wf-search-close')?.addEventListener('click', (e) => {
    e.preventDefault();
    closeSearch();
  });
  searchOverlay?.addEventListener('click', (e) => {
    if (e.target === searchOverlay) closeSearch();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchOverlay && !searchOverlay.hidden) closeSearch();
  });

  modeSel?.addEventListener('change', () => {
    // Re-run with the new mode when a route is already set up. A localized
    // session has no Start POI, so a destination alone is enough.
    if (toIdx >= 0 && (localizedPos || fromIdx >= 0)) void runNavigate();
  });


  page.querySelector('#wf-clear')?.addEventListener('click', (e) => {
    e.preventDefault();
    fromIdx = -1;
    toIdx = -1;
    localizedPos = null;
    syncPickers();
    void runClear();
  });

  /** Clear only the start field (and the active route, which depends on it). */
  clearFromBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    fromIdx = -1;
    localizedPos = null;
    syncPickers();
    void (async () => {
      await runClear();
      setStatus(toIdx >= 0 ? 'Choose a start.' : 'Pick a start and a destination.');
    })();
  });

  /** Clear only the destination (and the drawn route to it). */
  clearToBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toIdx = -1;
    syncPickers();
    void (async () => {
      await runClear();
      setStatus(localizedPos || fromIdx >= 0 ? 'Choose a destination.' : 'Pick a start and a destination.');
    })();
  });

  /**
   * Chat picks a destination and routes from wherever you are standing.
   * An explicit Start POI still wins if the user chose one; otherwise the
   * current scan point becomes the start — no “pick a start” prompt.
   */
  async function ensureStartFromHere() {
    if (fromIdx >= 0) return true;
    try {
      const here = await matterportCurrentSweep();
      if (here?.ok && here.sweep) {
        localizedPos = {
          x: Number(here.sweep.x),
          y: Number(here.sweep.y),
          z: Number(here.sweep.z),
        };
        syncPickers();
        return [localizedPos.x, localizedPos.y, localizedPos.z].every(Number.isFinite);
      }
    } catch {
      /* fall through to camera pose */
    }
    const pose = getMatterportCameraPose()?.position;
    if (pose && [pose.x, pose.y, pose.z].every(Number.isFinite)) {
      localizedPos = { x: pose.x, y: pose.y, z: pose.z };
      syncPickers();
      return true;
    }
    return Boolean(localizedPos);
  }

  async function navigateFromChat(idx) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= poisData.length) return;
    toIdx = idx;
    syncPickers();
    const ready = await ensureStartFromHere();
    if (!ready) {
      setStatus('Could not read where you are standing yet. Move in the space, then ask again.', 'warn');
      return;
    }
    await runNavigate();
  }

  const stageEl = page.querySelector('.wf-stage');
  const chat = initWayfindingChat(stageEl, {
    getContext: () => {
      const floorId = resolveCurrentFloorId();
      return {
        pois: poisData,
        // Guarded: getCategoryLabel answers "Uncategorized" for an id it does
        // not know, and a stale link would then tag the place with a category
        // word that is not really there.
        categoryLabel: (id) => (getCategoryById(id) ? getCategoryLabel(id) : ''),
        categoryIcon: (id) => getCategoryById(id)?.icon_key ?? '',
        distanceOf: (poi) => distanceFromHere(poi),
        floorNameOf: (poi) => floorNameOf(poi),
        sameFloor: (poi) => {
          if (!floorId) return true;
          return String(poi?.floor_id ?? '') === String(floorId);
        },
      };
    },
    onNavigate: (idx) => navigateFromChat(idx),
    onClear: async () => {
      fromIdx = -1;
      toIdx = -1;
      syncPickers();
      await runClear();
    },
  });

  const formUI = renderForm(container, async (creds) => {
    setPoiSession({
      poiType: creds.poiType,
      mapCode: creds.mapCode,
      organizationId: creds.organizationId,
    });
    formUI.hide();
    mainEl.classList.remove('hidden');
    await boot();
  });

  // Standalone: no login, no saved session — open straight into the picker,
  // which selects a project and sets the poi_type every read is scoped by.
  if (!requireLogin) {
    formUI.hide();
    mainEl.classList.remove('hidden');
    void boot();
  }

  // Restore a saved project session on refresh — same flow as the other pages.
  (async () => {
    if (!requireLogin) return;
    const saved = getProjectSession();
    if (!saved) return;
    formUI.hide();
    formUI.disable();
    try {
      const loginData = await authenticateLoginNavme(saved);
      if (!loginData) {
        clearProjectSession();
        formUI.enable();
        formUI.show();
        return;
      }
      setPoiSession({
        poiType: loginData.poiType,
        mapCode: loginData.mapCode,
        organizationId: loginData.organizationId,
      });
      formUI.hide();
      mainEl.classList.remove('hidden');
      await boot();
    } catch (err) {
      console.error(err);
      clearProjectSession();
      formUI.enable();
      formUI.show();
    }
  })();

  return { showLogin: () => formUI.show(), refresh: fillPoiSelects, poiType: () => getPoiType() };
}
