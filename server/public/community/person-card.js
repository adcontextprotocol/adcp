/**
 * Shared person card rendering for community pages.
 * Used by hub.html, connections.html, and people directory.
 */

/**
 * Render a person card (small format for suggested connections, etc.)
 * @param {Object} person - Person profile data
 * @param {Object} options - Rendering options
 * @param {string} options.context - Context tag like "Same city", "Shared working group"
 * @param {boolean} options.showConnectBtn - Show connect button
 * @param {boolean} options.compact - Compact card for horizontal scroll rows
 * @returns {string} HTML string
 */
function renderPersonCard(person, options = {}) {
  const { context = '', showConnectBtn = false, compact = false } = options;

  const name = escapeHtmlPC(`${person.first_name || ''} ${person.last_name || ''}`.trim() || 'Member');
  const headline = person.headline ? escapeHtmlPC(person.headline) : '';
  const org = person.organization_name ? escapeHtmlPC(person.organization_name) : '';
  const city = person.city ? escapeHtmlPC(person.city) : '';
  const slug = person.slug || '';
  const userId = person.workos_user_id || '';

  const avatarHtml = person.avatar_url
    ? `<img src="${escapeHtmlPC(person.avatar_url)}" alt="${name}" class="pc-avatar">`
    : `<div class="pc-avatar pc-avatar--placeholder">${(person.first_name || '?').charAt(0)}</div>`;

  const expertiseTags = (person.expertise || []).slice(0, 2)
    .map(e => `<span class="pc-tag">${escapeHtmlPC(e)}</span>`)
    .join('');

  const badgeIcons = (person.badges || []).slice(0, 3)
    .map(b => `<span class="pc-badge-icon" title="${escapeHtmlPC(b.name)}">${escapeHtmlPC(b.icon) || '&#9733;'}</span>`)
    .join('');

  const coffeeBadge = person.open_to_coffee_chat
    ? '<span class="pc-coffee-badge" title="Open to coffee chats">Open to chat</span>'
    : '';

  const contextHtml = context
    ? `<div class="pc-context">${escapeHtmlPC(context)}</div>`
    : '';

  const connectBtnHtml = showConnectBtn
    ? `<button class="btn btn-primary btn-sm pc-connect-btn" data-user-id="${escapeHtmlPC(userId)}" onclick="handleConnect(this, '${escapeHtmlPC(userId)}')">Connect</button>`
    : '';

  const locationHtml = city || org
    ? `<div class="pc-meta">${[org, city].filter(Boolean).join(' &middot; ')}</div>`
    : '';

  return `
    <div class="pc-card ${compact ? 'pc-card--compact' : ''}" data-slug="${escapeHtmlPC(slug)}">
      <a href="/community/people/${escapeHtmlPC(slug)}" class="pc-card-link">
        <div class="pc-card-top">
          ${avatarHtml}
          ${coffeeBadge}
        </div>
        <div class="pc-card-body">
          <div class="pc-name">${name}</div>
          ${headline ? `<div class="pc-headline">${headline}</div>` : ''}
          ${locationHtml}
          ${expertiseTags ? `<div class="pc-tags">${expertiseTags}</div>` : ''}
          ${badgeIcons ? `<div class="pc-badges">${badgeIcons}</div>` : ''}
          ${contextHtml}
        </div>
      </a>
      ${connectBtnHtml}
    </div>
  `;
}

/**
 * Render a connection card (for connections page)
 * @param {Object} connection - Connection object with other_user
 * @param {string} tab - "connections" | "pending"
 * @returns {string} HTML string
 */
function renderConnectionCard(connection, tab) {
  const person = connection.other_user;
  const name = escapeHtmlPC(`${person.first_name || ''} ${person.last_name || ''}`.trim() || 'Member');
  const headline = person.headline ? escapeHtmlPC(person.headline) : '';
  const org = person.organization_name ? escapeHtmlPC(person.organization_name) : '';
  const city = person.city ? escapeHtmlPC(person.city) : '';
  const slug = person.slug || '';

  const avatarHtml = person.avatar_url
    ? `<img src="${escapeHtmlPC(person.avatar_url)}" alt="${name}" class="pc-avatar">`
    : `<div class="pc-avatar pc-avatar--placeholder">${(person.first_name || '?').charAt(0)}</div>`;

  const expertiseTags = (person.expertise || []).slice(0, 3)
    .map(e => `<span class="pc-tag">${escapeHtmlPC(e)}</span>`)
    .join('');

  const locationHtml = city || org
    ? `<div class="pc-meta">${[org, city].filter(Boolean).join(' &middot; ')}</div>`
    : '';

  let actionsHtml = '';
  if (tab === 'pending') {
    const messageHtml = connection.message
      ? `<div class="pc-message">"${escapeHtmlPC(connection.message)}"</div>`
      : '';
    actionsHtml = `
      ${messageHtml}
      <div class="pc-actions">
        <button class="btn btn-success btn-sm" onclick="handleAccept('${connection.id}', this)">Accept</button>
        <button class="btn btn-ghost btn-sm" onclick="handleDecline('${connection.id}', this)">Decline</button>
      </div>
    `;
  } else {
    actionsHtml = `<a href="/community/people/${escapeHtmlPC(slug)}" class="btn btn-ghost btn-sm">View profile</a>`;
  }

  return `
    <div class="pc-card pc-card--connection" data-connection-id="${connection.id}">
      <div class="pc-card-top">
        ${avatarHtml}
      </div>
      <div class="pc-card-body">
        <div class="pc-name">${name}</div>
        ${headline ? `<div class="pc-headline">${headline}</div>` : ''}
        ${locationHtml}
        ${expertiseTags ? `<div class="pc-tags">${expertiseTags}</div>` : ''}
      </div>
      <div class="pc-card-footer">
        ${actionsHtml}
      </div>
    </div>
  `;
}

/**
 * Handle connect button click
 */
async function handleConnect(btn, userId) {
  btn.disabled = true;
  btn.textContent = 'Sending...';

  try {
    const response = await fetch('/api/community/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_user_id: userId })
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to send request');
    }

    btn.textContent = 'Sent';
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-ghost');
  } catch (error) {
    console.error('Connect error:', error);
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
}

/**
 * Inject person card CSS into the page
 */
function injectPersonCardStyles() {
  if (document.getElementById('person-card-styles')) return;

  const style = document.createElement('style');
  style.id = 'person-card-styles';
  style.textContent = `
    .pc-card {
      background: var(--color-bg-card);
      border: var(--border-1) solid var(--color-border);
      border-radius: var(--card-radius);
      padding: var(--space-5);
      transition: var(--transition-all);
      display: flex;
      flex-direction: column;
      min-width: 220px;
    }

    .pc-card:hover {
      border-color: var(--color-brand);
      box-shadow: var(--shadow-primary-sm);
    }

    .pc-card--compact {
      min-width: 200px;
      max-width: 260px;
      flex-shrink: 0;
    }

    .pc-card--connection {
      min-width: 0;
    }

    .pc-card-link {
      text-decoration: none;
      color: inherit;
      display: flex;
      flex-direction: column;
      flex: 1;
    }

    .pc-card-top {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      margin-bottom: var(--space-3);
    }

    .pc-avatar {
      width: 48px;
      height: 48px;
      border-radius: var(--radius-full);
      object-fit: cover;
      flex-shrink: 0;
    }

    .pc-avatar--placeholder {
      background: linear-gradient(135deg, var(--color-brand), var(--color-brand-hover));
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: var(--text-lg);
      font-weight: var(--font-bold);
    }

    .pc-coffee-badge {
      font-size: var(--text-xs);
      color: var(--color-success-700);
      background: var(--color-success-100);
      padding: var(--space-0.5) var(--space-2);
      border-radius: var(--radius-full);
      font-weight: var(--font-medium);
      white-space: nowrap;
    }

    .pc-card-body {
      flex: 1;
    }

    .pc-name {
      font-weight: var(--font-semibold);
      color: var(--color-text-heading);
      font-size: var(--text-sm);
      margin-bottom: var(--space-1);
    }

    .pc-headline {
      font-size: var(--text-xs);
      color: var(--color-text-secondary);
      margin-bottom: var(--space-1);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .pc-meta {
      font-size: var(--text-xs);
      color: var(--color-text-muted);
      margin-bottom: var(--space-2);
    }

    .pc-tags {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
      margin-bottom: var(--space-2);
    }

    .pc-tag {
      font-size: var(--text-xs);
      padding: var(--space-0.5) var(--space-2);
      background: var(--color-primary-100);
      color: var(--color-brand);
      border-radius: var(--radius-sm);
      font-weight: var(--font-medium);
    }

    .pc-badges {
      display: flex;
      gap: var(--space-1);
      margin-bottom: var(--space-2);
    }

    .pc-badge-icon {
      width: 22px;
      height: 22px;
      border-radius: var(--radius-md);
      background: var(--color-gray-100);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
    }

    .pc-context {
      font-size: var(--text-xs);
      color: var(--color-text-muted);
      font-style: italic;
      margin-top: var(--space-2);
    }

    .pc-connect-btn {
      margin-top: var(--space-3);
      width: 100%;
    }

    .pc-card-footer {
      margin-top: var(--space-3);
      padding-top: var(--space-3);
      border-top: var(--border-1) solid var(--color-border);
    }

    .pc-actions {
      display: flex;
      gap: var(--space-2);
    }

    .pc-actions .btn {
      flex: 1;
    }

    .pc-message {
      font-size: var(--text-xs);
      color: var(--color-text-secondary);
      font-style: italic;
      margin-bottom: var(--space-3);
      padding: var(--space-2) var(--space-3);
      background: var(--color-bg-subtle);
      border-radius: var(--radius-md);
    }

    .pc-status {
      font-size: var(--text-xs);
      font-weight: var(--font-semibold);
      padding: var(--space-1) var(--space-3);
      border-radius: var(--radius-full);
    }

    .pc-status--pending {
      background: var(--color-warning-100);
      color: var(--color-warning-700);
    }

    .pc-status--accepted {
      background: var(--color-success-100);
      color: var(--color-success-700);
    }

    .pc-status--declined {
      background: var(--color-error-100);
      color: var(--color-error-700);
    }
  `;
  document.head.appendChild(style);
}

function escapeHtmlPC(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
