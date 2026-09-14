/**
 * The wayfinding chat — ask for a place in plain words, get routed to it.
 *
 * Deliberately thin: this file owns the conversation surface and nothing else.
 * Deciding *which* place answers "I'm hungry" lives in
 * `../ai/wayfinding-assistant.js`, and actually drawing the route stays with
 * the page, which already owns the pickers, the navmesh and the Matterport
 * view. The chat reaches them through the two callbacks it is handed, so it
 * cannot get the route into a state the pickers disagree with.
 *
 * Answers are rendered the moment they are computed. There is no typing
 * animation: matching is synchronous and local, and pretending to think would
 * only delay someone who is standing in a corridor waiting to be told where
 * to go.
 */

import { answerMessage, QUICK_ASKS } from '../ai/wayfinding-assistant.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMetres(m) {
  if (!Number.isFinite(m)) return '';
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  if (m >= 100) return `${Math.round(m)} m`;
  return `${m.toFixed(1)} m`;
}

/**
 * @param {HTMLElement} mount element the launcher and panel are appended to
 * @param {{
 *   getContext: () => object,  // POIs + distance/floor lookups, read per message
 *   onNavigate: (idx: number) => void,
 *   onClear?: () => void,
 * }} opts
 */
export function initWayfindingChat(mount, opts) {
  const { getContext, onNavigate, onClear } = opts;

  const host = document.createElement('div');
  host.className = 'wf-chat';
  host.innerHTML = `
    <button type="button" class="wf-chat-fab" id="wf-chat-fab"
            aria-expanded="false" aria-controls="wf-chat-panel" title="Ask for a place">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
      </svg>
      <span>Ask</span>
    </button>

    <section class="wf-chat-panel" id="wf-chat-panel" hidden
             role="dialog" aria-modal="false" aria-labelledby="wf-chat-title">
      <header class="wf-chat-head">
        <div class="wf-chat-head-text">
          <strong class="wf-chat-title" id="wf-chat-title">Ask NavMe</strong>
          <span class="wf-chat-sub">Tell me what you need — I’ll route you there</span>
        </div>
        <button type="button" class="wf-chat-close" id="wf-chat-close" aria-label="Close chat">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
          </svg>
        </button>
      </header>

      <div class="wf-chat-log" id="wf-chat-log" role="log" aria-live="polite" aria-atomic="false"></div>

      <div class="wf-chat-quick" id="wf-chat-quick"></div>

      <form class="wf-chat-form" id="wf-chat-form">
        <input type="text" class="wf-chat-input" id="wf-chat-input"
               placeholder="e.g. I’m hungry" autocomplete="off"
               autocapitalize="sentences" spellcheck="false" aria-label="Ask for a place" />
        <button type="submit" class="wf-chat-send" aria-label="Send">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6"/>
          </svg>
        </button>
      </form>
    </section>
  `;
  mount.appendChild(host);

  const fab = host.querySelector('#wf-chat-fab');
  const panel = host.querySelector('#wf-chat-panel');
  const log = host.querySelector('#wf-chat-log');
  const quick = host.querySelector('#wf-chat-quick');
  const form = host.querySelector('#wf-chat-form');
  const input = host.querySelector('#wf-chat-input');

  /** Indices offered by the last answer, so "yes" knows what it means. */
  let lastOffer = [];
  let greeted = false;

  function scrollToEnd() {
    // After paint, or the new row's height is not in the scroll extent yet.
    requestAnimationFrame(() => {
      log.scrollTop = log.scrollHeight;
    });
  }

  function addBubble(who, text) {
    const row = document.createElement('div');
    row.className = `wf-chat-msg is-${who}`;
    row.innerHTML = `<p class="wf-chat-bubble">${escapeHtml(text)}</p>`;
    log.appendChild(row);
    scrollToEnd();
    return row;
  }

  /**
   * Results are buttons, not links: tapping one is the whole point of asking,
   * so the answer and the action are the same object.
   */
  function addResults(results) {
    if (!results.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'wf-chat-results';
    wrap.innerHTML = results
      .map((r) => {
        const meta = [r.note, r.floor].filter(Boolean).join(' · ');
        const dist = Number.isFinite(r.distance) ? formatMetres(r.distance) : '';
        return `<button type="button" class="wf-chat-result" data-idx="${r.idx}">
            <span class="wf-chat-result-main">
              <span class="wf-chat-result-name">${escapeHtml(r.name)}</span>
              ${meta ? `<span class="wf-chat-result-meta">${escapeHtml(meta)}</span>` : ''}
            </span>
            ${dist ? `<span class="wf-chat-result-dist">${escapeHtml(dist)}</span>` : ''}
            <span class="wf-chat-result-go" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
                   stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 6l6 6-6 6"/>
              </svg>
            </span>
          </button>`;
      })
      .join('');
    log.appendChild(wrap);
    scrollToEnd();
  }

  function renderQuickAsks() {
    quick.innerHTML = QUICK_ASKS.map(
      (q) => `<button type="button" class="wf-chat-chip" data-ask="${escapeHtml(q)}">${escapeHtml(q)}</button>`,
    ).join('');
  }

  function greet() {
    if (greeted) return;
    greeted = true;
    addBubble(
      'bot',
      'Hi — tell me what you’re looking for and I’ll take you there. You can say what you need rather than a name: “I’m hungry”, “I need a toilet”, “what’s close to me?”',
    );
  }

  function send(text) {
    const message = String(text ?? '').trim();
    if (!message) return;
    addBubble('user', message);
    input.value = '';

    let answer;
    try {
      answer = answerMessage(message, { ...getContext(), lastOffer });
    } catch (err) {
      console.error('[wayfinding-chat] matching failed', err);
      addBubble('bot', 'Something went wrong working that out. Try asking again.');
      return;
    }

    const row = addBubble('bot', answer.text);
    if (answer.urgent) row.classList.add('is-urgent');
    addResults(answer.results);
    lastOffer = answer.results.map((r) => r.idx);

    if (answer.kind === 'clear') {
      onClear?.();
      lastOffer = [];
    }
    // "yes" resolved to a place — route without making them tap again.
    if (Number.isInteger(answer.navigateTo)) navigate(answer.navigateTo);
  }

  function navigate(idx) {
    // Close on the way out: the answer to "take me there" is the route drawn
    // in the space behind this panel, not more chat.
    close();
    onNavigate(idx);
  }

  function open() {
    panel.hidden = false;
    fab.setAttribute('aria-expanded', 'true');
    host.classList.add('is-open');
    greet();
    renderQuickAsks();
    setTimeout(() => input.focus(), 60);
    scrollToEnd();
  }

  function close() {
    panel.hidden = true;
    fab.setAttribute('aria-expanded', 'false');
    host.classList.remove('is-open');
  }

  fab.addEventListener('click', () => (panel.hidden ? open() : close()));
  host.querySelector('#wf-chat-close')?.addEventListener('click', close);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    send(input.value);
  });

  // Enter is handled explicitly rather than left to the form's implicit
  // submission: the Showcase viewer behind this panel installs its own
  // document-level key handling to drive the 3D view, and a swallowed default
  // would leave the user pressing Enter with nothing happening. Propagation
  // stops here so typing a question never also steers the space.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      send(input.value);
      return;
    }
    // Escape still closes — it is handled here because the document-level
    // listener below would never see it once propagation stops.
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    e.stopPropagation();
  });

  quick.addEventListener('click', (e) => {
    const chip = e.target?.closest?.('.wf-chat-chip');
    if (chip) send(chip.dataset.ask);
  });

  log.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('.wf-chat-result');
    if (!btn) return;
    const idx = Number(btn.dataset.idx);
    if (Number.isInteger(idx)) navigate(idx);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) close();
  });

  return { open, close, send, element: host };
}
