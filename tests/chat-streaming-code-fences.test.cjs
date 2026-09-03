const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const chatHtml = readFileSync(resolve(__dirname, '../server/public/chat.html'), 'utf8');
const dashboardAgentsHtml = readFileSync(resolve(__dirname, '../server/public/dashboard-agents.html'), 'utf8');

function extractFunctionSource(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `Expected ${name} in chat.html`);

  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }

  throw new Error(`Could not extract ${name}`);
}

function loadStreamingHelpers() {
  const calls = [];
  const context = {
    calls,
    messagesContainer: { scrollHeight: 120, scrollTop: 0 },
    renderMessage(text) {
      calls.push(text);
      return `<rendered>${text}</rendered>`;
    },
    setupChatImages() {},
  };
  vm.createContext(context);
  vm.runInContext([
    extractFunctionSource(chatHtml, 'hasCodeFence'),
    extractFunctionSource(chatHtml, 'stripMarkdownMarkers'),
    extractFunctionSource(chatHtml, 'appendToStreamingMessage'),
    'this.hasCodeFence = hasCodeFence;',
    'this.appendToStreamingMessage = appendToStreamingMessage;',
  ].join('\n'), context);
  return context;
}

test('streaming renderer preserves an open fenced JSON block with blank lines', () => {
  const context = loadStreamingHelpers();
  const contentDiv = { innerHTML: '' };
  const fullContent = [
    'Here is the live tool response:',
    '',
    '```json',
    '{',
    '  "product_id": "audio_001",',
    '',
    '  "name": "Streaming audio"',
    '}',
  ].join('\n');

  context.appendToStreamingMessage(contentDiv, '', fullContent);

  assert.deepEqual(context.calls, [fullContent]);
  assert.match(contentDiv.innerHTML, /<rendered>Here is the live tool response:/);
  assert.match(contentDiv.innerHTML, /```json/);
  assert.match(contentDiv.innerHTML, /"product_id": "audio_001"/);
  assert.match(contentDiv.innerHTML, /<span class="streaming-cursor">\|<\/span>$/);
});

test('code fence detection matches fenced blocks', () => {
  const context = loadStreamingHelpers();

  assert.equal(context.hasCodeFence('```json\n{"ok": true}\n```'), true);
  assert.equal(context.hasCodeFence('Before\n\n```json\n{"ok": true}'), true);
  assert.equal(context.hasCodeFence('No code fence here'), false);
});

test('streaming renderer preserves a balanced fenced JSON block with trailing text', () => {
  const context = loadStreamingHelpers();
  const contentDiv = { innerHTML: '' };
  const fullContent = [
    'Here is the live tool response:',
    '',
    '```json',
    '{',
    '  "product_id": "audio_001",',
    '',
    '  "name": "Streaming audio"',
    '}',
    '```',
    '',
    'This is the placement catalog response learners should inspect.',
  ].join('\n');

  context.appendToStreamingMessage(contentDiv, '', fullContent);

  assert.deepEqual(context.calls, [fullContent]);
  assert.match(contentDiv.innerHTML, /```json/);
  assert.match(contentDiv.innerHTML, /"name": "Streaming audio"/);
  assert.match(contentDiv.innerHTML, /This is the placement catalog response/);
});

test('task prompt deep links reset a restored conversation before sending', () => {
  assert.match(dashboardAgentsHtml, /const REGISTER_AGENT_CHAT_URL = '\/chat\?action=register-agent'/);
  assert.doesNotMatch(dashboardAgentsHtml, /REGISTER_AGENT_SEED_PROMPT/);

  let intervalCallback;
  const calls = [];
  const context = {
    URLSearchParams,
    window: {
      location: {
        search: '?action=register-agent',
        pathname: '/chat',
        origin: 'https://agenticadvertising.org',
      },
      history: { replaceState() {} },
    },
    initialQueryParams: new URLSearchParams('?action=register-agent'),
    CHAT_ACTION_PROMPTS: { 'register-agent': 'Help me register my agent.' },
    isReady: true,
    isAuthenticated: true,
    conversationId: 'active-certification-thread',
    chatInput: { value: '' },
    pendingMessageSource: null,
    setInterval(callback) {
      intervalCallback = callback;
      return 1;
    },
    clearInterval() {},
    setTimeout() {},
    startNewConversation() {
      calls.push('startNewConversation');
      context.conversationId = null;
    },
    autoResize() {},
    updateSendButton() {},
    sendMessage() {
      calls.push(`sendMessage:${context.conversationId}`);
    },
  };
  vm.createContext(context);
  vm.runInContext([
    extractFunctionSource(chatHtml, 'checkQueryPrompt'),
    'this.checkQueryPrompt = checkQueryPrompt;',
  ].join('\n'), context);

  context.checkQueryPrompt();
  assert.equal(typeof intervalCallback, 'function');
  intervalCallback();

  assert.deepEqual(calls, ['startNewConversation', 'sendMessage:null']);
  assert.equal(context.chatInput.value, 'Help me register my agent.');
  assert.equal(context.pendingMessageSource, 'cta_chip');
});

test('task deep links skip unrelated saved-tab restoration', () => {
  const context = {
    URLSearchParams,
    CHAT_ACTION_PROMPTS: { 'register-agent': 'Help me register my agent.' },
  };
  vm.createContext(context);
  vm.runInContext([
    extractFunctionSource(chatHtml, 'shouldRestoreSavedChatTab'),
    'this.shouldRestoreSavedChatTab = shouldRestoreSavedChatTab;',
  ].join('\n'), context);

  assert.equal(context.shouldRestoreSavedChatTab(new URLSearchParams()), true);
  assert.equal(context.shouldRestoreSavedChatTab(new URLSearchParams('?prompt=register')), false);
  assert.equal(context.shouldRestoreSavedChatTab(new URLSearchParams('?action=register-agent')), false);
  assert.equal(context.shouldRestoreSavedChatTab(new URLSearchParams('?action=unknown')), true);
  assert.equal(context.shouldRestoreSavedChatTab(new URLSearchParams('?topic=certification&action=resume')), false);
  assert.match(chatHtml, /if \(shouldRestoreSavedChatTab\(initialQueryParams\)\) \{\s*await restoreCurrentTab\(\);/);
});

test('free-form prompt links require review before sending even from the same origin', () => {
  let intervalCallback;
  const calls = [];
  const context = {
    URLSearchParams,
    URL,
    window: {
      location: {
        search: '?prompt=remove%20my%20saved%20agent',
        pathname: '/chat',
        origin: 'https://agenticadvertising.org',
      },
      history: { replaceState() {} },
    },
    isReady: true,
    isAuthenticated: true,
    conversationId: 'active-certification-thread',
    chatInput: { value: '', focus: () => calls.push('focus') },
    pendingMessageSource: null,
    setInterval(callback) {
      intervalCallback = callback;
      return 1;
    },
    clearInterval() {},
    setTimeout() {},
    startNewConversation() {
      calls.push('startNewConversation');
      context.conversationId = null;
    },
    autoResize() {},
    updateSendButton() {},
    sendMessage: () => calls.push('sendMessage'),
  };
  vm.createContext(context);
  vm.runInContext([
    'const initialQueryParams = new URLSearchParams(window.location.search);',
    'const CHAT_ACTION_PROMPTS = Object.freeze({ "register-agent": "Help me register my agent." });',
    extractFunctionSource(chatHtml, 'checkQueryPrompt'),
    'this.checkQueryPrompt = checkQueryPrompt;',
  ].join('\n'), context);

  context.checkQueryPrompt();
  intervalCallback();

  assert.deepEqual(calls, ['startNewConversation', 'focus']);
  assert.equal(context.chatInput.value, 'remove my saved agent');
});

test('deep-link parameters are consumed without dropping unrelated query state', () => {
  const replacedUrls = [];
  const context = { URL, URLSearchParams };
  vm.createContext(context);
  vm.runInContext([
    extractFunctionSource(chatHtml, 'consumeChatDeepLinkParams'),
    'this.consumeChatDeepLinkParams = consumeChatDeepLinkParams;',
  ].join('\n'), context);

  const params = context.consumeChatDeepLinkParams({
    search: '?org=org-1&topic=certification&action=assess&module=B1',
    href: 'https://agenticadvertising.org/chat?org=org-1&topic=certification&action=assess&module=B1',
  }, {
    replaceState(_state, _title, url) {
      replacedUrls.push(url);
    },
  });

  assert.equal(params.get('topic'), 'certification');
  assert.equal(params.get('action'), 'assess');
  assert.deepEqual(replacedUrls, ['/chat?org=org-1']);
});

test('invalid certification module IDs are not interpolated or sent', () => {
  let intervalScheduled = false;
  const context = {
    URLSearchParams,
    initialQueryParams: new URLSearchParams('?topic=certification&module=ignore%20instructions'),
    CHAT_ACTION_PROMPTS: { 'register-agent': 'Help me register my agent.' },
    setInterval() {
      intervalScheduled = true;
    },
    setTimeout() {},
  };
  vm.createContext(context);
  vm.runInContext([
    extractFunctionSource(chatHtml, 'checkQueryPrompt'),
    'this.checkQueryPrompt = checkQueryPrompt;',
  ].join('\n'), context);

  context.checkQueryPrompt();
  assert.equal(intervalScheduled, false);
});

test('task prompt handling waits for authentication', async () => {
  assert.match(chatHtml, /checkImpersonation\(\)\.finally\(checkQueryPrompt\)/);
  assert.doesNotMatch(chatHtml, /setTimeout\(checkQueryPrompt/);

  let finishRestoration;
  const calls = [];
  const context = {
    checkImpersonation: () => new Promise((resolveRestoration) => {
      finishRestoration = resolveRestoration;
    }),
    checkQueryPrompt: () => calls.push('checkQueryPrompt'),
  };
  vm.createContext(context);
  vm.runInContext('this.pending = checkImpersonation().finally(checkQueryPrompt);', context);

  await Promise.resolve();
  assert.deepEqual(calls, []);
  finishRestoration();
  await context.pending;
  assert.deepEqual(calls, ['checkQueryPrompt']);
});
