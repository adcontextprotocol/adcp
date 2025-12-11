/**
 * Shared member card rendering - used by members.html and dashboard.html
 * Single source of truth for member card display
 */

// Offering labels - shared across all pages
const offeringLabels = {
  buyer_agent: 'Buyer Agent',
  sales_agent: 'Sales Agent',
  creative_agent: 'Creative Agent',
  signals_agent: 'Signals Agent',
  consulting: 'Consulting',
  other: 'Other'
};

/**
 * Render a member card
 * @param {Object} member - Member profile data
 * @param {Object} options - Rendering options
 * @param {boolean} options.isPreview - If true, removes click handlers and view button (for dashboard preview)
 * @param {boolean} options.showVisibilityBadge - If true, shows public/private badge (for dashboard)
 * @returns {string} HTML string for the member card
 */
function renderMemberCard(member, options = {}) {
  const { isPreview = false, showVisibilityBadge = false } = options;

  const truncatedDesc = member.description
    ? (member.description.length > 200 ? member.description.substring(0, 200) + '...' : member.description)
    : '';

  const offeringsHtml = (member.offerings || [])
    .map(o => `<span class="offering-tag">${offeringLabels[o] || o}</span>`)
    .join('');

  const clickHandler = isPreview ? '' : `onclick="viewMember('${member.slug}')"`;
  const viewBtn = isPreview
    ? ''
    : `<button class="view-profile-btn" onclick="event.stopPropagation(); viewMember('${member.slug}')">View Profile</button>`;

  // Visibility badge for dashboard preview
  let visibilityBadge = '';
  if (showVisibilityBadge) {
    visibilityBadge = member.is_public
      ? '<span class="visibility-badge public"><span class="dot"></span> Public</span>'
      : '<span class="visibility-badge private"><span class="dot"></span> Private</span>';
  }

  // Agent count badge - show if member has registered agents
  const agentCount = (member.agent_urls || []).length;
  const agentBadge = agentCount > 0
    ? `<span class="agent-badge">${agentCount} Agent${agentCount > 1 ? 's' : ''}</span>`
    : '';

  // Markets display - show regions served if available
  const markets = member.markets || [];
  const marketsHtml = markets.length > 0
    ? `<div class="member-markets">${markets.map(m => `<span class="market-tag">${m}</span>`).join('')}</div>`
    : '';

  return `
    <div class="member-card" ${clickHandler}>
      <div class="member-card-header">
        ${member.logo_url
          ? `<img src="${member.logo_url}" alt="${member.display_name}" class="member-logo">`
          : `<div class="member-logo-placeholder">${member.display_name.charAt(0)}</div>`
        }
        <div class="member-info">
          <div class="member-name-row">
            <div class="member-name">${member.display_name}</div>
            ${agentBadge}
            ${visibilityBadge}
          </div>
          ${marketsHtml}
        </div>
      </div>
      <div class="member-card-body">
        ${truncatedDesc ? `<div class="member-description">${truncatedDesc}</div>` : ''}
        <div class="member-offerings">${offeringsHtml}</div>
      </div>
      <div class="member-card-footer">
        <div class="member-contact">
          ${member.contact_website ? `<a href="${member.contact_website}" target="_blank" onclick="event.stopPropagation()">Website</a>` : ''}
          ${member.linkedin_url ? `<a href="${member.linkedin_url}" target="_blank" onclick="event.stopPropagation()">LinkedIn</a>` : ''}
        </div>
        ${viewBtn}
      </div>
    </div>
  `;
}

/**
 * Get CSS styles for member card components
 * Call this to inject styles if not using members.html which has them inline
 * @returns {string} CSS styles
 */
function getMemberCardStyles() {
  return `
    .member-card {
      background: white;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .member-card:not(.preview):hover {
      transform: translateY(-4px);
      box-shadow: 0 8px 24px rgba(0,0,0,0.15);
      cursor: pointer;
    }
    .member-card-header {
      padding: 1rem 1.5rem;
      display: flex;
      align-items: center;
      gap: 1rem;
      border-bottom: 1px solid #f3f4f6;
    }
    .member-logo {
      width: 80px;
      height: 60px;
      object-fit: contain;
      border-radius: 8px;
    }
    .member-logo-placeholder {
      width: 80px;
      height: 60px;
      background: linear-gradient(135deg, #10b981, #059669);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-size: 24px;
      font-weight: bold;
    }
    .member-info {
      flex: 1;
    }
    .member-name-row {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .member-name {
      font-size: 1.2rem;
      font-weight: 600;
      color: #333;
    }
    .member-markets {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 4px;
    }
    .member-markets .market-tag {
      font-size: 0.7rem;
      padding: 2px 6px;
      background: #f3f4f6;
      color: #6b7280;
      border-radius: 3px;
    }
    .member-card-body {
      padding: 1.5rem;
    }
    .member-description {
      color: #666;
      font-size: 0.95rem;
      line-height: 1.6;
      margin-bottom: 1rem;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .member-offerings {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .offering-tag {
      padding: 4px 10px;
      background: #dbeafe;
      color: #1e40af;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
    }
    .member-card-footer {
      padding: 1rem 1.5rem;
      background: #f9fafb;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .member-contact {
      display: flex;
      gap: 1rem;
    }
    .member-contact a {
      color: #10b981;
      text-decoration: none;
      font-size: 14px;
    }
    .member-contact a:hover {
      text-decoration: underline;
    }
    .view-profile-btn {
      padding: 8px 16px;
      background: #10b981;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }
    .view-profile-btn:hover {
      background: #059669;
    }
    .visibility-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
    }
    .visibility-badge .dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
    }
    .visibility-badge.public {
      background: #d1fae5;
      color: #065f46;
    }
    .visibility-badge.public .dot {
      background: #10b981;
    }
    .visibility-badge.private {
      background: #f3f4f6;
      color: #6b7280;
    }
    .visibility-badge.private .dot {
      background: #9ca3af;
    }
    .agent-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      background: #fef3c7;
      color: #92400e;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
    }
  `;
}

/**
 * Inject member card styles into the page
 * Call this once on pages that need member card styling
 */
function injectMemberCardStyles() {
  if (document.getElementById('member-card-styles')) return;

  const style = document.createElement('style');
  style.id = 'member-card-styles';
  style.textContent = getMemberCardStyles();
  document.head.appendChild(style);
}

// ============================================
// Agent Card Rendering - Shared Component
// ============================================

const agentTypeLabels = {
  creative: 'Creative Agent',
  sales: 'Sales Agent',
  signals: 'Signals Agent',
  unknown: 'Agent'
};

const agentTypeColors = {
  creative: { bg: '#dbeafe', color: '#1d4ed8' },
  sales: { bg: '#dcfce7', color: '#15803d' },
  signals: { bg: '#fef3c7', color: '#b45309' },
  unknown: { bg: '#f3f4f6', color: '#6b7280' }
};

/**
 * Render an agent card/row with full details
 * @param {Object} agentInfo - Discovered agent info from /api/discover-agent or /api/public/discover-agent
 * @param {string} agentUrl - The agent URL
 * @param {Object} options - Rendering options
 * @param {boolean} options.showVisibilityToggle - Show public/private toggle (for edit profile)
 * @param {boolean} options.isPublic - Current visibility state
 * @param {number} options.index - Index for toggle callback
 * @param {boolean} options.showRemoveButton - Show remove button
 * @param {boolean} options.showStatus - Show Online/Error status badge
 * @param {boolean} options.compact - Use compact layout (for member cards)
 * @returns {string} HTML string
 */
function renderAgentCard(agentInfo, agentUrl, options = {}) {
  const {
    showVisibilityToggle = false,
    isPublic = true,
    index = 0,
    showRemoveButton = false,
    showStatus = true,
    compact = false
  } = options;

  // Handle error state
  if (agentInfo?.error) {
    return `
      <div class="agent-card error">
        <div class="agent-card-main">
          <div class="agent-card-info">
            <div class="agent-card-url">${escapeHtmlSafe(agentUrl)}</div>
            <div class="agent-card-error">${escapeHtmlSafe(agentInfo.error)}</div>
          </div>
          ${showStatus ? '<div class="agent-card-status error"><span>✗</span> Error</div>' : ''}
        </div>
        ${showRemoveButton ? `<button type="button" class="agent-card-remove" onclick="removeAgent(${index})">Remove</button>` : ''}
      </div>
    `;
  }

  // Handle loading state
  if (!agentInfo) {
    return `
      <div class="agent-card loading">
        <div class="agent-card-main">
          <div class="agent-card-info">
            <div class="agent-card-url">${escapeHtmlSafe(agentUrl)}</div>
            <div class="agent-card-meta">Checking connection...</div>
          </div>
          <div class="agent-card-status loading">
            <div class="agent-card-spinner"></div>
            <span>Checking</span>
          </div>
        </div>
      </div>
    `;
  }

  // Build agent type label and color
  const agentType = agentInfo.type || 'unknown';
  const typeLabel = agentTypeLabels[agentType] || 'Agent';
  const typeColors = agentTypeColors[agentType] || agentTypeColors.unknown;

  // Build protocol badges (support multiple protocols)
  const protocols = agentInfo.protocols || (agentInfo.protocol ? [agentInfo.protocol] : []);
  const protocolBadgesHtml = protocols.map(p =>
    `<span class="agent-protocol-badge">${p.toUpperCase()}</span>`
  ).join('');

  // Build stats display based on agent type
  let statsHtml = '';
  if (agentType === 'creative') {
    const count = agentInfo.stats?.format_count ?? 0;
    statsHtml = `<span class="agent-stat">${count} format${count !== 1 ? 's' : ''}</span>`;
  } else if (agentType === 'sales') {
    const productCount = agentInfo.stats?.product_count ?? 0;
    const publisherCount = agentInfo.stats?.publisher_count ?? 0;
    statsHtml = `
      <span class="agent-stat">${productCount} product${productCount !== 1 ? 's' : ''}</span>
      <span class="agent-stat-sep">•</span>
      <span class="agent-stat">${publisherCount} publisher${publisherCount !== 1 ? 's' : ''}</span>
    `;
  }

  // Visibility badge (for list views)
  const visibilityBadge = showVisibilityToggle
    ? (isPublic
        ? '<span class="agent-visibility-badge public">Public</span>'
        : '<span class="agent-visibility-badge private">Private</span>')
    : '';

  // Visibility toggle (for edit mode)
  const visibilityToggle = showVisibilityToggle ? `
    <div class="agent-card-visibility">
      <label>
        <input type="checkbox" ${isPublic ? 'checked' : ''} onchange="toggleAgentVisibility(${index}, this.checked)">
        <span class="toggle"></span>
        Show in member directory
      </label>
    </div>
  ` : '';

  // Status badge
  const statusHtml = showStatus ? `
    <div class="agent-card-status online">
      <span class="status-dot"></span>
      <span>Online</span>
    </div>
  ` : '';

  // Remove button
  const removeBtn = showRemoveButton
    ? `<button type="button" class="agent-card-remove" onclick="removeAgent(${index})">Remove</button>`
    : '';

  if (compact) {
    // Compact layout for member cards - just type badge and key stats
    return `
      <div class="agent-card-compact">
        <span class="agent-type-badge" style="background: ${typeColors.bg}; color: ${typeColors.color};">${typeLabel}</span>
        ${protocolBadgesHtml}
        ${statsHtml}
      </div>
    `;
  }

  // Full layout
  return `
    <div class="agent-card success">
      <div class="agent-card-main">
        <div class="agent-card-info">
          <div class="agent-card-header">
            <span class="agent-type-badge" style="background: ${typeColors.bg}; color: ${typeColors.color};">${typeLabel}</span>
            ${visibilityBadge}
          </div>
          <div class="agent-card-url">${escapeHtmlSafe(agentUrl)}</div>
          <div class="agent-card-meta">
            ${protocolBadgesHtml}
            ${statsHtml}
          </div>
          ${visibilityToggle}
        </div>
        ${statusHtml}
      </div>
      ${removeBtn}
    </div>
  `;
}

/**
 * Get CSS styles for agent cards
 * @returns {string} CSS styles
 */
function getAgentCardStyles() {
  return `
    .agent-card {
      background: white;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 8px;
    }
    .agent-card.success {
      background: #f0fdf4;
      border-color: #86efac;
    }
    .agent-card.error {
      background: #fef2f2;
      border-color: #fecaca;
    }
    .agent-card.loading {
      background: #fffbeb;
      border-color: #fde68a;
    }
    .agent-card-main {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
    }
    .agent-card-info {
      flex: 1;
      min-width: 0;
    }
    .agent-card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }
    .agent-card-url {
      font-size: 13px;
      color: #6b7280;
      word-break: break-all;
      margin-bottom: 6px;
    }
    .agent-card-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      font-size: 13px;
      color: #374151;
    }
    .agent-card-error {
      font-size: 13px;
      color: #dc2626;
    }
    .agent-type-badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
    }
    .agent-protocol-badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 600;
      background: #e5e7eb;
      color: #374151;
    }
    .agent-stat {
      color: #374151;
    }
    .agent-stat-sep {
      color: #9ca3af;
    }
    .agent-visibility-badge {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .agent-visibility-badge.public {
      background: #d1fae5;
      color: #065f46;
    }
    .agent-visibility-badge.private {
      background: #f3f4f6;
      color: #6b7280;
    }
    .agent-card-status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      white-space: nowrap;
      padding: 4px 10px;
      border-radius: 12px;
    }
    .agent-card-status.online {
      background: #d1fae5;
      color: #065f46;
    }
    .agent-card-status.error {
      color: #dc2626;
    }
    .agent-card-status.loading {
      color: #d97706;
    }
    .agent-card-status .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #10b981;
    }
    .agent-card-spinner {
      width: 14px;
      height: 14px;
      border: 2px solid #fbbf24;
      border-top-color: transparent;
      border-radius: 50%;
      animation: agent-spin 1s linear infinite;
    }
    @keyframes agent-spin {
      to { transform: rotate(360deg); }
    }
    .agent-card-visibility {
      margin-top: 8px;
      font-size: 13px;
    }
    .agent-card-visibility label {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
    }
    .agent-card-remove {
      padding: 6px 12px;
      background: #fee2e2;
      color: #dc2626;
      border: none;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      margin-top: 8px;
    }
    .agent-card-remove:hover {
      background: #fecaca;
    }
    /* Compact layout for member cards */
    .agent-card-compact {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      padding: 6px 0;
    }
  `;
}

/**
 * Inject agent card styles into the page
 */
function injectAgentCardStyles() {
  if (document.getElementById('agent-card-styles')) return;

  const style = document.createElement('style');
  style.id = 'agent-card-styles';
  style.textContent = getAgentCardStyles();
  document.head.appendChild(style);
}

/**
 * Safe HTML escape (doesn't rely on DOM)
 */
function escapeHtmlSafe(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
