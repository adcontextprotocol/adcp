const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

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
  const chatHtml = readFileSync(resolve(__dirname, '../server/public/chat.html'), 'utf8');
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
