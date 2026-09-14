/**
 * 3D viewport tools — all four actions visible; each opens its nav panel + tool mode.
 */
import {
  iconFootprint,
  iconPlacePoi,
  iconPlaceFacility,
  iconPlaceMedia,
  iconPlaceBlock,
  iconClose,
  iconLock,
} from './icons.js';
import { mountMeniscusNav } from './meniscus-sidebar.js';
import { showToast } from './toast.js';

/** @typedef {'default' | 'walk' | 'add-poi' | 'add-facility' | 'add-media' | 'draw-block'} SceneToolMode */

/** @type {Record<string, 'pois' | 'facilities' | 'media' | 'blocks' | null>} */
const MODE_PANEL = {
  walk: null,
  'add-poi': 'pois',
  'add-facility': 'facilities',
  'add-media': 'media',
  'draw-block': 'blocks',
};

const TOOL_LOCK_LABELS = {
  'add-facility': 'Amenities',
  'add-media': 'Media',
  'draw-block': 'Zones',
  'draw-stairs': 'Zones',
};

/**
 * @param {HTMLElement} viewportBody
 * @param {{
 *   onModeChange?: (mode: SceneToolMode) => void,
 *   onCancel?: () => void,
 *   onToolActivate?: (mode: SceneToolMode, panelId: 'pois' | 'facilities' | 'media' | 'blocks' | null) => void,
 * }} [options]
 */
export function createSceneToolbar(viewportBody, options = {}) {
  const onModeChange = options.onModeChange;
  const onCancel = options.onCancel;
  const onToolActivate = options.onToolActivate;
  let activeMode = 'default';

  const root = document.createElement('div');
  root.className = 'scene-toolbar chrome-layer';
  root.id = 'scene-toolbar';
  root.innerHTML = `
    <div class="scene-toolbar-inner meniscus-dock float-glass" id="scene-tool-dock">
      <svg class="meniscus-skin" aria-hidden="true">
        <path class="meniscus-fill"></path>
      </svg>
      <div class="meniscus-bead" aria-hidden="true"></div>
      <div class="meniscus-tabs" role="tablist" aria-label="Scene tools">
        <button type="button" class="scene-tool-btn" data-mode="walk" title="Go to — open walkthrough / move on the map" aria-pressed="false" role="tab">
          <span class="scene-tool-icon">${iconFootprint()}</span>
          <span class="scene-tool-label">Go to</span>
        </button>
        <button type="button" class="scene-tool-btn" data-mode="add-poi" data-panel="pois" title="Add POI — click on the map" aria-pressed="false" role="tab">
          <span class="scene-tool-icon">${iconPlacePoi()}</span>
          <span class="scene-tool-label">Add POI</span>
        </button>
        <button type="button" class="scene-tool-btn" data-mode="add-facility" data-panel="facilities" title="Add amenity — click on the map" aria-pressed="false" role="tab">
          <span class="scene-tool-icon">${iconPlaceFacility()}</span>
          <span class="scene-tool-label">Add amenity</span>
          <span class="scene-tool-lock" aria-hidden="true">${iconLock()}</span>
        </button>
        <button type="button" class="scene-tool-btn" data-mode="add-media" data-panel="media" title="Add media — click on the map" aria-pressed="false" role="tab">
          <span class="scene-tool-icon">${iconPlaceMedia()}</span>
          <span class="scene-tool-label">Add media</span>
          <span class="scene-tool-lock" aria-hidden="true">${iconLock()}</span>
        </button>
        <button type="button" class="scene-tool-btn" data-mode="draw-block" data-panel="blocks" title="Draw zone — click and drag on the map" aria-pressed="false" role="tab">
          <span class="scene-tool-icon">${iconPlaceBlock()}</span>
          <span class="scene-tool-label">Add block</span>
          <span class="scene-tool-lock" aria-hidden="true">${iconLock()}</span>
        </button>
      </div>
    </div>
    <button type="button" class="scene-tool-cancel hidden" id="scene-tool-cancel" title="Exit tool" aria-label="Exit">
      ${iconClose()}
    </button>
  `;

  viewportBody.appendChild(root);

  const dock = root.querySelector('#scene-tool-dock');
  const cancelBtn = root.querySelector('#scene-tool-cancel');
  const buttons = root.querySelectorAll('.scene-tool-btn');

  const meniscus = mountMeniscusNav(dock, {
    tabSelector: '.scene-tool-btn',
    toggleable: true,
    onSelect: (id) => {
      if (!id) {
        applyMode('default');
        onCancel?.();
        return;
      }
      const btn = dock.querySelector(`.scene-tool-btn[data-mode="${id}"]`);
      if (btn?.dataset.locked === '1') {
        const label = TOOL_LOCK_LABELS[id] || 'This feature';
        showToast(`${label} is not enabled for this project`, 'info');
        meniscus.clear(true);
        return;
      }
      const mode = /** @type {SceneToolMode} */ (id);
      applyMode(mode);
      onToolActivate?.(mode, MODE_PANEL[mode] ?? null);
    },
  });

  /**
   * @param {SceneToolMode} mode
   */
  function applyMode(mode) {
    const next =
      mode === 'walk' ||
      mode === 'add-poi' ||
      mode === 'add-facility' ||
      mode === 'add-media' ||
      mode === 'draw-block'
        ? mode
        : 'default';
    activeMode = next;
    buttons.forEach((btn) => {
      const on = btn.dataset.mode === activeMode;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    cancelBtn.classList.toggle('hidden', activeMode === 'default');
    onModeChange?.(activeMode);
  }

  function setMode(mode) {
    applyMode(mode);
    if (activeMode === 'default') meniscus.clear(true);
    else meniscus.goTo(activeMode, true);
  }

  function cancel() {
    setMode('default');
    onCancel?.();
  }

  cancelBtn.addEventListener('click', cancel);

  return {
    element: root,
    setMode,
    cancel,
    getMode: () => activeMode,
    /** Hide Go-to on Matterport (Showcase walkthrough replaces mesh Go-to). */
    setGotoVisible(visible) {
      const walkBtn = root.querySelector('.scene-tool-btn[data-mode="walk"]');
      if (!walkBtn) return;
      walkBtn.hidden = !visible;
      if (!visible && activeMode === 'walk') cancel();
      requestAnimationFrame(() => meniscus.layout(false));
    },
    /**
     * Keep a tool visible but locked when the project feature flag is off.
     * @param {string} mode
     * @param {boolean} locked
     */
    setToolLocked(mode, locked) {
      const isLocked = Boolean(locked);
      root.querySelectorAll(`.scene-tool-btn[data-mode="${mode}"]`).forEach((btn) => {
        btn.hidden = false;
        btn.style.removeProperty('display');
        btn.classList.toggle('is-locked', isLocked);
        btn.dataset.locked = isLocked ? '1' : '0';
        if (isLocked) {
          btn.setAttribute('aria-disabled', 'true');
          btn.classList.remove('active');
          btn.setAttribute('aria-pressed', 'false');
          btn.setAttribute('aria-selected', 'false');
          if (activeMode === mode) {
            applyMode('default');
            meniscus.clear(true);
          }
        } else {
          btn.removeAttribute('aria-disabled');
        }
      });
      requestAnimationFrame(() => meniscus.layout(false));
    },
    layout() {
      meniscus.layout(false);
    },
  };
}
