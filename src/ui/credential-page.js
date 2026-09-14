/**
 * Public credential landing page — `/c/:publicId` on dashboard.navme.space
 */

import { getCredentialPublicIdFromPath } from '../app-routes.js';
import { resolveProjectApiCredential } from '../services/supabase.js';
import { partnerPoisApiUrl } from '../config/partner-api.js';
import { initTheme } from '../config/theme.js';
import { iconLock, iconCopy } from './icons.js';
import { showToast } from './toast.js';

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {HTMLElement} container
 */
export function initCredentialPage(container) {
  initTheme();
  container.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'credential-share-page glass-shell';
  page.innerHTML = `
    <header class="credential-share-topbar">
      <img src="/NavMe_wb.png" alt="NavMe" class="topbar-logo-img" />
      <span class="credential-share-brand">NavMe API credential</span>
    </header>
    <main class="credential-share-main">
      <section class="credential-share-card float-glass" data-cred-panel>
        <p class="credential-share-loading">Loading credential…</p>
      </section>
    </main>
  `;
  container.appendChild(page);

  const panel = /** @type {HTMLElement} */ (page.querySelector('[data-cred-panel]'));
  const publicId = getCredentialPublicIdFromPath();

  void (async () => {
    if (!publicId) {
      panel.innerHTML = `
        <span class="credential-share-icon" aria-hidden="true">${iconLock()}</span>
        <h1>Credential not found</h1>
        <p>This link is missing a credential id.</p>`;
      return;
    }
    try {
      const row = await resolveProjectApiCredential(publicId);
      if (!row) throw new Error('Credential not found');
      const name = String(row.name ?? 'Credential');
      const project = String(row.poi_type ?? '—');
      const shareUrl = String(row.share_url ?? window.location.href);
      const scopes = [
        row.scope_query ? 'Read' : null,
        row.scope_write ? 'Write' : null,
        row.scope_delete ? 'Delete' : null,
      ]
        .filter(Boolean)
        .join(', ') || 'None';
      const apiUrl = partnerPoisApiUrl(String(row.public_id ?? publicId));
      const curl = `curl -sS '${apiUrl}' \\\n  -H 'X-NavMe-Key: YOUR_NAVME_KEY'`;
      panel.innerHTML = `
        <span class="credential-share-icon" aria-hidden="true">${iconLock()}</span>
        <p class="credential-share-kicker">Valid API credential</p>
        <h1>${escapeHtml(name)}</h1>
        <p class="credential-share-lead">Use the API endpoint with your NavMe Key. Permissions are fixed at creation and cannot be changed.</p>
        <dl class="credential-share-meta">
          <div>
            <dt>Project</dt>
            <dd>${escapeHtml(project)}</dd>
          </div>
          <div>
            <dt>Access</dt>
            <dd>${escapeHtml(scopes)}</dd>
          </div>
          <div>
            <dt>Page URL</dt>
            <dd>
              <code title="${escapeHtml(shareUrl)}">${escapeHtml(shareUrl)}</code>
              <button type="button" class="access-copy-map-btn" data-copy="${escapeHtml(shareUrl)}" data-copy-label="Page URL" title="Copy page URL">${iconCopy()}</button>
            </dd>
          </div>
          <div>
            <dt>NavMe API</dt>
            <dd>
              <code title="${escapeHtml(apiUrl)}">${escapeHtml(apiUrl || '—')}</code>
              <button type="button" class="access-copy-map-btn" data-copy="${escapeHtml(apiUrl)}" data-copy-label="NavMe API" title="Copy NavMe API URL"${apiUrl ? '' : ' disabled'}>${iconCopy()}</button>
            </dd>
          </div>
          <div>
            <dt>Credential id</dt>
            <dd><code>${escapeHtml(String(row.public_id ?? publicId))}</code></dd>
          </div>
        </dl>
        <div class="credential-share-example">
          <div class="credential-share-example-head">
            <span>Example</span>
            <button type="button" class="access-copy-map-btn" data-copy="${escapeHtml(curl)}" data-copy-label="Example" title="Copy example">${iconCopy()}</button>
          </div>
          <pre><code>${escapeHtml(curl)}</code></pre>
        </div>
        <div class="credential-share-try">
          <label for="credential-try-key">Try with your NavMe Key</label>
          <div class="credential-share-try-row">
            <input id="credential-try-key" type="password" autocomplete="off" spellcheck="false" placeholder="nm_…" />
            <button type="button" class="access-save-btn" data-try-pois>Fetch POIs</button>
          </div>
          <p class="credential-share-try-meta" data-try-meta hidden></p>
          <ul class="credential-share-poi-list" data-try-list hidden></ul>
        </div>`;

      panel.querySelectorAll('[data-copy]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const text = btn.getAttribute('data-copy') || '';
          const label = btn.getAttribute('data-copy-label') || 'Value';
          if (!text) return;
          try {
            await navigator.clipboard.writeText(text);
            showToast(`${label} copied`, 'success');
          } catch {
            showToast(`Could not copy ${label.toLowerCase()}`, 'error');
          }
        });
      });

      const tryBtn = /** @type {HTMLButtonElement | null} */ (panel.querySelector('[data-try-pois]'));
      const tryInput = /** @type {HTMLInputElement | null} */ (panel.querySelector('#credential-try-key'));
      const tryMeta = /** @type {HTMLElement | null} */ (panel.querySelector('[data-try-meta]'));
      const tryList = /** @type {HTMLElement | null} */ (panel.querySelector('[data-try-list]'));
      tryBtn?.addEventListener('click', async () => {
        const key = String(tryInput?.value || '').trim();
        if (!key) {
          showToast('Enter your NavMe Key', 'error');
          return;
        }
        if (!apiUrl) {
          showToast('NavMe API URL unavailable', 'error');
          return;
        }
        tryBtn.disabled = true;
        try {
          const res = await fetch(apiUrl, {
            headers: { 'X-NavMe-Key': key },
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(payload?.error || `Request failed (${res.status})`);
          }
          const pois = Array.isArray(payload?.pois) ? payload.pois : [];
          if (tryMeta) {
            tryMeta.hidden = false;
            tryMeta.textContent = `${payload?.count ?? pois.length} POIs · ${payload?.project || project}`;
          }
          if (tryList) {
            tryList.hidden = false;
            tryList.innerHTML = pois.length
              ? pois
                  .slice(0, 40)
                  .map((p) => `<li>${escapeHtml(p?.name || 'Untitled')}</li>`)
                  .join('')
              : '<li class="credential-share-empty">No POIs for this project.</li>';
          }
          showToast('POIs loaded', 'success');
        } catch (err) {
          if (tryMeta) {
            tryMeta.hidden = false;
            tryMeta.textContent = err instanceof Error ? err.message : 'Request failed';
          }
          if (tryList) {
            tryList.hidden = true;
            tryList.innerHTML = '';
          }
          showToast(err instanceof Error ? err.message : 'Could not fetch POIs', 'error');
        } finally {
          tryBtn.disabled = false;
        }
      });
    } catch (err) {
      console.warn('[credential page]', err);
      panel.innerHTML = `
        <span class="credential-share-icon" aria-hidden="true">${iconLock()}</span>
        <h1>Credential not found</h1>
        <p>This credential link is invalid or has been removed.</p>`;
    }
  })();
}
