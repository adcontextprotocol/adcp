(function routeSlackInvitesThroughRecoveryGuide() {
  'use strict';

  var guideUrl = 'https://docs.adcontextprotocol.org/docs/community/joining-slack';

  function isJoiningGuide() {
    return /\/community\/joining-slack\/?$/.test(window.location.pathname);
  }

  function rewriteDirectInvites(root) {
    if (isJoiningGuide()) return;
    if (root.matches && root.matches('a[href^="https://join.slack.com/"]')) {
      root.href = guideUrl;
    }
    root.querySelectorAll('a[href^="https://join.slack.com/"]').forEach(function(anchor) {
      anchor.href = guideUrl;
    });
  }

  function repairJoiningGuideTerminology(root) {
    if (!isJoiningGuide()) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var textNode;
    while ((textNode = walker.nextNode())) {
      textNode.nodeValue = textNode.nodeValue.replace(
        /\bAAO members\b/g,
        'AgenticAdvertising.org member organizations'
      );
    }
  }

  function start() {
    rewriteDirectInvites(document);
    repairJoiningGuideTerminology(document);
    new MutationObserver(function(mutations) {
      mutations.forEach(function(mutation) {
        mutation.addedNodes.forEach(function(node) {
          if (node.nodeType === Node.TEXT_NODE && isJoiningGuide()) {
            node.nodeValue = node.nodeValue.replace(
              /\bAAO members\b/g,
              'AgenticAdvertising.org member organizations'
            );
            return;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          rewriteDirectInvites(node);
          repairJoiningGuideTerminology(node);
        });
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
