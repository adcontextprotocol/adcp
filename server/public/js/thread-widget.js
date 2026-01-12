/**
 * Reusable Thread Viewer Widget
 *
 * Displays a conversation thread in a compact, embeddable format.
 * Can be used on user pages, prospect pages, outreach history, etc.
 *
 * Usage:
 *   <div id="thread-container"></div>
 *   <script>
 *     ThreadWidget.render('thread-container', threadId, { compact: true });
 *   </script>
 */

const ThreadWidget = (function() {
  // Cache for loaded threads
  const threadCache = new Map();

  /**
   * Escape HTML to prevent XSS
   */
  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Format a date for display
   */
  function formatDate(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  /**
   * Format relative time
   */
  function formatRelativeTime(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return formatDate(dateStr);
  }

  /**
   * Render a single message
   */
  function renderMessage(msg, options = {}) {
    const roleLabel = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Addie' : msg.role;
    const roleClass = msg.role === 'user' ? 'tw-message-user' : 'tw-message-assistant';

    // Truncate long messages in compact mode
    let content = escapeHtml(msg.content || '');
    if (options.compact && content.length > 300) {
      content = content.substring(0, 300) + '...';
    }

    // Simple markdown-ish formatting
    content = content
      .replace(/\n/g, '<br>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

    const timestamp = options.showTimestamps ?
      `<span class="tw-message-time">${formatRelativeTime(msg.created_at)}</span>` : '';

    return `
      <div class="tw-message ${roleClass}">
        <div class="tw-message-header">
          <span class="tw-message-role">${roleLabel}</span>
          ${timestamp}
        </div>
        <div class="tw-message-content">${content}</div>
      </div>
    `;
  }

  /**
   * Render thread header with metadata
   */
  function renderHeader(thread, options = {}) {
    if (options.hideHeader) return '';

    const channelBadge = thread.channel ?
      `<span class="tw-badge tw-badge-${thread.channel}">${thread.channel}</span>` : '';

    const messageCount = thread.message_count || (thread.messages ? thread.messages.length : 0);

    return `
      <div class="tw-header">
        <div class="tw-header-left">
          ${channelBadge}
          <span class="tw-message-count">${messageCount} messages</span>
        </div>
        <div class="tw-header-right">
          <span class="tw-date">${formatRelativeTime(thread.last_message_at || thread.started_at)}</span>
          ${options.showFullLink ? `<a href="/admin/addie?thread=${thread.thread_id}" class="tw-full-link" target="_blank">View full →</a>` : ''}
        </div>
      </div>
    `;
  }

  /**
   * Render loading state
   */
  function renderLoading() {
    return `
      <div class="tw-loading">
        <div class="tw-spinner"></div>
        <span>Loading conversation...</span>
      </div>
    `;
  }

  /**
   * Render error state
   */
  function renderError(message) {
    return `
      <div class="tw-error">
        <span class="tw-error-icon">⚠️</span>
        <span>${escapeHtml(message)}</span>
      </div>
    `;
  }

  /**
   * Render empty state
   */
  function renderEmpty(message = 'No conversation yet') {
    return `
      <div class="tw-empty">
        <span>${escapeHtml(message)}</span>
      </div>
    `;
  }

  /**
   * Fetch thread data from API
   */
  async function fetchThread(threadId) {
    // Check cache first
    if (threadCache.has(threadId)) {
      return threadCache.get(threadId);
    }

    const response = await fetch(`/api/admin/addie/threads/${threadId}`);
    if (!response.ok) {
      throw new Error(`Failed to load thread: ${response.status}`);
    }

    const data = await response.json();
    threadCache.set(threadId, data);
    return data;
  }

  /**
   * Render a complete thread widget
   *
   * @param {string} containerId - ID of the container element
   * @param {string} threadId - UUID of the thread to display
   * @param {Object} options - Display options
   * @param {boolean} options.compact - Show compact view (default: false)
   * @param {boolean} options.showTimestamps - Show message timestamps (default: true)
   * @param {boolean} options.showFullLink - Show link to full thread view (default: true)
   * @param {boolean} options.hideHeader - Hide the thread header (default: false)
   * @param {number} options.maxMessages - Max messages to show (default: all)
   * @param {boolean} options.latestFirst - Show latest messages first (default: false)
   */
  async function render(containerId, threadId, options = {}) {
    const container = document.getElementById(containerId);
    if (!container) {
      console.error(`ThreadWidget: Container #${containerId} not found`);
      return;
    }

    // Set defaults
    options = {
      compact: false,
      showTimestamps: true,
      showFullLink: true,
      hideHeader: false,
      maxMessages: null,
      latestFirst: false,
      ...options
    };

    // Add widget class
    container.classList.add('tw-container');

    // Show loading state
    container.innerHTML = renderLoading();

    try {
      const thread = await fetchThread(threadId);

      if (!thread || !thread.messages || thread.messages.length === 0) {
        container.innerHTML = renderEmpty();
        return;
      }

      // Filter and limit messages
      let messages = thread.messages.filter(m => m.role === 'user' || m.role === 'assistant');

      if (options.latestFirst) {
        messages = messages.reverse();
      }

      if (options.maxMessages) {
        messages = messages.slice(0, options.maxMessages);
      }

      // Render
      container.innerHTML = `
        ${renderHeader(thread, options)}
        <div class="tw-messages ${options.compact ? 'tw-compact' : ''}">
          ${messages.map(msg => renderMessage(msg, options)).join('')}
        </div>
      `;
    } catch (error) {
      console.error('ThreadWidget error:', error);
      container.innerHTML = renderError(error.message);
    }
  }

  /**
   * Render a thread preview (just first/last message)
   */
  async function renderPreview(containerId, threadId, options = {}) {
    return render(containerId, threadId, {
      compact: true,
      maxMessages: 2,
      showTimestamps: false,
      ...options
    });
  }

  /**
   * Create a clickable thread link that expands to show the thread
   */
  function renderExpandable(containerId, threadId, label = 'View conversation') {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.classList.add('tw-expandable-container');
    container.innerHTML = `
      <button class="tw-expand-btn" onclick="ThreadWidget.toggleExpand('${containerId}', '${threadId}')">
        <span class="tw-expand-icon">▶</span>
        ${escapeHtml(label)}
      </button>
      <div class="tw-expandable-content" id="${containerId}-content" style="display: none;"></div>
    `;
  }

  /**
   * Toggle expandable thread view
   */
  function toggleExpand(containerId, threadId) {
    const content = document.getElementById(`${containerId}-content`);
    const btn = document.querySelector(`#${containerId} .tw-expand-btn`);
    const icon = btn.querySelector('.tw-expand-icon');

    if (content.style.display === 'none') {
      content.style.display = 'block';
      icon.textContent = '▼';
      // Load thread if not already loaded
      if (!content.hasChildNodes() || content.innerHTML.includes('tw-loading')) {
        render(`${containerId}-content`, threadId, { compact: true, showFullLink: true });
      }
    } else {
      content.style.display = 'none';
      icon.textContent = '▶';
    }
  }

  /**
   * Clear the cache (useful after actions that modify threads)
   */
  function clearCache(threadId = null) {
    if (threadId) {
      threadCache.delete(threadId);
    } else {
      threadCache.clear();
    }
  }

  // Public API
  return {
    render,
    renderPreview,
    renderExpandable,
    toggleExpand,
    clearCache,
    // Expose utilities for custom rendering
    escapeHtml,
    formatDate,
    formatRelativeTime
  };
})();
