const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const chatHtml = readFileSync(resolve(__dirname, '../server/public/chat.html'), 'utf8');
const certificationHtml = readFileSync(resolve(__dirname, '../server/public/certification.html'), 'utf8');
const adminHtml = readFileSync(resolve(__dirname, '../server/public/admin-certification.html'), 'utf8');

test('certification retry preserves one client turn and exposes a recovery action', () => {
  assert.match(chatHtml, /client_request_id:\s*clientRequestId/);
  assert.match(chatHtml, /retry:\s*retrying/);
  assert.match(chatHtml, /Reply interrupted — your progress is safe/);
  assert.match(chatHtml, /Continue reply/);
  assert.match(chatHtml, /data\.recoverable_turn/);
  assert.match(chatHtml, /if \(!retrying\) \{\s*\/\/ The retry reuses/);
});

test('certification continue opens the authoritative saved conversation', () => {
  assert.match(certificationHtml, /\/certification\/modules\/['"]? \+ encodeURIComponent\(moduleId\) \+ ['"]\/resume/);
  assert.match(certificationHtml, /experience\.resume_conversation_id/);
  assert.match(chatHtml, /switchToConversation\(resumeConversationId, 'web'\)/);
  assert.match(chatHtml, /\/resumed`/);
  assert.match(chatHtml, /Continue module \$\{moduleId\} from my saved checkpoint/);
});

test('learner and admin surfaces expose outcome tracking', () => {
  assert.match(certificationHtml, /My protocol contributions/);
  assert.match(certificationHtml, /demonstrations verified/);
  assert.match(adminHtml, /Turn completion/);
  assert.match(adminHtml, /Credential issue time/);
  assert.match(adminHtml, /Contributions submitted/);
});
