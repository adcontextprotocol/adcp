(function installEventSummary(global) {
  /**
   * One-line summary for an event card on /events.
   *
   * Event descriptions are markdown (the detail page renders them with
   * marked + DOMPurify). The list used to print the first 150 characters of
   * the raw source, so readers saw "**" and "[label](url)" cut mid-word.
   * This renders the markdown the same sanitised way, keeps only the text,
   * and shortens it once on a word boundary with an ellipsis.
   *
   * Returns plain text: the caller must still escape it before inserting it
   * into HTML.
   */
  function cleanSlackMentions(text) {
    return String(text)
      .replace(/<@([A-Z0-9]+)\|([^>]+)>/g, '$2')
      .replace(/<@[A-Z0-9]+>/g, '@member')
      .replace(/@U[A-Z0-9]{8,}/g, '@member');
  }

  function stripMarkdownFallback(text) {
    return text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, ' ')
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
      .replace(/(\*\*|__|\*|_|~~|`)/g, '');
  }

  function toPlainText(markdown) {
    const cleaned = cleanSlackMentions(markdown);
    if (typeof global.markdownToPlainText === 'function'
      && global.marked && global.DOMPurify) {
      return global.markdownToPlainText(cleaned);
    }
    return stripMarkdownFallback(cleaned).replace(/\s+/g, ' ').trim();
  }

  function truncateAtWord(text, maxLength) {
    if (text.length <= maxLength) return text;
    // Whitespace at index maxLength still counts: the word before it fits whole.
    let cut = -1;
    for (let i = maxLength; i >= 0; i--) {
      if (/\s/.test(text[i])) { cut = i; break; }
    }
    const head = cut > maxLength * 0.5 ? text.slice(0, cut) : text.slice(0, maxLength);
    let end = head.length;
    while (end > 0 && (/\s/.test(head[end - 1]) || ',;:.-–—…'.includes(head[end - 1]))) end--;
    return head.slice(0, end) + '…';
  }

  global.eventCardSummary = function eventCardSummary(event, maxLength) {
    const limit = typeof maxLength === 'number' ? maxLength : 150;
    const source = (event && (event.short_description || event.description)) || '';
    if (!source) return '';
    return truncateAtWord(toPlainText(source), limit);
  };
})(window);
