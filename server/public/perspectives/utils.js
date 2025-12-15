/**
 * Shared utilities for perspectives pages
 */

/**
 * Generate browser fingerprint for anonymous likes
 * Uses canvas, user agent, and other browser properties to create a unique identifier
 * @returns {string} Hexadecimal fingerprint hash
 */
function generateFingerprint() {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'top';
  ctx.font = '14px Arial';
  ctx.fillText('fingerprint', 0, 0);
  const canvasData = canvas.toDataURL();

  const data = [
    navigator.userAgent,
    navigator.language,
    screen.width + 'x' + screen.height,
    new Date().getTimezoneOffset(),
    canvasData.slice(0, 50)
  ].join('|');

  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

/**
 * Load user's likes from localStorage
 * @returns {Set<string>} Set of perspective IDs that the user has liked
 */
function loadUserLikesFromStorage() {
  try {
    const stored = localStorage.getItem('perspectiveLikes');
    if (stored) {
      return new Set(JSON.parse(stored));
    }
  } catch (e) {
    console.error('Error loading likes from localStorage:', e);
  }
  return new Set();
}

/**
 * Save user's likes to localStorage
 * @param {Set<string>} likes - Set of perspective IDs
 */
function saveUserLikesToStorage(likes) {
  try {
    localStorage.setItem('perspectiveLikes', JSON.stringify([...likes]));
  } catch (e) {
    console.error('Error saving likes to localStorage:', e);
  }
}

/**
 * Check if user has liked a specific article
 * @param {string} articleId - The perspective ID to check
 * @returns {boolean} Whether the user has liked this article
 */
function checkUserLike(articleId) {
  const likes = loadUserLikesFromStorage();
  return likes.has(articleId);
}

/**
 * Save or remove a like for a specific article
 * @param {string} articleId - The perspective ID
 * @param {boolean} liked - Whether to add or remove the like
 */
function saveUserLike(articleId, liked) {
  const likes = loadUserLikesFromStorage();
  if (liked) {
    likes.add(articleId);
  } else {
    likes.delete(articleId);
  }
  saveUserLikesToStorage(likes);
}

/**
 * Escape HTML to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped HTML string
 */
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Format a date string for display
 * @param {string} dateStr - ISO date string
 * @returns {string} Formatted date (e.g., "December 15, 2025")
 */
function formatDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * Format a date string in short format
 * @param {string} dateStr - ISO date string
 * @returns {string} Formatted date (e.g., "Dec 15, 2025")
 */
function formatDateShort(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Initialize fingerprint on load
const userFingerprint = generateFingerprint();
