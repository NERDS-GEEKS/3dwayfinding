/**
 * Amenities panel — list, Lucide icon picker, auto-translate on save (like POIs).
 */

import {
  facilitiesData,
  DEFAULT_FACILITY_ICON_KEY,
  addFacilityWithDb,
  deleteFacility,
  getFacilityObjects,
  removeFacilityFromDb,
  saveFacilityToDb,
  updateFacilityName,
  updateFacilityPosition,
} from '../ar/facilities.js';
import {
  flyTo,
  attachGizmo,
  detachGizmo,
  setGizmoDragCallback,
  setGizmoDragEndCallback,
} from '../ar/scene.js';
import { shouldUseMatterportCamera } from '../ar/matterport-map.js';
import {
  getCategoryIconLabel,
  getCategoryIconPickerSections,
  renderCategoryIcon,
} from '../config/category-icons.js';
import { getPoiType } from '../config/poi-session.js';
import { iconSave, iconDelete, iconAdd, iconSearch, iconFilter, iconFacilityColor } from './icons.js';
import { showToast } from './toast.js';
import { askConfirm, isConfirmDialogTarget, isConfirmDialogOpen } from './confirm-dialog.js';

export const DEFAULT_NEW_FACILITY_NAME = 'New Amenity';

let selectedIndex = -1;
let selectedIconKey = DEFAULT_FACILITY_ICON_KEY;

/**
 * @param {HTMLElement} container
 * @param {{ onFacilityListChange?: () => void }} [options]
 */
export function createFacilityPanel(container, options = {}) {
  const onFacilityListChange = options.onFacilityListChange;
  const onSelectionChange = options.onSelectionChange;

  const listPanel = document.createElement('div');
  listPanel.className = 'scene-float-panel scene-float-panel--list float-glass drawer-frost hidden';
  listPanel.id = 'facility-list-panel';

  listPanel.innerHTML = `
    <div class="poi-panel-header">
      <div class="poi-panel-header-row">
        <div class="poi-panel-title">Amenities</div>
        <button type="button" class="admin-refresh-btn category-add-btn" id="facility-add-category-btn" title="Add amenity category" aria-label="Add amenity category">
          ${iconAdd()}
        </button>
      </div>
      <div class="poi-list-toolbar" role="search">
        <div class="poi-list-search">
          <span class="poi-list-search-icon" aria-hidden="true">${iconSearch()}</span>
          <input
            type="search"
            id="facility-search"
            class="poi-list-search-input"
            placeholder="Search amenities…"
            autocomplete="off"
            spellcheck="false"
          />
          <div class="poi-list-filter">
            <button
              type="button"
              class="poi-list-filter-btn"
              id="facility-category-filter-btn"
              title="Filter by category"
              aria-label="Filter by category"
              aria-haspopup="listbox"
              aria-expanded="false"
              aria-controls="facility-category-filter-menu"
            >
              <span class="poi-list-filter-btn-icon" aria-hidden="true">${iconFilter()}</span>
              <span class="poi-list-filter-dot" id="facility-category-filter-dot" hidden></span>
            </button>
            <div
              class="poi-list-filter-menu hidden"
              id="facility-category-filter-menu"
              role="listbox"
              aria-label="Categories"
            ></div>
          </div>
        </div>
      </div>
    </div>
    <div class="poi-list" id="facility-list"></div>
  `;

  container.appendChild(listPanel);

  const editDialog = document.createElement('div');
  editDialog.className = 'poi-add-dialog poi-edit-dialog hidden';
  editDialog.id = 'facility-edit-dialog';
  editDialog.setAttribute('role', 'dialog');
  editDialog.setAttribute('aria-modal', 'true');
  editDialog.setAttribute('aria-labelledby', 'facility-edit-dialog-title');
  editDialog.innerHTML = `
    <div class="poi-add-dialog-backdrop" data-action="close-edit"></div>
    <div class="poi-add-dialog-card poi-edit-dialog-card float-glass">
      <div class="poi-add-dialog-header">
        <h3 class="poi-add-dialog-title" id="facility-edit-dialog-title">Edit amenity</h3>
        <button type="button" class="poi-add-dialog-close" data-action="close-edit" aria-label="Close">&times;</button>
      </div>
      <div class="poi-edit-dialog-body">
        <div class="poi-coords" id="facility-coords">
          <div class="coord-group poi-add-field">
            <span class="field-label">Name</span>
            <input type="text" id="facility-name" value="" />
          </div>
          <div class="coord-group poi-add-field">
            <span class="field-label">Category</span>
            <div class="facility-category-row">
              <select id="facility-category" class="map-display-select"></select>
              <button type="button" class="admin-refresh-btn" id="facility-edit-add-category-btn" title="Add category" aria-label="Add category">
                ${iconAdd()}
              </button>
            </div>
          </div>
          <div class="coord-group poi-add-field">
            <span class="field-label">Group</span>
            <input type="text" id="facility-group" value="" placeholder="e.g. restroom" />
          </div>
          <div class="coord-group poi-add-field">
            <span class="field-label">Floor</span>
            <input type="text" id="facility-floor" value="" placeholder="e.g. first floor" />
          </div>
          <div class="coord-group poi-add-field">
            <span class="field-label">Icon</span>
            <div class="icon-select" id="facility-icon-select">
              <button type="button" class="icon-select-trigger" id="facility-icon-trigger" aria-haspopup="listbox" aria-expanded="false">
                <span class="category-icon-preview" id="facility-icon-preview"></span>
                <span class="icon-select-label" id="facility-icon-label"></span>
                <span class="icon-select-caret" aria-hidden="true"></span>
              </button>
              <div class="icon-select-menu hidden" id="facility-icon-menu">
                <input
                  type="search"
                  id="facility-icon-search"
                  class="category-icon-search"
                  placeholder="Search icons…"
                  autocomplete="off"
                  spellcheck="false"
                />
                <div class="category-icon-grid" id="facility-icon-grid" role="listbox" aria-label="Amenity icon"></div>
              </div>
            </div>
          </div>
          <div class="coord-group poi-add-field">
            <span class="field-label">Position (XYZ)</span>
            <div class="coord-inputs">
              <div class="coord-group">
                <span class="field-label field-label--x">X</span>
                <input type="number" id="facility-x" value="0" step="any" inputmode="decimal" />
              </div>
              <div class="coord-group">
                <span class="field-label field-label--y">Y</span>
                <input type="number" id="facility-y" value="0" step="any" inputmode="decimal" />
              </div>
              <div class="coord-group">
                <span class="field-label field-label--z">Z</span>
                <input type="number" id="facility-z" value="0" step="any" inputmode="decimal" />
              </div>
            </div>
          </div>
          <label class="coord-group poi-add-field facility-active-toggle">
            <input type="checkbox" id="facility-active" checked />
            <span class="field-label">Active</span>
          </label>
          <p class="facility-translate-hint poi-add-field">Saving translates name, category, and group into all project languages.</p>
        </div>
      </div>
      <div class="poi-add-dialog-actions poi-edit-dialog-actions" id="facility-actions-row">
        <button type="button" class="btn-save btn-delete btn-delete-poi poi-btn-delete" id="btn-delete-facility" title="Delete amenity" aria-label="Delete amenity">
          ${iconDelete()}
        </button>
        <button type="button" class="btn-secondary" data-action="close-edit">Cancel</button>
        <button type="button" class="btn-save poi-btn-save" id="btn-save-facility">
          <span class="icon">${iconSave()}</span> Save Changes
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(editDialog);

  const addDialog = document.createElement('div');
  addDialog.className = 'poi-add-dialog hidden';
  addDialog.id = 'facility-add-dialog';
  addDialog.setAttribute('role', 'dialog');
  addDialog.setAttribute('aria-modal', 'true');
  addDialog.setAttribute('aria-labelledby', 'facility-add-dialog-title');
  addDialog.innerHTML = `
    <div class="poi-add-dialog-backdrop" data-action="close"></div>
    <div class="poi-add-dialog-card float-glass">
      <div class="poi-add-dialog-header">
        <h3 class="poi-add-dialog-title" id="facility-add-dialog-title">Add New Amenity</h3>
        <button type="button" class="poi-add-dialog-close" data-action="close" aria-label="Close">&times;</button>
      </div>
      <div class="coord-group poi-add-field">
        <span class="field-label">Name</span>
        <input type="text" id="new-facility-name" placeholder="Enter an amenity name" />
      </div>
      <div class="coord-group poi-add-field">
        <span class="field-label">Category</span>
        <div class="facility-category-row">
          <select id="new-facility-category" class="map-display-select"></select>
          <button type="button" class="admin-refresh-btn" id="new-facility-add-category-btn" title="Add category" aria-label="Add category">
            ${iconAdd()}
          </button>
        </div>
      </div>
      <div class="coord-group poi-add-field">
        <span class="field-label">Group</span>
        <input type="text" id="new-facility-group" placeholder="e.g. restroom" />
      </div>
      <div class="coord-group poi-add-field">
        <span class="field-label">Floor</span>
        <input type="text" id="new-facility-floor" placeholder="e.g. first floor" />
      </div>
      <div class="coord-group poi-add-field">
        <span class="field-label">Icon</span>
        <div class="icon-select" id="new-facility-icon-select">
          <button type="button" class="icon-select-trigger" id="new-facility-icon-trigger" aria-haspopup="listbox" aria-expanded="false">
            <span class="category-icon-preview" id="new-facility-icon-preview"></span>
            <span class="icon-select-label" id="new-facility-icon-label"></span>
            <span class="icon-select-caret" aria-hidden="true"></span>
          </button>
          <div class="icon-select-menu hidden" id="new-facility-icon-menu">
            <input
              type="search"
              id="new-facility-icon-search"
              class="category-icon-search"
              placeholder="Search icons…"
              autocomplete="off"
              spellcheck="false"
            />
            <div class="category-icon-grid" id="new-facility-icon-grid" role="listbox" aria-label="Amenity icon"></div>
          </div>
        </div>
      </div>
      <div class="coord-inputs poi-add-coords">
        <div class="coord-group">
          <span class="field-label field-label--x">X</span>
          <input type="number" id="new-facility-x" value="0" step="any" inputmode="decimal" />
        </div>
        <div class="coord-group">
          <span class="field-label field-label--y">Y</span>
          <input type="number" id="new-facility-y" value="0" step="any" inputmode="decimal" />
        </div>
        <div class="coord-group">
          <span class="field-label field-label--z">Z</span>
          <input type="number" id="new-facility-z" value="0" step="any" inputmode="decimal" />
        </div>
      </div>
      <div class="poi-add-dialog-actions">
        <button type="button" class="btn-secondary" data-action="close">Cancel</button>
        <button type="button" class="btn-save" id="btn-add-facility">
          <span class="icon">${iconAdd()}</span> Add amenity
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(addDialog);

  // Dialog to create an amenity category (stored as facility_category text + default icon).
  const categoryDialog = document.createElement('div');
  categoryDialog.className = 'poi-add-dialog hidden';
  categoryDialog.id = 'facility-category-dialog';
  categoryDialog.setAttribute('role', 'dialog');
  categoryDialog.setAttribute('aria-modal', 'true');
  categoryDialog.setAttribute('aria-labelledby', 'facility-category-dialog-title');
  categoryDialog.innerHTML = `
    <div class="poi-add-dialog-backdrop" data-action="close-cat"></div>
    <div class="poi-add-dialog-card float-glass">
      <div class="poi-add-dialog-header">
        <h3 class="poi-add-dialog-title" id="facility-category-dialog-title">Add Amenity Category</h3>
        <button type="button" class="poi-add-dialog-close" data-action="close-cat" aria-label="Close">&times;</button>
      </div>
      <div class="coord-group poi-add-field">
        <span class="field-label">Category name</span>
        <input type="text" id="new-facility-cat-name" placeholder="e.g. restroom, water, elevator" />
      </div>
      <div class="coord-group poi-add-field">
        <span class="field-label">Default icon</span>
        <div class="icon-select" id="new-facility-cat-icon-select">
          <button type="button" class="icon-select-trigger" id="new-facility-cat-icon-trigger" aria-haspopup="listbox" aria-expanded="false">
            <span class="category-icon-preview" id="new-facility-cat-icon-preview"></span>
            <span class="icon-select-label" id="new-facility-cat-icon-label"></span>
            <span class="icon-select-caret" aria-hidden="true"></span>
          </button>
          <div class="icon-select-menu hidden" id="new-facility-cat-icon-menu">
            <input
              type="search"
              id="new-facility-cat-icon-search"
              class="category-icon-search"
              placeholder="Search icons…"
              autocomplete="off"
              spellcheck="false"
            />
            <div class="category-icon-grid" id="new-facility-cat-icon-grid" role="listbox" aria-label="Category icon"></div>
          </div>
        </div>
      </div>
      <div class="poi-add-dialog-actions">
        <button type="button" class="btn-secondary" data-action="close-cat">Cancel</button>
        <button type="button" class="btn-save" id="btn-save-facility-category">
          <span class="icon">${iconAdd()}</span> Add category
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(categoryDialog);

  const listEl = listPanel.querySelector('#facility-list');
  const searchInputEl = listPanel.querySelector('#facility-search');
  const categoryFilterBtn = listPanel.querySelector('#facility-category-filter-btn');
  const categoryFilterMenu = listPanel.querySelector('#facility-category-filter-menu');
  const categoryFilterDot = listPanel.querySelector('#facility-category-filter-dot');
  const btnHeaderAddCategory = listPanel.querySelector('#facility-add-category-btn');
  const inputName = editDialog.querySelector('#facility-name');
  const inputCategory = editDialog.querySelector('#facility-category');
  const btnEditAddCategory = editDialog.querySelector('#facility-edit-add-category-btn');
  const inputGroup = editDialog.querySelector('#facility-group');
  const inputFloor = editDialog.querySelector('#facility-floor');
  const inputX = editDialog.querySelector('#facility-x');
  const inputY = editDialog.querySelector('#facility-y');
  const inputZ = editDialog.querySelector('#facility-z');
  const inputActive = editDialog.querySelector('#facility-active');
  const iconPreviewEl = editDialog.querySelector('#facility-icon-preview');
  const iconSearchInput = editDialog.querySelector('#facility-icon-search');
  const iconGridEl = editDialog.querySelector('#facility-icon-grid');
  const iconTriggerEl = editDialog.querySelector('#facility-icon-trigger');
  const iconMenuEl = editDialog.querySelector('#facility-icon-menu');
  const btnSave = editDialog.querySelector('#btn-save-facility');
  const btnDelete = editDialog.querySelector('#btn-delete-facility');
  const btnAdd = addDialog.querySelector('#btn-add-facility');
  const newName = addDialog.querySelector('#new-facility-name');
  const newCategory = addDialog.querySelector('#new-facility-category');
  const btnNewAddCategory = addDialog.querySelector('#new-facility-add-category-btn');
  const newGroup = addDialog.querySelector('#new-facility-group');
  const newFloor = addDialog.querySelector('#new-facility-floor');
  const newX = addDialog.querySelector('#new-facility-x');
  const newY = addDialog.querySelector('#new-facility-y');
  const newZ = addDialog.querySelector('#new-facility-z');
  const newIconPreviewEl = addDialog.querySelector('#new-facility-icon-preview');
  const newIconSearchInput = addDialog.querySelector('#new-facility-icon-search');
  const newIconGridEl = addDialog.querySelector('#new-facility-icon-grid');
  const newIconTriggerEl = addDialog.querySelector('#new-facility-icon-trigger');
  const newIconMenuEl = addDialog.querySelector('#new-facility-icon-menu');
  const catNameInput = categoryDialog.querySelector('#new-facility-cat-name');
  const catIconPreviewEl = categoryDialog.querySelector('#new-facility-cat-icon-preview');
  const catIconSearchInput = categoryDialog.querySelector('#new-facility-cat-icon-search');
  const catIconGridEl = categoryDialog.querySelector('#new-facility-cat-icon-grid');
  const catIconTriggerEl = categoryDialog.querySelector('#new-facility-cat-icon-trigger');
  const catIconMenuEl = categoryDialog.querySelector('#new-facility-cat-icon-menu');
  const btnSaveCategory = categoryDialog.querySelector('#btn-save-facility-category');

  let addDialogIconKey = DEFAULT_FACILITY_ICON_KEY;
  let categoryDialogIconKey = DEFAULT_FACILITY_ICON_KEY;
  /** Where to apply a newly created category: 'edit' | 'add' | 'filter' */
  let categoryDialogTarget = 'edit';
  let filterCategory = '';
  let filterSearchQuery = '';

  /** @type {Map<string, { name: string, icon_key: string }>} */
  const facilityCategoryCatalog = new Map();

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Pin+gear for default facility keys; otherwise Lucide catalog. */
  function facilityIconHtml(key) {
    const k = String(key || DEFAULT_FACILITY_ICON_KEY).trim().toLowerCase();
    if (!k || k === 'map-pin' || k === 'building-2' || k === 'facility' || k === 'facility-pin-gear') {
      return iconFacilityColor();
    }
    return renderCategoryIcon(k);
  }

  function syncCatalogFromFacilities() {
    facilitiesData.forEach((f) => {
      const name = String(f.facility_category || '').trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (!facilityCategoryCatalog.has(key)) {
        facilityCategoryCatalog.set(key, {
          name,
          icon_key: f.icon_key || DEFAULT_FACILITY_ICON_KEY,
        });
      }
    });
  }

  function getCategoryList() {
    syncCatalogFromFacilities();
    return [...facilityCategoryCatalog.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function upsertCategory(name, iconKey) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) return null;
    const key = trimmed.toLowerCase();
    const entry = {
      name: trimmed,
      icon_key: iconKey || DEFAULT_FACILITY_ICON_KEY,
    };
    facilityCategoryCatalog.set(key, entry);
    return entry;
  }

  function buildCategorySelectOptions(selected = '', { includeBlank = true } = {}) {
    const cats = getCategoryList();
    const parts = [];
    if (includeBlank) {
      parts.push(`<option value="">Select category…</option>`);
    }
    for (const c of cats) {
      const sel = c.name === selected ? ' selected' : '';
      parts.push(`<option value="${escapeHtml(c.name)}"${sel}>${escapeHtml(c.name)}</option>`);
    }
    return parts.join('');
  }

  function refreshCategorySelects(selectedEdit = '', selectedAdd = '') {
    const editSel =
      selectedEdit ||
      (selectedIndex >= 0 ? String(facilitiesData[selectedIndex]?.facility_category ?? '') : '');
    if (inputCategory) {
      inputCategory.innerHTML = buildCategorySelectOptions(editSel);
    }
    if (newCategory) {
      newCategory.innerHTML = buildCategorySelectOptions(selectedAdd || newCategory.value || '');
    }
    refreshCategoryFilterMenu();
  }

  function syncCategoryFilterBtn() {
    const active = Boolean(filterCategory);
    categoryFilterBtn?.classList.toggle('is-filtered', active);
    categoryFilterBtn?.setAttribute(
      'title',
      active ? `Filtered: ${filterCategory}` : 'Filter by category',
    );
    if (categoryFilterDot) categoryFilterDot.hidden = !active;
  }

  function refreshCategoryFilterMenu() {
    if (!categoryFilterMenu) return;
    const current = filterCategory;
    const items = [
      { id: '', label: 'All categories', iconHtml: iconFilter(), active: !current },
      ...getCategoryList().map((c) => ({
        id: c.name,
        label: c.name,
        iconHtml: renderCategoryIcon(c.icon_key),
        active: c.name === current,
      })),
    ];
    categoryFilterMenu.innerHTML = items
      .map(
        (item) => `
        <button
          type="button"
          class="poi-list-filter-option${item.active ? ' is-active' : ''}"
          role="option"
          data-category="${escapeHtml(item.id)}"
          aria-selected="${item.active ? 'true' : 'false'}"
        >
          <span class="poi-list-filter-option-icon" aria-hidden="true">${item.iconHtml}</span>
          <span class="poi-list-filter-option-label">${escapeHtml(item.label)}</span>
          ${item.active ? '<span class="poi-list-filter-check" aria-hidden="true">✓</span>' : ''}
        </button>`,
      )
      .join('');
    categoryFilterMenu.querySelectorAll('[data-category]').forEach((btn) => {
      btn.addEventListener('click', () => {
        filterCategory = btn.getAttribute('data-category') || '';
        closeCategoryFilterMenu();
        syncCategoryFilterBtn();
        rebuildList();
      });
    });
    syncCategoryFilterBtn();
  }

  function openCategoryFilterMenu() {
    if (!categoryFilterMenu) return;
    refreshCategoryFilterMenu();
    categoryFilterMenu.classList.remove('hidden');
    categoryFilterBtn?.setAttribute('aria-expanded', 'true');
    categoryFilterBtn?.classList.add('is-open');
  }

  function closeCategoryFilterMenu() {
    if (!categoryFilterMenu) return;
    categoryFilterMenu.classList.add('hidden');
    categoryFilterBtn?.setAttribute('aria-expanded', 'false');
    categoryFilterBtn?.classList.remove('is-open');
  }

  function toggleCategoryFilterMenu() {
    if (categoryFilterMenu?.classList.contains('hidden')) openCategoryFilterMenu();
    else closeCategoryFilterMenu();
  }

  function applyCategoryDefaults(catName, { forAddDialog = false } = {}) {
    const entry = facilityCategoryCatalog.get(String(catName || '').trim().toLowerCase());
    if (!entry) return;
    if (forAddDialog) {
      addDialogIconKey = entry.icon_key;
      updateIconPreview(newIconPreviewEl, addDialogIconKey);
      openAddDialogIconGrid();
      if (newGroup && !newGroup.value.trim()) newGroup.value = entry.name;
    } else {
      selectedIconKey = entry.icon_key;
      updateIconPreview(iconPreviewEl, selectedIconKey);
      bindEditIconGrid();
      if (inputGroup && !inputGroup.value.trim()) inputGroup.value = entry.name;
    }
  }

  function renderIconOption(opt, activeKey) {
    const active = opt.key === activeKey ? ' active' : '';
    return `<button type="button" class="category-icon-option${active}" data-icon-key="${opt.key}" title="${escapeHtml(opt.label)}" aria-label="${escapeHtml(opt.label)}">${renderCategoryIcon(opt.key)}</button>`;
  }

  function renderIconGrid({ gridEl, searchInput, activeKey, onSelect }) {
    if (!gridEl) return;
    const query = searchInput?.value ?? '';
    const sections = getCategoryIconPickerSections(query);
    gridEl.innerHTML = sections
      .map((section) => {
        const groupLabel = section.icons.length
          ? `<div class="category-icon-group-label">${escapeHtml(section.label)}</div>`
          : `<div class="category-icon-group-label category-icon-group-label--empty">${escapeHtml(section.label)}</div>`;
        const options = section.icons.map((opt) => renderIconOption(opt, activeKey)).join('');
        return `<div class="category-icon-group" data-group-id="${section.id}">${groupLabel}<div class="category-icon-group-grid">${options}</div></div>`;
      })
      .join('');
    gridEl.querySelectorAll('.category-icon-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        onSelect(btn.dataset.iconKey || DEFAULT_FACILITY_ICON_KEY);
      });
    });
  }

  function closeAllIconMenus() {
    [iconMenuEl, newIconMenuEl, catIconMenuEl].forEach((menu) => {
      if (!menu) return;
      menu.classList.add('hidden');
      const trigger = menu.closest('.icon-select')?.querySelector('.icon-select-trigger');
      trigger?.setAttribute('aria-expanded', 'false');
      menu.closest('.icon-select')?.classList.remove('is-open');
    });
  }

  /**
   * @param {HTMLElement | null} trigger
   * @param {HTMLElement | null} menu
   * @param {boolean} open
   * @param {() => void} [onOpen]
   */
  function setIconMenuOpen(trigger, menu, open, onOpen) {
    if (!trigger || !menu) return;
    if (open) closeAllIconMenus();
    menu.classList.toggle('hidden', !open);
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    trigger.closest('.icon-select')?.classList.toggle('is-open', open);
    if (open) {
      onOpen?.();
      requestAnimationFrame(() => menu.querySelector('.category-icon-search')?.focus());
    }
  }

  function bindIconSelect(trigger, menu, onOpen) {
    trigger?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const next = menu?.classList.contains('hidden');
      setIconMenuOpen(trigger, menu, Boolean(next), onOpen);
    });
  }

  function updateIconPreview(previewEl, key) {
    if (previewEl) previewEl.innerHTML = facilityIconHtml(key);
    const labelEl = previewEl?.closest('.icon-select')?.querySelector('.icon-select-label');
    if (labelEl) labelEl.textContent = getCategoryIconLabel(key);
  }

  function facilityMatchesFilter(facility) {
    if (filterCategory && String(facility.facility_category || '').trim() !== filterCategory) {
      return false;
    }
    const q = filterSearchQuery.trim().toLowerCase();
    if (!q) return true;
    const name = String(facility.facility_name || '').toLowerCase();
    const cat = String(facility.facility_category || '').toLowerCase();
    const group = String(facility.facility_group || '').toLowerCase();
    const floor = String(facility.floor_name || '').toLowerCase();
    return name.includes(q) || cat.includes(q) || group.includes(q) || floor.includes(q);
  }

  function rebuildList() {
    listEl.innerHTML = '';
    refreshCategorySelects();

    const visible = facilitiesData
      .map((facility, index) => ({ facility, index }))
      .filter(({ facility }) => facilityMatchesFilter(facility));

    if (!facilitiesData.length) {
      const poi = getPoiType() || 'this project';
      listEl.innerHTML = `<div class="category-empty">No amenities for <strong>${escapeHtml(poi)}</strong> yet. Use Add amenity on the map toolbar, or + to add a category first.</div>`;
      return;
    }

    if (!visible.length) {
      const emptyMsg =
        filterSearchQuery.trim() || filterCategory
          ? 'No amenities match this search.'
          : 'No amenities yet.';
      listEl.innerHTML = `<div class="category-empty">${emptyMsg}</div>`;
      return;
    }

    let lastCategory = null;
    visible.forEach(({ facility, index }) => {
      const cat = String(facility.facility_category || 'general').trim() || 'general';
      if (cat !== lastCategory) {
        lastCategory = cat;
        const header = document.createElement('div');
        header.className = 'facility-category-header';
        const catEntry = facilityCategoryCatalog.get(cat.toLowerCase());
        header.innerHTML = `${
          catEntry
            ? `<span class="poi-item-icon">${renderCategoryIcon(catEntry.icon_key)}</span>`
            : ''
        }<span>${escapeHtml(cat)}</span>`;
        listEl.appendChild(header);
      }

      const item = document.createElement('div');
      item.className = 'poi-item';
      item.dataset.index = String(index);
      item.innerHTML = `
        <button type="button" class="poi-item-main" data-index="${index}">
          <span class="poi-item-icon">${facilityIconHtml(facility.icon_key || DEFAULT_FACILITY_ICON_KEY)}</span>
          <span class="poi-item-label">${escapeHtml(facility.facility_name)}</span>
        </button>
      `;
      if (!facility.is_active) item.classList.add('poi-item--inactive');
      if (index === selectedIndex) item.classList.add('active');
      item.querySelector('.poi-item-main')?.addEventListener('click', () => selectFacility(index));
      listEl.appendChild(item);
    });
  }
  rebuildList();

  function panelContains(target) {
    return listPanel.contains(target) || editDialog.contains(target);
  }

  function isSceneViewportTarget(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(
      target.closest('#viewport-body') ||
        target.closest('#viewport-3d') ||
        target.tagName === 'CANVAS',
    );
  }

  function closeEditDialog() {
    editDialog.classList.add('hidden');
  }

  function openEditDialog() {
    closeAddDialog();
    editDialog.classList.remove('hidden');
  }

  listPanel.addEventListener('pointerdown', (e) => {
    if (
      e.target.closest('.poi-item') ||
      e.target.closest('.facility-category-header') ||
      e.target.closest('select') ||
      e.target.closest('input') ||
      e.target.closest('.poi-list-search') ||
      e.target.closest('button')
    ) {
      return;
    }
    deselectFacility();
  });

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (listPanel.classList.contains('hidden') && editDialog.classList.contains('hidden')) return;
      if (isConfirmDialogTarget(e.target)) return;
      if (panelContains(e.target)) return;
      if (addDialog.contains(e.target)) return;
      if (categoryDialog.contains(e.target)) return;
      if (isSceneViewportTarget(e.target)) return;
      deselectFacility();
    },
    true,
  );

  function deselectFacility() {
    if (selectedIndex < 0) {
      closeEditDialog();
      return;
    }
    selectedIndex = -1;
    closeEditDialog();
    listEl.querySelectorAll('.poi-item').forEach((el) => el.classList.remove('active'));
    detachGizmo();
    onSelectionChange?.(-1);
  }

  function syncFormFromData(index) {
    const facility = facilitiesData[index];
    if (!facility) return;
    inputName.value = facility.facility_name;
    refreshCategorySelects(facility.facility_category || '', newCategory?.value || '');
    inputCategory.value = facility.facility_category || '';
    inputGroup.value = facility.facility_group || '';
    inputFloor.value = facility.floor_name || '';
    inputX.value = Number(facility.pos_x).toFixed(4);
    inputY.value = Number(facility.pos_y).toFixed(4);
    inputZ.value = Number(facility.pos_z).toFixed(4);
    inputActive.checked = facility.is_active !== false;
    selectedIconKey = facility.icon_key || DEFAULT_FACILITY_ICON_KEY;
    if (iconSearchInput) iconSearchInput.value = '';
    updateIconPreview(iconPreviewEl, selectedIconKey);
    bindEditIconGrid();
  }

  function applyFormToData(index) {
    const facility = facilitiesData[index];
    if (!facility) return;
    const name = inputName.value.trim();
    if (name) {
      facility.facility_name = name;
      updateFacilityName(index, name);
    }
    facility.facility_category = inputCategory.value.trim() || 'general';
    upsertCategory(facility.facility_category, selectedIconKey);
    facility.facility_group = inputGroup.value.trim();
    facility.floor_name = inputFloor.value.trim();
    facility.icon_key = selectedIconKey || DEFAULT_FACILITY_ICON_KEY;
    facility.is_active = inputActive.checked;
    const x = parseFloat(inputX.value) || 0;
    const y = parseFloat(inputY.value) || 0;
    const z = parseFloat(inputZ.value) || 0;
    updateFacilityPosition(index, x, y, z);
  }

  function selectFacility(index, opts = {}) {
    selectedIndex = index;
    const facility = facilitiesData[index];
    if (!facility) return;

    listEl.querySelectorAll('.poi-item').forEach((el) => {
      el.classList.toggle('active', Number(el.dataset.index) === index);
    });

    syncFormFromData(index);
    openEditDialog();
    if (opts.fly !== false) {
      flyTo(facility.pos_x, facility.pos_y, facility.pos_z, {
        entityKind: 'facility',
        entityId: facility.id,
      });
    }

    const objs = getFacilityObjects();
    if (objs[index] && !shouldUseMatterportCamera()) {
      attachGizmo(objs[index].mesh);
    } else {
      detachGizmo();
    }
    onSelectionChange?.(index);
  }

  function bindEditIconGrid() {
    renderIconGrid({
      gridEl: iconGridEl,
      searchInput: iconSearchInput,
      activeKey: selectedIconKey,
      onSelect: (key) => {
        selectedIconKey = key;
        updateIconPreview(iconPreviewEl, selectedIconKey);
        bindEditIconGrid();
        closeAllIconMenus();
      },
    });
  }

  iconSearchInput?.addEventListener('input', () => bindEditIconGrid());
  bindIconSelect(iconTriggerEl, iconMenuEl, () => bindEditIconGrid());
  bindIconSelect(newIconTriggerEl, newIconMenuEl, () => openAddDialogIconGrid());
  bindIconSelect(catIconTriggerEl, catIconMenuEl, () => openCategoryDialogIconGrid());

  document.addEventListener('pointerdown', (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('.icon-select')) return;
    closeAllIconMenus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeCategoryFilterMenu();
      closeAllIconMenus();
    }
  });

  inputCategory?.addEventListener('change', () => {
    applyCategoryDefaults(inputCategory.value, { forAddDialog: false });
  });

  newCategory?.addEventListener('change', () => {
    applyCategoryDefaults(newCategory.value, { forAddDialog: true });
  });

  searchInputEl?.addEventListener('input', () => {
    filterSearchQuery = searchInputEl.value || '';
    rebuildList();
  });

  categoryFilterBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleCategoryFilterMenu();
  });

  document.addEventListener(
    'click',
    (e) => {
      if (!categoryFilterMenu || categoryFilterMenu.classList.contains('hidden')) return;
      const t = e.target;
      if (categoryFilterMenu.contains(t) || categoryFilterBtn?.contains(t)) return;
      closeCategoryFilterMenu();
    },
    true,
  );

  function openAddDialogIconGrid() {
    renderIconGrid({
      gridEl: newIconGridEl,
      searchInput: newIconSearchInput,
      activeKey: addDialogIconKey,
      onSelect: (key) => {
        addDialogIconKey = key;
        updateIconPreview(newIconPreviewEl, addDialogIconKey);
        openAddDialogIconGrid();
        closeAllIconMenus();
      },
    });
  }

  function openCategoryDialogIconGrid() {
    renderIconGrid({
      gridEl: catIconGridEl,
      searchInput: catIconSearchInput,
      activeKey: categoryDialogIconKey,
      onSelect: (key) => {
        categoryDialogIconKey = key;
        updateIconPreview(catIconPreviewEl, categoryDialogIconKey);
        openCategoryDialogIconGrid();
        closeAllIconMenus();
      },
    });
  }

  function openCategoryDialog(target = 'edit') {
    categoryDialogTarget = target;
    catNameInput.value = '';
    categoryDialogIconKey = DEFAULT_FACILITY_ICON_KEY;
    if (catIconSearchInput) catIconSearchInput.value = '';
    updateIconPreview(catIconPreviewEl, categoryDialogIconKey);
    openCategoryDialogIconGrid();
    categoryDialog.classList.remove('hidden');
    requestAnimationFrame(() => catNameInput.focus());
  }

  function closeCategoryDialog() {
    closeAllIconMenus();
    categoryDialog.classList.add('hidden');
  }

  function openAddDialog(preset = {}) {
    deselectFacility();
    newName.value = preset.name ?? '';
    refreshCategorySelects('', preset.category ?? '');
    newCategory.value = preset.category ?? '';
    newGroup.value = preset.group ?? '';
    newFloor.value = preset.floor ?? '';
    newX.value = Number(preset.x ?? 0).toFixed(4);
    newY.value = Number(preset.y ?? 0).toFixed(4);
    newZ.value = Number(preset.z ?? 0).toFixed(4);
    addDialogIconKey = preset.icon_key || DEFAULT_FACILITY_ICON_KEY;
    if (preset.category) applyCategoryDefaults(preset.category, { forAddDialog: true });
    if (newIconSearchInput) newIconSearchInput.value = '';
    updateIconPreview(newIconPreviewEl, addDialogIconKey);
    openAddDialogIconGrid();
    addDialog.classList.remove('hidden');
    requestAnimationFrame(() => newName.focus());
  }

  newIconSearchInput?.addEventListener('input', () => openAddDialogIconGrid());
  catIconSearchInput?.addEventListener('input', () => openCategoryDialogIconGrid());

  function closeAddDialog() {
    closeAllIconMenus();
    addDialog.classList.add('hidden');
  }

  btnHeaderAddCategory?.addEventListener('click', () => openCategoryDialog('filter'));
  btnEditAddCategory?.addEventListener('click', () => openCategoryDialog('edit'));
  btnNewAddCategory?.addEventListener('click', () => openCategoryDialog('add'));

  addDialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="close"]')) closeAddDialog();
  });

  editDialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="close-edit"]')) deselectFacility();
  });

  categoryDialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="close-cat"]')) closeCategoryDialog();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (isConfirmDialogOpen()) return;
    if (!categoryDialog.classList.contains('hidden')) {
      closeCategoryDialog();
      return;
    }
    if (!addDialog.classList.contains('hidden')) {
      closeAddDialog();
      return;
    }
    if (!editDialog.classList.contains('hidden')) {
      deselectFacility();
    }
  });

  btnSaveCategory?.addEventListener('click', () => {
    const name = catNameInput.value.trim();
    if (!name) {
      showToast('Category name is required', 'error');
      return;
    }
    const entry = upsertCategory(name, categoryDialogIconKey);
    refreshCategorySelects(
      categoryDialogTarget === 'edit' ? entry.name : inputCategory?.value || '',
      categoryDialogTarget === 'add' ? entry.name : newCategory?.value || '',
    );
    if (categoryDialogTarget === 'edit') {
      inputCategory.value = entry.name;
      applyCategoryDefaults(entry.name, { forAddDialog: false });
    } else if (categoryDialogTarget === 'add') {
      newCategory.value = entry.name;
      applyCategoryDefaults(entry.name, { forAddDialog: true });
    } else {
      filterCategory = entry.name;
      syncCategoryFilterBtn();
    }
    closeCategoryDialog();
    rebuildList();
    showToast(`Category “${entry.name}” added`, 'success');
  });

  btnSave.addEventListener('click', async () => {
    if (selectedIndex < 0) return;
    if (!inputCategory.value.trim()) {
      showToast('Pick or add a category first', 'error');
      return;
    }
    applyFormToData(selectedIndex);
    rebuildList();
    selectFacility(selectedIndex);

    btnSave.disabled = true;
    btnSave.textContent = 'Translating…';
    try {
      await saveFacilityToDb(selectedIndex, { translate: true });
      onFacilityListChange?.();
      btnSave.textContent = 'Saved';
      showToast('Amenity saved (translations updated)', 'success');
    } catch (err) {
      console.error(err);
      btnSave.textContent = 'DB error';
      showToast(err.message ?? 'Failed to save amenity', 'error');
    } finally {
      setTimeout(() => {
        btnSave.disabled = false;
        btnSave.innerHTML = `<span class="icon">${iconSave()}</span> Save Changes`;
      }, 1400);
    }
  });

  btnAdd.addEventListener('click', async () => {
    const name = newName.value.trim() || DEFAULT_NEW_FACILITY_NAME;
    const category = newCategory.value.trim();
    if (!category) {
      showToast('Pick or add a category first', 'error');
      return;
    }
    upsertCategory(category, addDialogIconKey);
    btnAdd.disabled = true;
    const prevLabel = btnAdd.innerHTML;
    btnAdd.textContent = 'Translating…';
    try {
      const idx = await addFacilityWithDb({
        facility_name: name,
        facility_category: category,
        facility_group: newGroup.value.trim() || category,
        floor_name: newFloor.value.trim(),
        icon_key: addDialogIconKey || DEFAULT_FACILITY_ICON_KEY,
        pos_x: parseFloat(newX.value) || 0,
        pos_y: parseFloat(newY.value) || 0,
        pos_z: parseFloat(newZ.value) || 0,
        is_active: true,
      });
      rebuildList();
      selectFacility(idx);
      closeAddDialog();
      onFacilityListChange?.();
      showToast('Amenity added (translations saved)', 'success');
    } catch (err) {
      console.error(err);
      showToast(err.message ?? 'Could not add amenity', 'error');
    } finally {
      btnAdd.disabled = false;
      btnAdd.innerHTML = prevLabel;
    }
  });

  btnDelete.addEventListener('click', async () => {
    if (selectedIndex < 0) return;
    const index = selectedIndex;
    const name = facilitiesData[index]?.facility_name || 'this amenity';
    const ok = await askConfirm({
      title: 'Delete amenity?',
      message: `Are you sure you want to delete "${name}"?`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    if (index < 0 || index >= facilitiesData.length) return;
    btnDelete.disabled = true;
    try {
      await removeFacilityFromDb(index);
    } catch (err) {
      console.error(err);
    }
    deleteFacility(index);
    detachGizmo();
    selectedIndex = -1;
    closeEditDialog();
    listEl.querySelectorAll('.poi-item').forEach((el) => el.classList.remove('active'));
    onSelectionChange?.(-1);
    rebuildList();
    onFacilityListChange?.();
    btnDelete.disabled = false;
  });

  function wireFacilityGizmoHandlers() {
    setGizmoDragCallback((transform) => {
      if (selectedIndex < 0) return;
      const pos = transform.position;
      inputX.value = pos.x.toFixed(4);
      inputY.value = pos.y.toFixed(4);
      inputZ.value = pos.z.toFixed(4);
      updateFacilityPosition(selectedIndex, pos.x, pos.y, pos.z);

      const objs = getFacilityObjects();
      if (objs[selectedIndex]) {
        objs[selectedIndex].label.position.set(pos.x, pos.y + 0.85, pos.z);
      }
    });

    setGizmoDragEndCallback(() => {
      if (selectedIndex < 0) return;
      // Position-only save — skip re-translating all languages.
      saveFacilityToDb(selectedIndex, { translate: false }).catch((err) =>
        console.error('[facility-panel] save after gizmo:', err),
      );
    });
  }

  wireFacilityGizmoHandlers();

  return {
    show() {
      listPanel.classList.remove('hidden');
      rebuildList();
      wireFacilityGizmoHandlers();
    },
    wireGizmoHandlers: wireFacilityGizmoHandlers,
    hide() {
      listPanel.classList.add('hidden');
      deselectFacility();
    },
    deselect() {
      deselectFacility();
    },
    selectByIndex(index, opts = {}) {
      if (index >= 0 && index < facilitiesData.length) selectFacility(index, opts);
    },
    getSelectedIndex() {
      return selectedIndex;
    },
    refresh() {
      rebuildList();
      if (selectedIndex >= 0 && selectedIndex < facilitiesData.length) {
        selectFacility(selectedIndex, { fly: false });
      } else {
        selectedIndex = -1;
        closeEditDialog();
        detachGizmo();
      }
    },
    openAddDialog,
  };
}
