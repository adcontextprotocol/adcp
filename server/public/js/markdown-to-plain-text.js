(function installMarkdownToPlainText(global) {
  const SAFE_TAGS = [
    'p', 'div', 'span', 'strong', 'em', 'b', 'i', 'del', 's', 'code', 'pre',
    'blockquote', 'ul', 'ol', 'li', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'img',
  ];
  const BLOCK_TAGS = 'p, div, li, blockquote, h1, h2, h3, h4, h5, h6, td, th, tr';

  global.markdownToPlainText = function markdownToPlainText(markdown) {
    const container = document.createElement('div');
    const rendered = global.marked.parse(String(markdown));
    container.innerHTML = global.DOMPurify.sanitize(rendered, {
      ALLOWED_TAGS: SAFE_TAGS,
      ALLOWED_ATTR: ['alt'],
    });

    container.querySelectorAll('img').forEach(image => {
      image.replaceWith(document.createTextNode(image.getAttribute('alt') || ''));
    });
    container.querySelectorAll('br').forEach(lineBreak => {
      lineBreak.replaceWith(document.createTextNode(' '));
    });
    container.querySelectorAll(BLOCK_TAGS).forEach(block => {
      block.append(document.createTextNode(' '));
    });

    return (container.textContent || '').replace(/\s+/g, ' ').trim();
  };
})(window);
