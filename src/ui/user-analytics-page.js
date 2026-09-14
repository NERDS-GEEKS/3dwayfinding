/**
 * Standalone `/analytics` page — User Analytics for the NavMe AR experience.
 *
 * Reads the telemetry written by the WebXR bundle (navme_ar_sessions /
 * navme_ar_events): who opened the experience, how long localization took, the
 * FPS they actually got, which POIs they picked and whether a route generated.
 *
 * Read-only. Same project login gate as the Media Manager.
 */

import '../styles/global.css';
import '../styles/enterprise-theme.css';
import '../styles/glass-theme.css';
import '../styles/glass-animations.css';
import '../styles/user-analytics.css';

import { initTheme, bindThemeToggle } from '../config/theme.js';
import { BRAND_NAME } from '../config/brand.js';
import { iconSun, iconMoon } from './icons.js';
import { renderForm } from './form.js';
import { showToast } from './toast.js';
import { authenticateLoginNavme } from '../services/supabase.js';
import { setPoiSession, clearPoiSession, getPoiType } from '../config/poi-session.js';
import { getProjectSession, clearProjectSession } from '../config/project-session.js';
import {
  startArAnalyticsRealtime,
  stopArAnalyticsRealtime,
} from '../services/ar-analytics-realtime.js';
import {
  fetchArSessions,
  fetchPoiEvents,
  fetchSessionEvents,
  sinceIso,
  summarizeSessions,
  summarizeDevices,
  summarizePois,
  fpsBuckets,
  sessionsByDay,
} from '../services/ar-analytics.js';

const RANGE_OPTIONS = [
  { value: '1', label: 'Today' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '0', label: 'All time' },
];

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return String(iso);
  }
}

function fmtMs(ms) {
  if (ms === null || ms === undefined || ms === '') return '—';
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)} s`;
  const mins = Math.floor(n / 60000);
  const secs = Math.round((n % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function fmtNum(v, digits = 1) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

function fmtPct(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : '—';
}

/** Colour tone for an FPS number — the headline health signal on this page. */
function fpsTone(fps) {
  const n = Number(fps);
  if (!Number.isFinite(n)) return '';
  if (n >= 50) return 'good';
  if (n >= 35) return 'ok';
  if (n >= 22) return 'warn';
  return 'bad';
}

function deviceLabel(row) {
  const brand = String(row.device_brand ?? '').trim();
  const model = String(row.device_model ?? '').trim();
  if (model && brand && !model.toLowerCase().includes(brand.toLowerCase())) return `${brand} ${model}`;
  return model || brand || 'Unknown device';
}

function osLabel(row) {
  const os = String(row.os_name ?? '').trim();
  const ver = String(row.os_version ?? '').trim();
  if (os && ver) return `${os} ${ver}`;
  return os || '—';
}

function statusChip(row) {
  if (row.localization_failed) return '<span class="ua-chip ua-chip--bad">Localize failed</span>';
  if (row.localized_at) return '<span class="ua-chip ua-chip--good">Localized</span>';
  return '<span class="ua-chip ua-chip--warn">Never localized</span>';
}

function endChip(row) {
  if (!row.ended_at) return '<span class="ua-chip ua-chip--live">Live</span>';
  const reason = String(row.end_reason ?? '').trim() || 'ended';
  return `<span class="ua-chip">${escapeHtml(reason)}</span>`;
}

function rowsToCsv(rows) {
  const cols = [
    'opened_at', 'ended_at', 'end_reason', 'duration_ms', 'poi_type',
    'device_brand', 'device_model', 'os_name', 'os_version', 'browser_name', 'browser_version',
    'is_mobile', 'screen_w', 'screen_h', 'device_pixel_ratio', 'device_memory_gb', 'cpu_cores', 'gpu_renderer',
    'network_type', 'language',
    'localization_ms', 'localize_attempts', 'relocalize_count', 'tracking_lost_count', 'localization_failed',
    'confidence_avg', 'confidence_min',
    'fps_avg', 'fps_min', 'fps_max', 'fps_p05', 'jank_ratio', 'long_task_count', 'fps_samples',
    'pois_selected', 'routes_generated', 'routes_failed', 'arrivals', 'hidden_count', 'session_key',
  ];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(','));
  return lines.join('\n');
}

function downloadCsv(filename, csv) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * @param {HTMLElement} container
 */
export function initUserAnalyticsPage(container) {
  initTheme();
  container.innerHTML = '';

  const page = document.createElement('div');
  page.className = 'ua-page';
  page.innerHTML = `
    <header class="ua-topbar">
      <img src="/NavMe_wb.png" alt="${BRAND_NAME}" class="topbar-logo-img" />
      <div class="ua-topbar-title">
        <h1>User Analytics</h1>
        <p class="ua-subtitle">AR experience sessions, localization, device performance</p>
      </div>
      <div class="ua-topbar-actions">
        <button type="button" class="theme-toggle btn-ripple-host" id="ua-theme-toggle" aria-label="Switch theme">
          <span class="theme-toggle-icon theme-toggle-icon--sun">${iconSun()}</span>
          <span class="theme-toggle-icon theme-toggle-icon--moon">${iconMoon()}</span>
        </button>
        <a href="/" class="btn-secondary">← ${BRAND_NAME}</a>
        <button type="button" class="btn-logout" id="ua-logout">Log out</button>
      </div>
    </header>

    <main class="ua-main hidden" id="ua-main">
      <section class="ua-toolbar">
        <label class="ua-field">
          <span>Range</span>
          <select id="ua-range">
            ${RANGE_OPTIONS.map((o) => `<option value="${o.value}"${o.value === '7' ? ' selected' : ''}>${o.label}</option>`).join('')}
          </select>
        </label>
        <label class="ua-field ua-field--grow">
          <span>Search device / OS / browser</span>
          <input type="search" id="ua-search" placeholder="e.g. SM-A146B, Android 13, iOS…" />
        </label>
        <label class="ua-field ua-field--check">
          <input type="checkbox" id="ua-only-issues" />
          <span>Only sessions with issues</span>
        </label>
        <div class="ua-toolbar-actions">
          <span class="ua-live ua-live--connecting" id="ua-live" title="Live updates over websocket">
            <span class="ua-live-dot"></span><span class="ua-live-text">Connecting…</span>
          </span>
          <button type="button" class="btn-secondary" id="ua-refresh">Refresh</button>
          <button type="button" class="btn-secondary" id="ua-export">Export CSV</button>
        </div>
      </section>

      <section class="ua-kpis" id="ua-kpis"></section>

      <section class="ua-grid">
        <div class="ua-card">
          <h2>Sessions per day</h2>
          <div class="ua-trend" id="ua-trend"></div>
        </div>
        <div class="ua-card">
          <h2>Frame rate distribution</h2>
          <p class="ua-card-hint">Average FPS per session — the low buckets are where the experience struggles.</p>
          <div class="ua-buckets" id="ua-fps-buckets"></div>
        </div>
      </section>

      <section class="ua-card">
        <h2>Devices</h2>
        <p class="ua-card-hint">Per model: how it performed and how long localization took.</p>
        <div class="ua-table-wrap">
          <table class="ua-table" id="ua-device-table">
            <thead>
              <tr>
                <th>Device</th><th>OS</th><th>Sessions</th><th>Avg FPS</th><th>Worst FPS</th>
                <th>Median localize</th><th>Janky</th><th>Localize failed</th><th>RAM / cores</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </section>

      <section class="ua-card">
        <h2>Destinations</h2>
        <p class="ua-card-hint">Which POIs users pick, and whether a navigation route actually generated.</p>
        <div class="ua-table-wrap">
          <table class="ua-table" id="ua-poi-table">
            <thead>
              <tr><th>Destination</th><th>Selected</th><th>Route generated</th><th>Route failed</th><th>Success</th><th>Avg route length</th></tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </section>

      <section class="ua-card">
        <h2>Sessions</h2>
        <p class="ua-card-hint" id="ua-session-count"></p>
        <div class="ua-table-wrap">
          <table class="ua-table ua-table--sessions" id="ua-session-table">
            <thead>
              <tr>
                <th>Opened</th><th>Device</th><th>OS / Browser</th><th>Status</th>
                <th>Localize</th><th>Avg FPS</th><th>POIs</th><th>Routes</th>
                <th>Duration</th><th>End</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </section>

      <div class="ua-empty hidden" id="ua-empty">
        <p>No sessions recorded in this range yet.</p>
        <p class="ua-card-hint">Sessions appear here as soon as someone opens the AR experience.</p>
      </div>
    </main>

    <div class="ua-drawer hidden" id="ua-drawer" role="dialog" aria-modal="true" aria-label="Session timeline">
      <div class="ua-drawer-panel">
        <header class="ua-drawer-head">
          <div>
            <h3 id="ua-drawer-title">Session</h3>
            <p class="ua-card-hint" id="ua-drawer-sub"></p>
          </div>
          <button type="button" class="btn-secondary" id="ua-drawer-close">Close</button>
        </header>
        <div class="ua-drawer-body" id="ua-drawer-body"></div>
      </div>
    </div>
  `;
  container.appendChild(page);

  bindThemeToggle(page.querySelector('#ua-theme-toggle'));

  const mainEl = page.querySelector('#ua-main');
  const rangeEl = page.querySelector('#ua-range');
  const searchEl = page.querySelector('#ua-search');
  const issuesEl = page.querySelector('#ua-only-issues');
  const emptyEl = page.querySelector('#ua-empty');
  const drawerEl = page.querySelector('#ua-drawer');

  /** @type {Array<Record<string, any>>} */
  let allSessions = [];
  /** @type {Array<Record<string, any>>} */
  let poiEvents = [];
  let loading = false;

  /** Coalesces bursts of websocket messages into one DOM update. */
  let renderTimer = null;
  /** session_key → timestamp, so freshly-changed rows can flash. */
  const recentlyLive = new Map();
  /** Current date-range floor; incoming rows outside it are ignored. */
  let rangeSinceMs = 0;
  /** Cap the live event buffer the same way the initial fetch is capped. */
  const LIVE_EVENT_CAP = 5000;
  /** session_key currently shown in the drawer, so live events can stream into it. */
  let openDrawerKey = null;

  /** Client-side filters over the fetched range. */
  function visibleSessions() {
    const term = String(searchEl.value ?? '').trim().toLowerCase();
    const onlyIssues = Boolean(issuesEl.checked);

    return allSessions.filter((r) => {
      if (onlyIssues) {
        const janky = Number(r.jank_ratio) > 0.05;
        const lowFps = Number.isFinite(Number(r.fps_avg)) && Number(r.fps_avg) < 35;
        const failed = Boolean(r.localization_failed) || !r.localized_at;
        const routeFail = Number(r.routes_failed) > 0;
        if (!janky && !lowFps && !failed && !routeFail) return false;
      }
      if (!term) return true;
      const hay = [
        r.device_model, r.device_brand, r.os_name, r.os_version,
        r.browser_name, r.platform, r.gpu_renderer, r.user_label,
      ]
        .map((v) => String(v ?? '').toLowerCase())
        .join(' ');
      return hay.includes(term);
    });
  }

  function renderKpis(rows) {
    const s = summarizeSessions(rows);
    const cards = [
      { label: 'Sessions', value: String(s.sessions), hint: `${s.deviceTypes} device type${s.deviceTypes === 1 ? '' : 's'}` },
      { label: 'Localized', value: fmtPct(s.localizeRate), hint: `${s.failedLocalize} failed` },
      { label: 'Median localize time', value: fmtMs(s.medianLocalizeMs), hint: 'open → first lock' },
      { label: 'Avg FPS', value: fmtNum(s.avgFps, 1), hint: `${s.jankSessions} janky session${s.jankSessions === 1 ? '' : 's'}`, tone: fpsTone(s.avgFps) },
      { label: 'Route success', value: fmtPct(s.routeSuccessRate), hint: `${s.routesOk} ok · ${s.routesFail} failed` },
      { label: 'POIs selected', value: String(s.poisSelected), hint: `${s.arrivals} arrival${s.arrivals === 1 ? '' : 's'}` },
      { label: 'Median duration', value: fmtMs(s.medianDurationMs), hint: 'per session' },
    ];
    page.querySelector('#ua-kpis').innerHTML = cards
      .map(
        (c) => `
      <div class="ua-kpi${c.tone ? ` ua-kpi--${c.tone}` : ''}">
        <span class="ua-kpi-label">${escapeHtml(c.label)}</span>
        <strong class="ua-kpi-value">${escapeHtml(c.value)}</strong>
        <span class="ua-kpi-hint">${escapeHtml(c.hint)}</span>
      </div>`
      )
      .join('');
  }

  function renderTrend(rows) {
    const days = sessionsByDay(rows, 14);
    const max = Math.max(1, ...days.map((d) => d.count));
    page.querySelector('#ua-trend').innerHTML = days
      .map(
        (d) => `
      <div class="ua-trend-col" title="${escapeHtml(d.key)}: ${d.count} session${d.count === 1 ? '' : 's'}">
        <div class="ua-trend-bar" style="height:${Math.max(3, (d.count / max) * 100)}%"></div>
        <span class="ua-trend-label">${escapeHtml(d.label)}</span>
      </div>`
      )
      .join('');
  }

  function renderFpsBuckets(rows) {
    const buckets = fpsBuckets(rows);
    const total = buckets.reduce((a, b) => a + b.count, 0);
    page.querySelector('#ua-fps-buckets').innerHTML = buckets
      .map((b) => {
        const pct = total ? (b.count / total) * 100 : 0;
        return `
        <div class="ua-bucket">
          <span class="ua-bucket-label">${escapeHtml(b.label)}</span>
          <div class="ua-bucket-track"><div class="ua-bucket-fill ua-bucket-fill--${b.tone}" style="width:${pct}%"></div></div>
          <span class="ua-bucket-count">${b.count}</span>
        </div>`;
      })
      .join('');
  }

  function renderDevices(rows) {
    const devices = summarizeDevices(rows);
    const tbody = page.querySelector('#ua-device-table tbody');
    if (!devices.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="ua-muted">No device data yet.</td></tr>';
      return;
    }
    tbody.innerHTML = devices
      .map(
        (d) => `
      <tr>
        <td><strong>${escapeHtml(d.brand && !d.model.toLowerCase().includes(d.brand.toLowerCase()) ? `${d.brand} ${d.model}` : d.model)}</strong></td>
        <td>${escapeHtml(d.os)}${d.osVersions ? ` <span class="ua-muted">${escapeHtml(d.osVersions)}</span>` : ''}</td>
        <td>${d.sessions}</td>
        <td class="ua-fps ua-fps--${fpsTone(d.avgFps)}">${fmtNum(d.avgFps, 1)}</td>
        <td class="ua-fps ua-fps--${fpsTone(d.minFps)}">${fmtNum(d.minFps, 0)}</td>
        <td>${fmtMs(d.medianLocalizeMs)}</td>
        <td>${d.jankSessions || '—'}</td>
        <td>${d.failedLocalize || '—'}</td>
        <td class="ua-muted">${d.memory != null ? `${fmtNum(d.memory, 0)} GB` : '—'} / ${d.cores ?? '—'}</td>
      </tr>`
      )
      .join('');
  }

  function renderPois() {
    const pois = summarizePois(poiEvents);
    const tbody = page.querySelector('#ua-poi-table tbody');
    if (!pois.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="ua-muted">No destinations selected in this range.</td></tr>';
      return;
    }
    tbody.innerHTML = pois
      .slice(0, 50)
      .map(
        (p) => `
      <tr>
        <td><strong>${escapeHtml(p.name)}</strong></td>
        <td>${p.selected}</td>
        <td>${p.routed}</td>
        <td>${p.failed ? `<span class="ua-chip ua-chip--bad">${p.failed}</span>` : '—'}</td>
        <td>${fmtPct(p.successRate)}</td>
        <td>${p.avgRouteM != null ? `${fmtNum(p.avgRouteM, 1)} m` : '—'}</td>
      </tr>`
      )
      .join('');
  }

  function renderSessions(rows) {
    const tbody = page.querySelector('#ua-session-table tbody');
    page.querySelector('#ua-session-count').textContent =
      `${rows.length} session${rows.length === 1 ? '' : 's'} shown${allSessions.length !== rows.length ? ` of ${allSessions.length}` : ''}. Click a row for the full timeline.`;

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="ua-muted">No sessions match these filters.</td></tr>';
      return;
    }

    tbody.innerHTML = rows
      .map((r) => {
        const routes = `${Number(r.routes_generated) || 0}${Number(r.routes_failed) ? ` <span class="ua-bad">/ ${r.routes_failed} failed</span>` : ''}`;
        return `
      <tr data-session="${escapeHtml(r.session_key)}" tabindex="0"${
          recentlyLive.has(r.session_key) ? ' class="ua-row-live"' : ''
        }>
        <td>${escapeHtml(fmtDateTime(r.opened_at))}</td>
        <td><strong>${escapeHtml(deviceLabel(r))}</strong></td>
        <td>${escapeHtml(osLabel(r))}<br /><span class="ua-muted">${escapeHtml(String(r.browser_name ?? '—'))}</span></td>
        <td>${statusChip(r)}</td>
        <td>${fmtMs(r.localization_ms)}${Number(r.relocalize_count) ? ` <span class="ua-muted">+${r.relocalize_count} re</span>` : ''}</td>
        <td class="ua-fps ua-fps--${fpsTone(r.fps_avg)}">${fmtNum(r.fps_avg, 1)}</td>
        <td>${Number(r.pois_selected) || 0}</td>
        <td>${routes}</td>
        <td>${fmtMs(r.duration_ms)}</td>
        <td>${endChip(r)}</td>
      </tr>`;
      })
      .join('');
  }

  function renderAll() {
    // Live updates rebuild these tables constantly; without this the page would
    // jump back to the top every time a session heartbeats.
    const scrollTop = mainEl.scrollTop;

    const rows = visibleSessions();
    renderKpis(rows);
    renderTrend(rows);
    renderFpsBuckets(rows);
    renderDevices(rows);
    renderPois();
    renderSessions(rows);
    emptyEl.classList.toggle('hidden', allSessions.length > 0);

    mainEl.scrollTop = scrollTop;
  }

  /**
   * Batch DOM work. A busy venue can push many messages a second; rendering per
   * message would thrash the page for no visible gain.
   */
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderAll();
    }, 600);
  }

  function setLiveStatus(status) {
    const el = page.querySelector('#ua-live');
    if (!el) return;
    el.classList.remove('ua-live--connecting', 'ua-live--live', 'ua-live--error');
    el.classList.add(`ua-live--${status === 'live' ? 'live' : status}`);
    const text = el.querySelector('.ua-live-text');
    if (text) {
      text.textContent =
        status === 'live' ? 'Live' : status === 'error' ? 'Reconnecting…' : 'Connecting…';
    }
  }

  /** Mark a session as just-changed so its row flashes, then clear the mark. */
  function markLive(sessionKey) {
    recentlyLive.set(sessionKey, Date.now());
    setTimeout(() => {
      recentlyLive.delete(sessionKey);
      scheduleRender();
    }, 2000);
  }

  /** Merge a websocket session row into the in-memory list. */
  function applyLiveSession(row, eventType) {
    const key = String(row?.session_key ?? '').trim();
    if (!key) return;

    if (eventType === 'DELETE') {
      allSessions = allSessions.filter((r) => r.session_key !== key);
      poiEvents = poiEvents.filter((e) => e.session_key !== key);
      if (openDrawerKey === key) closeDrawer();
      scheduleRender();
      return;
    }

    // Respect the range the user is looking at.
    if (rangeSinceMs > 0) {
      const opened = Date.parse(row.opened_at ?? '');
      if (Number.isFinite(opened) && opened < rangeSinceMs) return;
    }

    const idx = allSessions.findIndex((r) => r.session_key === key);
    if (idx >= 0) allSessions[idx] = { ...allSessions[idx], ...row };
    else allSessions.unshift(row);

    // Keep newest-first ordering, matching the initial fetch.
    allSessions.sort((a, b) => String(b.opened_at ?? '').localeCompare(String(a.opened_at ?? '')));

    markLive(key);
    scheduleRender();
  }

  /** Append a websocket destination event and refresh the open drawer if it matches. */
  function applyLiveEvent(row) {
    if (rangeSinceMs > 0) {
      const at = Date.parse(row.event_at ?? '');
      if (Number.isFinite(at) && at < rangeSinceMs) return;
    }

    poiEvents.unshift(row);
    if (poiEvents.length > LIVE_EVENT_CAP) poiEvents.length = LIVE_EVENT_CAP;

    if (openDrawerKey && row.session_key === openDrawerKey) appendDrawerEvent(row);
    scheduleRender();
  }

  /**
   * (Re)subscribe after every load: the project scope can change with the
   * session, and the server-side channel filter is fixed at subscribe time.
   */
  function connectLive(poiType) {
    startArAnalyticsRealtime({
      poiType,
      onSession: applyLiveSession,
      onEvent: applyLiveEvent,
      onStatus: setLiveStatus,
    });
  }

  async function load() {
    if (loading) return;
    loading = true;
    const refreshBtn = page.querySelector('#ua-refresh');
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Loading…';
    try {
      const days = Number(rangeEl.value);
      const since = days > 0 ? sinceIso(days - 1) : null;
      rangeSinceMs = since ? Date.parse(since) : 0;
      const poiType = getPoiType() || null;
      const [sessions, events] = await Promise.all([
        fetchArSessions({ poiType, since }),
        fetchPoiEvents({ poiType, since }),
      ]);
      allSessions = sessions;
      poiEvents = events;
      renderAll();
      // Snapshot is on screen — now keep it live off the websocket.
      connectLive(poiType);
    } catch (err) {
      console.error(err);
      showToast(err?.message || 'Could not load analytics', 'error');
    } finally {
      loading = false;
      refreshBtn.disabled = false;
      refreshBtn.textContent = 'Refresh';
    }
  }

  function timelineItemHtml(e) {
    const label = String(e.event_type ?? '').replace(/_/g, ' ');
    const extra = [];
    if (e.poi_name) extra.push(escapeHtml(String(e.poi_name)));
    if (e.value != null) extra.push(escapeHtml(String(e.value)));
    if (e.detail) {
      const detail = typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail);
      extra.push(escapeHtml(detail));
    }
    return `
      <li class="ua-tl-item ua-tl-item--${escapeHtml(String(e.event_type ?? ''))}">
        <span class="ua-tl-time">${fmtMs(e.t_ms)}</span>
        <span class="ua-tl-type">${escapeHtml(label)}</span>
        <span class="ua-tl-detail">${extra.join(' · ')}</span>
      </li>`;
  }

  /** Stream a websocket event into the open drawer without refetching it. */
  function appendDrawerEvent(row) {
    const list = page.querySelector('#ua-timeline');
    if (!list) return;
    list.insertAdjacentHTML('beforeend', timelineItemHtml(row));
    const last = list.lastElementChild;
    if (last) last.classList.add('ua-tl-item--new');
  }

  async function openSessionDrawer(sessionKey) {
    const row = allSessions.find((r) => r.session_key === sessionKey);
    if (!row) return;

    openDrawerKey = sessionKey;
    page.querySelector('#ua-drawer-title').textContent = deviceLabel(row);
    page.querySelector('#ua-drawer-sub').textContent =
      `${osLabel(row)} · ${fmtDateTime(row.opened_at)} · ${fmtMs(row.duration_ms)}`;
    const body = page.querySelector('#ua-drawer-body');
    body.innerHTML = '<p class="ua-muted">Loading timeline…</p>';
    drawerEl.classList.remove('hidden');

    const facts = [
      ['Session key', row.session_key],
      ['Project', row.poi_type],
      ['Localize time', fmtMs(row.localization_ms)],
      ['Localize attempts', row.localize_attempts],
      ['Relocalizations', row.relocalize_count],
      ['Tracking lost', row.tracking_lost_count],
      ['Confidence avg / min', `${fmtNum(row.confidence_avg, 0)}% / ${fmtNum(row.confidence_min, 0)}%`],
      ['FPS avg / min / p05', `${fmtNum(row.fps_avg, 1)} / ${fmtNum(row.fps_min, 0)} / ${fmtNum(row.fps_p05, 0)}`],
      ['Jank ratio', fmtPct(row.jank_ratio)],
      ['Long tasks', row.long_task_count],
      ['Screen', `${row.screen_w ?? '—'}×${row.screen_h ?? '—'} @${fmtNum(row.device_pixel_ratio, 1)}x`],
      ['RAM / cores', `${row.device_memory_gb != null ? `${fmtNum(row.device_memory_gb, 0)} GB` : '—'} / ${row.cpu_cores ?? '—'}`],
      ['GPU', row.gpu_renderer],
      ['Network', row.network_type],
      ['Language', row.language],
      ['Shared POI link', row.shared_poi_id],
      ['Ended', `${fmtDateTime(row.ended_at)} (${row.end_reason ?? '—'})`],
    ];

    const factsHtml = `
      <div class="ua-facts">
        ${facts
          .filter(([, v]) => v != null && String(v).trim() !== '' && String(v) !== '—')
          .map(([k, v]) => `<div class="ua-fact"><span>${escapeHtml(k)}</span><strong>${escapeHtml(String(v))}</strong></div>`)
          .join('')}
      </div>`;

    try {
      const events = await fetchSessionEvents(sessionKey);
      const timeline = events.length
        ? `<ol class="ua-timeline" id="ua-timeline">${events.map(timelineItemHtml).join('')}</ol>`
        : '<ol class="ua-timeline" id="ua-timeline"></ol>';
      body.innerHTML = factsHtml + timeline;
    } catch (err) {
      console.error(err);
      body.innerHTML = `${factsHtml}<p class="ua-muted">Could not load the event timeline.</p>`;
    }
  }

  function closeDrawer() {
    drawerEl.classList.add('hidden');
    openDrawerKey = null;
  }

  // ── wiring ──
  rangeEl.addEventListener('change', () => void load());
  searchEl.addEventListener('input', renderAll);
  issuesEl.addEventListener('change', renderAll);
  page.querySelector('#ua-refresh').addEventListener('click', () => void load());
  page.querySelector('#ua-export').addEventListener('click', () => {
    const rows = visibleSessions();
    if (!rows.length) {
      showToast('Nothing to export', 'error');
      return;
    }
    downloadCsv(`navme-user-analytics-${new Date().toISOString().slice(0, 10)}.csv`, rowsToCsv(rows));
  });

  page.querySelector('#ua-session-table tbody').addEventListener('click', (e) => {
    const tr = /** @type {HTMLElement} */ (e.target)?.closest?.('tr[data-session]');
    if (tr) void openSessionDrawer(tr.getAttribute('data-session'));
  });
  page.querySelector('#ua-session-table tbody').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const tr = /** @type {HTMLElement} */ (e.target)?.closest?.('tr[data-session]');
    if (!tr) return;
    e.preventDefault();
    void openSessionDrawer(tr.getAttribute('data-session'));
  });

  page.querySelector('#ua-drawer-close').addEventListener('click', closeDrawer);
  drawerEl.addEventListener('click', (e) => {
    if (e.target === drawerEl) closeDrawer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !drawerEl.classList.contains('hidden')) closeDrawer();
  });

  page.querySelector('#ua-logout').addEventListener('click', () => {
    stopArAnalyticsRealtime();
    clearProjectSession();
    clearPoiSession();
    window.location.href = '/';
  });

  window.addEventListener('pagehide', () => {
    stopArAnalyticsRealtime();
    if (renderTimer) clearTimeout(renderTimer);
  });

  const formUI = renderForm(container, async (creds) => {
    setPoiSession({
      poiType: creds.poiType,
      mapCode: creds.mapCode,
      organizationId: creds.organizationId,
    });
    formUI.hide();
    mainEl.classList.remove('hidden');
    await load();
  });

  // Restore saved project session on refresh — same flow as the Media Manager.
  (async () => {
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
      await load();
    } catch (err) {
      console.error(err);
      clearProjectSession();
      formUI.enable();
      formUI.show();
    }
  })();

  return { showLogin: () => formUI.show() };
}
