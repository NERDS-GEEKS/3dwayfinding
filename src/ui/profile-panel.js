/**
 * Profile — card dashboard front page; each card opens a detail page with Back.
 */

import {
  getAuthSession,
  setAuthSession,
  isSubAdminSession,
  isProjectAdminSession,
} from '../config/auth-session.js';
import { getSuperadminSession, hasSuperadminSession } from '../config/superadmin.js';
import { getPoiType } from '../config/poi-session.js';
import {
  accountGetOwnProfile,
  accountUpdateOwnProfile,
  projectListApiCredentials,
  projectCreateApiCredential,
  projectDeleteApiCredential,
  projectGetApiCredential,
} from '../services/supabase.js';
import { partnerPoisApiUrl } from '../config/partner-api.js';
import { canViewProfileActivity } from '../services/user-logs.js';
import { mountUserLogsReport } from './user-logs-panel.js';
import { createTeamPanel } from './team-panel.js';
import {
  iconEye,
  iconEyeOff,
  iconEdit,
  iconKey,
  iconArrowLeft,
  iconUsers,
  iconChevronRight,
  iconClose,
  iconSave,
  iconCopy,
  iconLock,
  iconAdd,
  iconDelete,
} from './icons.js';
import { showToast } from './toast.js';
import { askConfirm } from './confirm-dialog.js';

/**
 * @returns {{ email: string, password: string, accountId: string, role: string, poiType: string | null } | null}
 */
function profileSession() {
  const session = getAuthSession();
  if (session?.email && session?.password && session?.accountId) {
    return {
      email: session.email,
      password: session.password,
      accountId: String(session.accountId),
      role: String(session.role || ''),
      poiType: session.poiType || getPoiType() || null,
    };
  }
  const sa = getSuperadminSession();
  if (sa?.email && sa?.password && hasSuperadminSession()) {
    return {
      email: String(sa.email),
      password: String(sa.password),
      accountId: String(sa.accountId || ''),
      role: 'superadmin',
      poiType: getPoiType() || null,
    };
  }
  return null;
}

function roleLabel(role) {
  switch (String(role || '')) {
    case 'superadmin':
      return 'Superadmin';
    case 'project_admin':
      return 'Project admin';
    case 'sub_admin':
      return 'Sub-admin';
    default:
      return role || '—';
  }
}

/**
 * @param {string} name
 * @param {string} email
 */
function initialsFrom(name, email) {
  const fromName = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('');
  if (fromName) return fromName.toUpperCase();
  const local = String(email || '').split('@')[0] || '?';
  return local.slice(0, 2).toUpperCase();
}

/**
 * @param {unknown} err
 */
function formatRpcError(err) {
  const raw = String(err?.message ?? err ?? 'Something went wrong');
  let message = raw.replace(/^Database\s+\d+:\s*/i, '').replace(/^Error:\s*/i, '');
  try {
    const parsed = JSON.parse(message);
    if (parsed?.message) message = String(parsed.message);
  } catch {
    /* keep text */
  }
  return message;
}

function canManageAdmins() {
  return (
    !isSubAdminSession() &&
    (isProjectAdminSession() || hasSuperadminSession() || getAuthSession()?.role === 'superadmin')
  );
}

/** @typedef {'dashboard' | 'admins' | 'logs' | 'credentials'} ProfilePage */

/**
 * @param {HTMLElement} container
 */
export function createProfilePanel(container) {
  const panel = document.createElement('div');
  panel.className =
    'profile-panel user-logs-panel user-panel scene-float-panel scene-float-panel--single float-glass drawer-frost hidden';
  panel.id = 'profile-panel';

  panel.innerHTML = `
    <div class="profile-shell">
      <div class="profile-page" data-profile-page="dashboard">
        <section class="profile-card profile-hero-card">
          <div class="profile-hero-main">
            <div class="profile-avatar" data-profile-avatar aria-hidden="true">—</div>
            <div class="profile-hero-copy">
              <h1 class="profile-hero-name" data-profile-name>Profile</h1>
              <div class="profile-hero-chips">
                <span class="profile-chip"><span class="profile-chip-label">Email</span><span data-profile-email>—</span></span>
                <span class="profile-chip"><span class="profile-chip-label">Role</span><span data-profile-role>—</span></span>
                <span class="profile-chip"><span class="profile-chip-label">Project</span><span data-profile-project>—</span></span>
              </div>
              <div class="profile-hero-stats">
                <div class="profile-stat">
                  <strong data-stat-name>—</strong>
                  <span>Display name</span>
                </div>
                <div class="profile-stat">
                  <strong data-stat-role>—</strong>
                  <span>Access</span>
                </div>
                <div class="profile-stat">
                  <strong data-stat-project>—</strong>
                  <span>Workspace</span>
                </div>
              </div>
            </div>
          </div>
          <button type="button" class="profile-hero-edit btn-ripple-host" data-open-dialog="profile" title="Edit profile">
            <span class="profile-hero-edit-icon" aria-hidden="true">${iconEdit()}</span>
            <span>Edit</span>
          </button>
        </section>

        <div class="profile-cards-grid">
          <button type="button" class="profile-card profile-nav-card btn-ripple-host" data-open-dialog="password">
            <div class="profile-nav-card-top">
              <span class="profile-card-icon" aria-hidden="true">${iconKey()}</span>
              <span class="profile-menu-chevron" aria-hidden="true">${iconChevronRight()}</span>
            </div>
            <h2 class="profile-card-title">Security</h2>
            <p class="profile-card-body-text">Change your password. Email stays fixed for this login.</p>
            <div class="profile-card-meta-row">
              <span>Password</span>
              <strong>••••••••</strong>
            </div>
          </button>

          <button type="button" class="profile-card profile-nav-card btn-ripple-host" data-open-page="admins" data-admins-card hidden>
            <div class="profile-nav-card-top">
              <span class="profile-card-icon" aria-hidden="true">${iconUsers()}</span>
              <span class="profile-menu-chevron" aria-hidden="true">${iconChevronRight()}</span>
            </div>
            <h2 class="profile-card-title">Admins</h2>
            <p class="profile-card-body-text">Add and manage sub-admins for this project.</p>
          </button>

          <button type="button" class="profile-card profile-nav-card btn-ripple-host" data-open-page="credentials" data-credentials-card hidden>
            <div class="profile-nav-card-top">
              <span class="profile-card-icon" aria-hidden="true">${iconLock()}</span>
              <span class="profile-menu-chevron" aria-hidden="true">${iconChevronRight()}</span>
            </div>
            <h2 class="profile-card-title">Credentials</h2>
            <p class="profile-card-body-text">Generate named URLs and keys. Export them — keys are shown only once.</p>
          </button>

          <button type="button" class="profile-card profile-nav-card btn-ripple-host" data-open-page="logs">
            <div class="profile-nav-card-top">
              <span class="profile-card-icon" aria-hidden="true">${iconEdit()}</span>
              <span class="profile-menu-chevron" aria-hidden="true">${iconChevronRight()}</span>
            </div>
            <h2 class="profile-card-title">User logs</h2>
            <p class="profile-card-body-text">Review editor activity for this project. Search, filter, and export.</p>
          </button>
        </div>
      </div>

      <div class="profile-page profile-detail-page" data-profile-page="credentials" hidden>
        <button type="button" class="profile-back-btn" data-back-dashboard>
          <span aria-hidden="true">${iconArrowLeft()}</span> Back
        </button>
        <section class="profile-card profile-card--page">
          <header class="profile-card-head">
            <div class="profile-card-title-row">
              <span class="profile-card-icon" aria-hidden="true">${iconLock()}</span>
              <h2 class="profile-card-title">Credentials</h2>
            </div>
            <button type="button" class="access-add-tenant-btn btn-ripple-host profile-cred-generate" data-generate-credential>
              <span class="access-icon-slot" aria-hidden="true">${iconAdd()}</span>
              <span>Generate</span>
            </button>
          </header>
          <p class="profile-card-body-text profile-cred-intro">Create as many credentials as you need. Each key is shown only once after generation — export or copy it before closing.</p>
          <div class="profile-page-body profile-cred-list" id="profile-credentials-host"></div>
        </section>
      </div>

      <div class="profile-page profile-detail-page" data-profile-page="admins" hidden>
        <button type="button" class="profile-back-btn" data-back-dashboard>
          <span aria-hidden="true">${iconArrowLeft()}</span> Back
        </button>
        <section class="profile-card profile-card--page">
          <header class="profile-card-head">
            <div class="profile-card-title-row">
              <span class="profile-card-icon" aria-hidden="true">${iconUsers()}</span>
              <h2 class="profile-card-title">Admins</h2>
            </div>
          </header>
          <div class="profile-page-body profile-admins-host" id="profile-admins-host"></div>
        </section>
      </div>

      <div class="profile-page profile-detail-page" data-profile-page="logs" hidden>
        <button type="button" class="profile-back-btn" data-back-dashboard>
          <span aria-hidden="true">${iconArrowLeft()}</span> Back
        </button>
        <section class="profile-card profile-card--page">
          <header class="profile-card-head">
            <div class="profile-card-title-row">
              <span class="profile-card-icon" aria-hidden="true">${iconEdit()}</span>
              <h2 class="profile-card-title">User logs</h2>
            </div>
          </header>
          <div class="profile-page-body user-logs-report-host" id="profile-logs-host"></div>
        </section>
      </div>
    </div>
  `;

  container.appendChild(panel);

  const editDialog = document.createElement('dialog');
  editDialog.className = 'access-dialog profile-dialog';
  editDialog.id = 'profile-edit-dialog';
  editDialog.innerHTML = `
    <form class="access-dialog-card float-glass" id="profile-edit-form" autocomplete="off">
      <header class="access-dialog-header">
        <div class="access-dialog-heading">
          <span class="access-dialog-icon" aria-hidden="true">${iconEdit()}</span>
          <div>
            <h3>Edit profile</h3>
            <p>Update how your name appears across the dashboard.</p>
          </div>
        </div>
        <button type="button" class="access-dialog-close btn-ripple-host" data-close-dialog aria-label="Close">${iconClose()}</button>
      </header>
      <div class="access-dialog-body">
        <div class="form-group access-form-group">
          <label for="profile-display-name">Display name</label>
          <div class="access-dialog-field-row">
            <input type="text" id="profile-display-name" name="displayName" maxlength="120" placeholder="Your name" />
          </div>
        </div>
        <div class="form-group access-form-group">
          <label for="profile-email-readonly">Email</label>
          <div class="access-dialog-field-row">
            <input type="text" id="profile-email-readonly" data-edit-email-readonly readonly tabindex="-1" />
          </div>
          <p class="access-field-help">Email is fixed for this login and cannot be changed here.</p>
        </div>
        <p class="profile-form-error" data-edit-profile-error hidden></p>
      </div>
      <footer class="access-dialog-actions">
        <button type="button" class="access-action-btn btn-ripple-host" data-close-dialog>
          <span class="access-icon-slot" aria-hidden="true">${iconClose()}</span>
          <span>Cancel</span>
        </button>
        <button type="submit" class="access-save-btn btn-ripple-host" id="profile-save-profile-btn">
          <span class="access-icon-slot" aria-hidden="true">${iconSave()}</span>
          <span>Save profile</span>
        </button>
      </footer>
    </form>
  `;
  document.body.appendChild(editDialog);

  const passwordDialog = document.createElement('dialog');
  passwordDialog.className = 'access-dialog profile-dialog';
  passwordDialog.id = 'profile-password-dialog';
  passwordDialog.innerHTML = `
    <form class="access-dialog-card float-glass" id="profile-password-form" autocomplete="off">
      <header class="access-dialog-header">
        <div class="access-dialog-heading">
          <span class="access-dialog-icon" aria-hidden="true">${iconKey()}</span>
          <div>
            <h3>Edit password</h3>
            <p>Enter your current password, then choose a new one.</p>
          </div>
        </div>
        <button type="button" class="access-dialog-close btn-ripple-host" data-close-dialog aria-label="Close">${iconClose()}</button>
      </header>
      <div class="access-dialog-body">
        <div class="form-group access-form-group">
          <label for="profile-current-password">Current password</label>
          <div class="access-dialog-field-row">
            <input type="password" id="profile-current-password" name="currentPassword" required autocomplete="current-password" />
            <button type="button" class="access-copy-map-btn" data-toggle-password="profile-current-password" title="Show password" aria-label="Show password">${iconEye()}</button>
          </div>
        </div>
        <div class="form-group access-form-group">
          <label for="profile-new-password">New password</label>
          <div class="access-dialog-field-row">
            <input type="password" id="profile-new-password" name="newPassword" required autocomplete="new-password" />
            <button type="button" class="access-copy-map-btn" data-toggle-password="profile-new-password" title="Show password" aria-label="Show password">${iconEye()}</button>
          </div>
        </div>
        <div class="form-group access-form-group">
          <label for="profile-confirm-password">Confirm new password</label>
          <div class="access-dialog-field-row">
            <input type="password" id="profile-confirm-password" name="confirmPassword" required autocomplete="new-password" />
            <button type="button" class="access-copy-map-btn" data-toggle-password="profile-confirm-password" title="Show password" aria-label="Show password">${iconEye()}</button>
          </div>
        </div>
        <p class="profile-form-error" data-edit-password-error hidden></p>
      </div>
      <footer class="access-dialog-actions">
        <button type="button" class="access-action-btn btn-ripple-host" data-close-dialog>
          <span class="access-icon-slot" aria-hidden="true">${iconClose()}</span>
          <span>Cancel</span>
        </button>
        <button type="submit" class="access-save-btn btn-ripple-host" id="profile-save-password-btn">
          <span class="access-icon-slot" aria-hidden="true">${iconSave()}</span>
          <span>Save password</span>
        </button>
      </footer>
    </form>
  `;
  document.body.appendChild(passwordDialog);

  const credDialog = document.createElement('dialog');
  credDialog.className = 'access-dialog profile-dialog';
  credDialog.id = 'profile-credential-dialog';
  credDialog.innerHTML = `
    <form class="access-dialog-card float-glass" id="profile-credential-form" autocomplete="off">
      <header class="access-dialog-header">
        <div class="access-dialog-heading">
          <span class="access-dialog-icon" aria-hidden="true">${iconLock()}</span>
          <div>
            <h3 data-cred-dialog-title>Create new credential</h3>
            <p data-cred-dialog-subtitle>Choose a name and permissions, then copy the URL and key before closing.</p>
          </div>
        </div>
        <button type="button" class="access-dialog-close btn-ripple-host" data-close-cred-dialog aria-label="Close">${iconClose()}</button>
      </header>
      <div class="access-dialog-body" data-cred-step="form">
        <div class="form-group access-form-group">
          <label for="profile-cred-name">Credential name <span class="profile-req">*</span></label>
          <div class="access-dialog-field-row">
            <input type="text" id="profile-cred-name" name="credName" maxlength="120" required placeholder="Name" />
          </div>
        </div>
        <div class="form-group access-form-group profile-cred-perms">
          <label>Permissions</label>
          <div class="profile-cred-perm-toggles" role="group" aria-label="Credential permissions">
            <label class="profile-cred-perm">
              <input type="checkbox" name="scopeQuery" data-scope="query" checked />
              <span class="profile-cred-perm-chip">
                <span class="profile-cred-perm-title">Read</span>
                <span class="profile-cred-perm-desc">List POIs</span>
              </span>
            </label>
            <label class="profile-cred-perm">
              <input type="checkbox" name="scopeWrite" data-scope="write" checked />
              <span class="profile-cred-perm-chip">
                <span class="profile-cred-perm-title">Write</span>
                <span class="profile-cred-perm-desc">Create &amp; edit</span>
              </span>
            </label>
            <label class="profile-cred-perm">
              <input type="checkbox" name="scopeDelete" data-scope="delete" />
              <span class="profile-cred-perm-chip">
                <span class="profile-cred-perm-title">Delete</span>
                <span class="profile-cred-perm-desc">Remove POIs</span>
              </span>
            </label>
          </div>
          <p class="profile-cred-perm-hint">Permissions are locked after the key is created.</p>
        </div>
        <p class="profile-form-error" data-cred-error hidden></p>
      </div>
      <div class="access-dialog-body" data-cred-step="result" hidden>
        <p class="profile-cred-once-warn">Copy these values now. The full key will not be shown again after you close this dialog.</p>
        <div class="profile-cred-result-rows" data-cred-result-rows></div>
      </div>
      <footer class="access-dialog-actions">
        <button type="button" class="access-action-btn btn-ripple-host" data-close-cred-dialog data-cred-cancel>
          <span class="access-icon-slot" aria-hidden="true">${iconClose()}</span>
          <span>Cancel</span>
        </button>
        <button type="submit" class="access-save-btn btn-ripple-host" id="profile-cred-create-btn" data-cred-primary="generate">
          <span class="access-icon-slot" aria-hidden="true">${iconAdd()}</span>
          <span data-cred-primary-label>Generate</span>
        </button>
        <button type="button" class="access-save-btn btn-ripple-host" data-close-cred-dialog data-cred-primary="done" hidden>
          <span>Done</span>
        </button>
      </footer>
    </form>
  `;
  document.body.appendChild(credDialog);

  const editForm = /** @type {HTMLFormElement} */ (editDialog.querySelector('#profile-edit-form'));
  const passwordForm = /** @type {HTMLFormElement} */ (passwordDialog.querySelector('#profile-password-form'));
  const credForm = /** @type {HTMLFormElement} */ (credDialog.querySelector('#profile-credential-form'));
  const credNameInput = /** @type {HTMLInputElement} */ (credDialog.querySelector('#profile-cred-name'));
  const credScopeQuery = /** @type {HTMLInputElement} */ (credDialog.querySelector('[data-scope="query"]'));
  const credScopeWrite = /** @type {HTMLInputElement} */ (credDialog.querySelector('[data-scope="write"]'));
  const credScopeDelete = /** @type {HTMLInputElement} */ (credDialog.querySelector('[data-scope="delete"]'));
  const credError = /** @type {HTMLElement} */ (credDialog.querySelector('[data-cred-error]'));
  const credCreateBtn = /** @type {HTMLButtonElement} */ (credDialog.querySelector('#profile-cred-create-btn'));
  const credDoneBtn = /** @type {HTMLButtonElement} */ (credDialog.querySelector('[data-cred-primary="done"]'));
  const credCancelBtn = /** @type {HTMLButtonElement} */ (credDialog.querySelector('[data-cred-cancel]'));
  const credFormStep = /** @type {HTMLElement} */ (credDialog.querySelector('[data-cred-step="form"]'));
  const credResultStep = /** @type {HTMLElement} */ (credDialog.querySelector('[data-cred-step="result"]'));
  const credResultRows = /** @type {HTMLElement} */ (credDialog.querySelector('[data-cred-result-rows]'));
  const displayNameInput = /** @type {HTMLInputElement} */ (editDialog.querySelector('#profile-display-name'));
  const currentPasswordInput = /** @type {HTMLInputElement} */ (passwordDialog.querySelector('#profile-current-password'));
  const newPasswordInput = /** @type {HTMLInputElement} */ (passwordDialog.querySelector('#profile-new-password'));
  const confirmPasswordInput = /** @type {HTMLInputElement} */ (passwordDialog.querySelector('#profile-confirm-password'));
  const editProfileError = /** @type {HTMLElement} */ (editDialog.querySelector('[data-edit-profile-error]'));
  const editPasswordError = /** @type {HTMLElement} */ (passwordDialog.querySelector('[data-edit-password-error]'));
  const saveProfileBtn = /** @type {HTMLButtonElement} */ (editDialog.querySelector('#profile-save-profile-btn'));
  const savePasswordBtn = /** @type {HTMLButtonElement} */ (passwordDialog.querySelector('#profile-save-password-btn'));
  const logsHost = /** @type {HTMLElement | null} */ (panel.querySelector('#profile-logs-host'));
  const credentialsHost = /** @type {HTMLElement | null} */ (panel.querySelector('#profile-credentials-host'));
  const adminsHost = /** @type {HTMLElement | null} */ (panel.querySelector('#profile-admins-host'));
  const avatarEl = /** @type {HTMLElement | null} */ (panel.querySelector('[data-profile-avatar]'));
  const nameEl = /** @type {HTMLElement | null} */ (panel.querySelector('[data-profile-name]'));
  const emailEl = /** @type {HTMLElement | null} */ (panel.querySelector('[data-profile-email]'));
  const roleEl = /** @type {HTMLElement | null} */ (panel.querySelector('[data-profile-role]'));
  const projectEl = /** @type {HTMLElement | null} */ (panel.querySelector('[data-profile-project]'));
  const statName = /** @type {HTMLElement | null} */ (panel.querySelector('[data-stat-name]'));
  const statRole = /** @type {HTMLElement | null} */ (panel.querySelector('[data-stat-role]'));
  const statProject = /** @type {HTMLElement | null} */ (panel.querySelector('[data-stat-project]'));
  const editEmailReadonly = /** @type {HTMLInputElement | null} */ (editDialog.querySelector('[data-edit-email-readonly]'));
  const adminsCard = /** @type {HTMLElement | null} */ (panel.querySelector('[data-admins-card]'));
  const credentialsCard = /** @type {HTMLElement | null} */ (panel.querySelector('[data-credentials-card]'));

  /** @type {{ refresh: () => Promise<void>, destroy: () => void } | null} */
  let logsReport = null;
  /** @type {{ show: () => void, hide: () => void, refresh: () => Promise<void> | void } | null} */
  let teamPanel = null;
  /** @type {ProfilePage} */
  let currentPage = 'dashboard';
  /** @type {{ displayName: string, email: string, role: string, poiType: string | null }} */
  let cachedProfile = { displayName: '', email: '', role: '', poiType: null };
  /** @type {Array<Record<string, unknown>>} */
  let credentialRows = [];
  /** @type {{ name: string, shareUrl: string, apiKey: string } | null} */
  let createdCredential = null;

  if (adminsHost) {
    teamPanel = createTeamPanel(adminsHost, { embedded: true });
  }

  function syncAdminsVisibility() {
    const allow = canManageAdmins();
    if (adminsCard) adminsCard.hidden = !allow;
    if (credentialsCard) credentialsCard.hidden = !allow;
    return allow;
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function maskKeyPrefix(prefix) {
    const raw = String(prefix ?? '');
    if (!raw) return 'nm_••••••••';
    return `${raw}${'•'.repeat(12)}`;
  }

  async function copyText(value, label) {
    const text = String(value ?? '').trim();
    if (!text || text === '—') {
      showToast(`Nothing to copy for ${label}`, 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast(`${label} copied`, 'success');
    } catch {
      showToast(`Could not copy ${label.toLowerCase()}`, 'error');
    }
  }

  function downloadText(filename, body) {
    const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function safeFileSlug(value) {
    return String(value || 'navme')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'navme';
  }

  function safeFileSlug(value) {
    return String(value || 'navme')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'navme';
  }

  function exportOneCredential(row, fullKey = '') {
    const name = String(row.name || 'credential');
    const shareUrl = String(row.share_url || row.shareUrl || '');
    const publicId = String(row.public_id || '');
    const apiUrl = partnerPoisApiUrl(publicId) || String(row.api_url || '');
    const key = String(fullKey || row.api_key || '').trim();
    const keyLine = key
      ? `NavMe Key: ${key}`
      : `NavMe Key: ${maskKeyPrefix(row.key_prefix)}`;
    downloadText(
      `${safeFileSlug(name)}-credential.txt`,
      [
        `Name: ${name}`,
        `URL: ${shareUrl || '—'}`,
        `NavMe API: ${apiUrl || '—'}`,
        `Access: ${formatScopes(row)}`,
        keyLine,
        '',
        'Fetch POIs (Read):',
        `curl -sS '${apiUrl || 'https://api.navme.space/partner-pois?id=…'}' -H 'X-NavMe-Key: ${key || 'YOUR_NAVME_KEY'}'`,
      ].join('\n'),
    );
    showToast('Credential exported', 'success');
  }

  async function exportCredentialById(row) {
    const session = profileSession();
    if (!session || !row?.id) {
      showToast('Could not export credential', 'error');
      return;
    }
    try {
      const full = await projectGetApiCredential({
        email: session.email,
        password: session.password,
        credentialId: row.id,
        poiType: session.poiType,
      });
      if (!full) {
        showToast('Credential not found', 'error');
        return;
      }
      exportOneCredential(full, String(full.api_key || ''));
    } catch (err) {
      showToast(formatRpcError(err), 'error');
    }
  }

  function setCredDialogMode(mode) {
    const isResult = mode === 'result';
    credDialog.classList.toggle('is-cred-result', isResult);
    credFormStep.hidden = isResult;
    credResultStep.hidden = !isResult;
    credCreateBtn.hidden = isResult;
    credDoneBtn.hidden = !isResult;
    if (credCancelBtn) credCancelBtn.hidden = isResult;
    credNameInput.disabled = isResult;
    const title = credDialog.querySelector('[data-cred-dialog-title]');
    const subtitle = credDialog.querySelector('[data-cred-dialog-subtitle]');
    if (title) title.textContent = isResult ? 'Credential ready' : 'Create new credential';
    if (subtitle) {
      subtitle.textContent = isResult
        ? 'Copy these values now. Closing hides the full key.'
        : 'Choose a name and permissions, then copy the URL and key before closing.';
    }
  }

  function resetCredScopeInputs() {
    if (credScopeQuery) credScopeQuery.checked = true;
    if (credScopeWrite) credScopeWrite.checked = true;
    if (credScopeDelete) credScopeDelete.checked = false;
  }

  function selectedScopes() {
    return {
      query: Boolean(credScopeQuery?.checked),
      write: Boolean(credScopeWrite?.checked),
      delete: Boolean(credScopeDelete?.checked),
    };
  }

  function formatScopes(row) {
    const parts = [];
    if (row?.scope_query) parts.push('Read');
    if (row?.scope_write) parts.push('Write');
    if (row?.scope_delete) parts.push('Delete');
    return parts.length ? parts.join(', ') : 'None';
  }

  function closeCredDialog() {
    if (credDialog.open) credDialog.close();
    createdCredential = null;
    credForm.reset();
    resetCredScopeInputs();
    setError(credError, '');
    setCredDialogMode('form');
  }

  function openGenerateDialog() {
    if (!canManageAdmins()) {
      showToast('Only project admins can generate credentials', 'error');
      return;
    }
    if (editDialog.open) editDialog.close();
    if (passwordDialog.open) passwordDialog.close();
    createdCredential = null;
    credForm.reset();
    resetCredScopeInputs();
    setError(credError, '');
    setCredDialogMode('form');
    if (!credDialog.open) credDialog.showModal();
    credNameInput.focus();
  }

  function renderCreatedCredential(row) {
    const shareUrl = String(row.share_url ?? '');
    const apiKey = String(row.api_key ?? '');
    const publicId = String(row.public_id ?? '');
    const apiUrl = partnerPoisApiUrl(publicId);
    const access = formatScopes(row);
    createdCredential = {
      name: String(row.name ?? ''),
      shareUrl,
      apiKey,
      apiUrl,
    };
    const displayRows = [
      { label: 'Name', value: createdCredential.name, copyable: false },
      { label: 'Access', value: access, copyable: false },
      { label: 'URL', value: shareUrl, copyable: true },
      { label: 'NavMe API', value: apiUrl, copyable: true },
      { label: 'NavMe Key', value: apiKey, copyable: true },
    ];
    const copyAllText = [
      `URL: ${shareUrl}`,
      `NavMe API: ${apiUrl}`,
      `NavMe Key: ${apiKey}`,
    ].join('\n');

    credResultRows.innerHTML =
      displayRows
        .map((item) => {
          const actions = item.copyable
            ? `<span class="profile-cred-actions">
                <button type="button" class="access-copy-map-btn" data-copy="${escapeHtml(item.value)}" data-copy-label="${escapeHtml(item.label)}" title="Copy ${escapeHtml(item.label)}">${iconCopy()}</button>
              </span>`
            : `<span class="profile-cred-actions"></span>`;
          return `
          <div class="profile-cred-row${item.copyable ? '' : ' profile-cred-row--display'}">
            <span class="profile-cred-label">${escapeHtml(item.label)}</span>
            <code class="profile-cred-value" title="${escapeHtml(item.value)}">${escapeHtml(item.value || '—')}</code>
            ${actions}
          </div>`;
        })
        .join('') +
      `
      <div class="profile-cred-copy-all">
        <button type="button" class="access-action-btn btn-ripple-host" data-copy-all-creds>
          <span class="access-icon-slot" aria-hidden="true">${iconCopy()}</span>
          <span>Copy all</span>
        </button>
      </div>`;

    credResultRows.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', () => {
        copyText(btn.getAttribute('data-copy'), btn.getAttribute('data-copy-label') || 'Value');
      });
    });
    credResultRows.querySelector('[data-copy-all-creds]')?.addEventListener('click', () => {
      copyText(copyAllText, 'Credentials');
    });
    setCredDialogMode('result');
  }

  async function renderCredentials() {
    if (!credentialsHost) return;
    if (!canManageAdmins()) {
      credentialsHost.innerHTML = `<div class="access-empty team-empty"><p>Only project admins can manage credentials.</p></div>`;
      return;
    }
    const session = profileSession();
    if (!session) {
      credentialsHost.innerHTML = `<div class="access-empty team-empty"><p>Sign in to manage credentials.</p></div>`;
      return;
    }
    credentialsHost.innerHTML = `<p class="profile-card-body-text">Loading credentials…</p>`;
    try {
      credentialRows = await projectListApiCredentials({
        email: session.email,
        password: session.password,
        poiType: session.poiType,
      });
    } catch (err) {
      console.error(err);
      credentialsHost.innerHTML = `<div class="access-empty team-empty"><p>${escapeHtml(formatRpcError(err))}</p></div>`;
      return;
    }

    if (!credentialRows.length) {
      credentialsHost.innerHTML = `
        <div class="access-empty team-empty">
          <span class="access-empty-icon" aria-hidden="true">${iconLock()}</span>
          <p>No credentials yet.</p>
          <button type="button" class="access-add-tenant-btn btn-ripple-host" data-empty-generate>
            <span class="access-icon-slot" aria-hidden="true">${iconAdd()}</span>
            <span>Generate credential</span>
          </button>
        </div>`;
      credentialsHost.querySelector('[data-empty-generate]')?.addEventListener('click', () => openGenerateDialog());
      return;
    }

    credentialsHost.innerHTML = credentialRows
      .map((row) => {
        const id = String(row.id ?? '');
        const name = String(row.name ?? '');
        const shareUrl = String(row.share_url ?? '');
        const publicId = String(row.public_id ?? '');
        const apiUrl = partnerPoisApiUrl(publicId);
        const keyDisplay = maskKeyPrefix(row.key_prefix);
        return `
          <article class="profile-cred-card" data-cred-id="${escapeHtml(id)}">
            <div class="profile-cred-card-head">
              <h3 class="profile-cred-card-title" title="${escapeHtml(name)}">${escapeHtml(name)}</h3>
              <div class="profile-cred-card-actions">
                <button type="button" class="access-action-btn" data-export-cred>Export</button>
                <button type="button" class="access-action-btn access-action-btn--danger" data-delete-cred title="Delete credential">
                  <span class="access-icon-slot" aria-hidden="true">${iconDelete()}</span>
                  <span>Delete</span>
                </button>
              </div>
            </div>
            <div class="profile-cred-row">
              <span class="profile-cred-label">URL</span>
              <code class="profile-cred-value" title="${escapeHtml(shareUrl)}">${escapeHtml(shareUrl || '—')}</code>
              <span class="profile-cred-actions">
                <button type="button" class="access-copy-map-btn" data-copy="${escapeHtml(shareUrl)}" data-copy-label="URL" title="Copy URL">${iconCopy()}</button>
              </span>
            </div>
            <div class="profile-cred-row">
              <span class="profile-cred-label">NavMe API</span>
              <code class="profile-cred-value" title="${escapeHtml(apiUrl)}">${escapeHtml(apiUrl || '—')}</code>
              <span class="profile-cred-actions">
                <button type="button" class="access-copy-map-btn" data-copy="${escapeHtml(apiUrl)}" data-copy-label="NavMe API" title="Copy NavMe API"${apiUrl ? '' : ' disabled'}>${iconCopy()}</button>
              </span>
            </div>
            <div class="profile-cred-row">
              <span class="profile-cred-label">Access</span>
              <code class="profile-cred-value">${escapeHtml(formatScopes(row))}</code>
              <span class="profile-cred-actions"></span>
            </div>
            <div class="profile-cred-row">
              <span class="profile-cred-label">NavMe Key</span>
              <code class="profile-cred-value">${escapeHtml(keyDisplay)}</code>
              <span class="profile-cred-actions"></span>
            </div>
          </article>`;
      })
      .join('');

    credentialsHost.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', () => {
        copyText(btn.getAttribute('data-copy'), btn.getAttribute('data-copy-label') || 'Value');
      });
    });
    credentialsHost.querySelectorAll('[data-export-cred]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const card = btn.closest('[data-cred-id]');
        const row = credentialRows.find((r) => String(r.id) === String(card?.getAttribute('data-cred-id')));
        if (row) void exportCredentialById(row);
      });
    });
    credentialsHost.querySelectorAll('[data-delete-cred]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const card = btn.closest('[data-cred-id]');
        const row = credentialRows.find((r) => String(r.id) === String(card?.getAttribute('data-cred-id')));
        if (!row) return;
        const ok = await askConfirm({
          title: 'Delete credential?',
          message: `Are you sure you want to delete "${row.name}"? This cannot be undone.`,
          confirmLabel: 'Delete',
          cancelLabel: 'Cancel',
          danger: true,
        });
        if (!ok) return;
        const sessionCreds = profileSession();
        if (!sessionCreds) return;
        btn.disabled = true;
        try {
          await projectDeleteApiCredential({
            email: sessionCreds.email,
            password: sessionCreds.password,
            credentialId: row.id,
            poiType: sessionCreds.poiType,
          });
          showToast('Credential deleted', 'success');
          await renderCredentials();
        } catch (err) {
          showToast(formatRpcError(err), 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  /**
   * @param {HTMLElement | null} el
   * @param {string} message
   */
  function setError(el, message) {
    if (!el) return;
    if (!message) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = message;
  }

  /**
   * @param {string} displayName
   * @param {string} email
   * @param {string} role
   * @param {string | null} poiType
   */
  function renderOverview(displayName, email, role, poiType) {
    cachedProfile = { displayName, email, role, poiType };
    const label = displayName || email.split('@')[0] || 'Profile';
    const access = roleLabel(role);
    const project = poiType || '—';
    if (avatarEl) avatarEl.textContent = initialsFrom(displayName, email);
    if (nameEl) nameEl.textContent = label;
    if (emailEl) emailEl.textContent = email || '—';
    if (roleEl) roleEl.textContent = access;
    if (projectEl) projectEl.textContent = project;
    if (statName) statName.textContent = displayName || '—';
    if (statRole) statRole.textContent = access;
    if (statProject) statProject.textContent = project;
    if (editEmailReadonly) editEmailReadonly.value = email || '';
  }

  /**
   * @param {ProfilePage} page
   */
  function openPage(page) {
    if (page === 'admins' && !syncAdminsVisibility()) {
      openPage('dashboard');
      return;
    }

    currentPage = page;
    panel.querySelectorAll('[data-profile-page]').forEach((el) => {
      el.hidden = el.getAttribute('data-profile-page') !== page;
    });

    if (page === 'dashboard') {
      teamPanel?.hide();
      syncAdminsVisibility();
      return;
    }

    if (page === 'admins') {
      teamPanel?.show();
      return;
    }

    if (page === 'credentials') {
      teamPanel?.hide();
      void renderCredentials();
      return;
    }

    if (page === 'logs') {
      teamPanel?.hide();
      void ensureLogs()?.refresh();
    }
  }

  function closeDialogs() {
    if (editDialog.open) editDialog.close();
    if (passwordDialog.open) passwordDialog.close();
    if (credDialog.open) closeCredDialog();
  }

  /**
   * @param {'profile' | 'password'} which
   */
  function openDialog(which) {
    if (editDialog.open) editDialog.close();
    if (passwordDialog.open) passwordDialog.close();
    if (credDialog.open) closeCredDialog();
    if (which === 'profile') {
      setError(editProfileError, '');
      displayNameInput.value = cachedProfile.displayName || '';
      if (editEmailReadonly) editEmailReadonly.value = cachedProfile.email || '';
      editDialog.showModal();
      displayNameInput.focus();
      return;
    }
    setError(editPasswordError, '');
    currentPasswordInput.value = '';
    newPasswordInput.value = '';
    confirmPasswordInput.value = '';
    passwordDialog.showModal();
    currentPasswordInput.focus();
  }

  function ensureLogs() {
    if (!logsHost || !canViewProfileActivity()) return null;
    if (!logsReport) {
      const ownOnly = isSubAdminSession();
      logsReport = mountUserLogsReport(logsHost, {
        global: false,
        showTitle: false,
        ownOnly,
      });
    }
    return logsReport;
  }

  async function loadAccount() {
    const creds = profileSession();
    if (!creds) {
      renderOverview('', '', '', null);
      return;
    }
    renderOverview('', creds.email, creds.role, creds.poiType);
    try {
      const profile = await accountGetOwnProfile({
        email: creds.email,
        password: creds.password,
      });
      renderOverview(
        profile.displayName || '',
        profile.email || creds.email,
        creds.role,
        creds.poiType,
      );
    } catch (err) {
      console.warn('[profile] load failed:', err);
    }
  }

  panel.querySelectorAll('[data-open-page]').forEach((el) => {
    el.addEventListener('click', () => {
      const page = /** @type {ProfilePage} */ (el.getAttribute('data-open-page') || 'dashboard');
      openPage(page);
    });
  });

  panel.querySelectorAll('[data-open-dialog]').forEach((el) => {
    el.addEventListener('click', () => {
      const which = el.getAttribute('data-open-dialog') === 'password' ? 'password' : 'profile';
      openDialog(which);
    });
  });

  panel.querySelectorAll('[data-back-dashboard]').forEach((btn) => {
    btn.addEventListener('click', () => openPage('dashboard'));
  });

  panel.querySelector('[data-generate-credential]')?.addEventListener('click', () => {
    openGenerateDialog();
  });

  [editDialog, passwordDialog].forEach((dlg) => {
    dlg.addEventListener('click', (e) => {
      if (e.target.closest('[data-close-dialog]')) {
        if (editDialog.open) editDialog.close();
        if (passwordDialog.open) passwordDialog.close();
      }
    });
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      if (editDialog.open) editDialog.close();
      if (passwordDialog.open) passwordDialog.close();
    });
  });

  credDialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-cred-dialog]')) {
      const hadCreated = Boolean(createdCredential);
      closeCredDialog();
      if (hadCreated && currentPage === 'credentials') void renderCredentials();
    }
  });
  credDialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    const hadCreated = Boolean(createdCredential);
    closeCredDialog();
    if (hadCreated && currentPage === 'credentials') void renderCredentials();
  });

  credForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (createdCredential) return;
    const session = profileSession();
    if (!session) {
      setError(credError, 'Sign in to generate credentials.');
      return;
    }
    const name = credNameInput.value.trim();
    if (!name) {
      setError(credError, 'Enter a name for this credential.');
      return;
    }
    const scopes = selectedScopes();
    if (!scopes.query && !scopes.write && !scopes.delete) {
      setError(credError, 'Select at least one permission.');
      return;
    }
    credCreateBtn.disabled = true;
    setError(credError, '');
    try {
      const row = await projectCreateApiCredential({
        email: session.email,
        password: session.password,
        name,
        poiType: session.poiType,
        scopeQuery: scopes.query,
        scopeWrite: scopes.write,
        scopeDelete: scopes.delete,
      });
      renderCreatedCredential(row);
      showToast('Credential generated', 'success');
    } catch (err) {
      setError(credError, formatRpcError(err));
      showToast('Could not generate credential', 'error');
    } finally {
      credCreateBtn.disabled = false;
    }
  });

  passwordDialog.querySelectorAll('[data-toggle-password]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-toggle-password');
      const input = id
        ? /** @type {HTMLInputElement | null} */ (passwordDialog.querySelector(`#${id}`))
        : null;
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.innerHTML = show ? iconEyeOff() : iconEye();
      btn.title = show ? 'Hide password' : 'Show password';
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
  });

  editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const creds = profileSession();
    if (!creds) {
      setError(editProfileError, 'Sign in to edit your profile.');
      return;
    }
    const displayName = displayNameInput.value.trim();
    saveProfileBtn.disabled = true;
    setError(editProfileError, '');
    try {
      const updated = await accountUpdateOwnProfile({
        email: creds.email,
        password: creds.password,
        displayName,
        newEmail: null,
        newPassword: null,
      });
      renderOverview(updated.displayName || '', updated.email, creds.role, creds.poiType);
      showToast('Profile updated', 'success');
      closeDialogs();
    } catch (err) {
      setError(editProfileError, formatRpcError(err));
      showToast('Could not update profile', 'error');
    } finally {
      saveProfileBtn.disabled = false;
    }
  });

  passwordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const creds = profileSession();
    if (!creds) {
      setError(editPasswordError, 'Sign in to change your password.');
      return;
    }
    const currentPassword = currentPasswordInput.value;
    const newPassword = newPasswordInput.value;
    const confirmPassword = confirmPasswordInput.value;
    if (!currentPassword) {
      setError(editPasswordError, 'Enter your current password.');
      return;
    }
    if (!newPassword) {
      setError(editPasswordError, 'Enter a new password.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(editPasswordError, 'New password and confirmation do not match.');
      return;
    }

    savePasswordBtn.disabled = true;
    setError(editPasswordError, '');
    try {
      await accountUpdateOwnProfile({
        email: creds.email,
        password: currentPassword,
        displayName: null,
        newEmail: null,
        newPassword,
      });
      const session = getAuthSession();
      if (session) {
        setAuthSession({
          ...session,
          password: newPassword,
        });
      }
      currentPasswordInput.value = '';
      newPasswordInput.value = '';
      confirmPasswordInput.value = '';
      showToast('Password updated', 'success');
      closeDialogs();
    } catch (err) {
      setError(editPasswordError, formatRpcError(err));
      showToast('Could not update password', 'error');
    } finally {
      savePasswordBtn.disabled = false;
    }
  });

  return {
    show(opts = {}) {
      const canOpen =
        isProjectAdminSession() ||
        isSubAdminSession() ||
        hasSuperadminSession() ||
        getAuthSession()?.role === 'superadmin';
      if (!canOpen) {
        panel.classList.add('hidden');
        return;
      }
      panel.classList.remove('hidden');
      void loadAccount();
      if (opts.tab === 'admins') openPage('admins');
      else if (opts.tab === 'logs') openPage('logs');
      else openPage('dashboard');
    },
    hide() {
      panel.classList.add('hidden');
      closeDialogs();
      teamPanel?.hide();
    },
    openAdmins() {
      this.show({ tab: 'admins' });
    },
    refresh() {
      void loadAccount();
      if (currentPage === 'admins') return teamPanel?.refresh?.();
      if (currentPage === 'logs') return ensureLogs()?.refresh();
      if (currentPage === 'credentials') return renderCredentials();
      return undefined;
    },
  };
}
