/**
 * Deterministic, no-network regression evaluation for the observed Addie
 * long-question / long-answer incident shape.
 *
 * Example:
 * npx tsx server/tests/manual/fixed-trace-incident-eval.ts --output=.context/evals/addie-long-form.json
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import {
  FIXED_TRACE_INCIDENT_EVAL_VERSION,
  createFixedTraceIncidentClient,
  runFixedTraceIncidentEval,
} from '../../src/addie/eval/fixed-trace-incident-eval.js';
import { FIXED_TRACE_SUITE } from '../../src/addie/eval/fixed-trace-suite.js';
import {
  createAddieChatRouter,
  type PreparedRequest,
  type WebChatRequestThreadService,
} from '../../src/routes/addie-chat.js';

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseSse(body: string): Array<{ event: string; data: unknown }> {
  return body.split('\n\n').flatMap((frame) => {
    const event = /^event: ([^\n]+)$/m.exec(frame)?.[1];
    const data = /^data: (.+)$/m.exec(frame)?.[1];
    if (!event || !data) return [];
    return [{ event, data: JSON.parse(data) }];
  });
}

/**
 * Drive the actual web JSON and SSE handlers over loopback only. Both the
 * thread store and provider transport are in-memory, so this verifies the
 * delivery wrappers without a database, network provider, or user side effect.
 */
async function evaluateWebDelivery(): Promise<{
  webJsonDelivery: boolean;
  webSseDelivery: boolean;
  webJsonSseParity: boolean;
  webPersistenceIntegrity: boolean;
  web: {
    jsonOutputSha256: string | null;
    sseOutputSha256: string | null;
    persistedOutputSha256: string | null;
  };
}> {
  const trace = FIXED_TRACE_SUITE.find((candidate) => candidate.id === 'long-form-deck-delivery');
  if (!trace) throw new Error('Missing long-form fixed trace incident fixture');

  const persisted: Array<{ role: string; content: string }> = [];
  const thread = {
    thread_id: 'fixed-trace-web-thread',
    user_type: 'anonymous' as const,
    user_id: 'fixed-trace-web-owner',
    message_count: 0,
  };
  const threadService: WebChatRequestThreadService = {
    getOrCreateThread: async () => thread,
    getThreadByExternalId: async () => thread,
    claimAnonymousThread: async () => thread,
    getThreadMessages: async () => [],
    addMessage: async (message) => {
      persisted.push({ role: message.role, content: message.content });
      return { message_id: `fixed-trace-web-message-${persisted.length}` };
    },
    getMessagesByClientRequestId: async () => [],
    claimClientTurn: async () => ({ state: 'claimed', leaseId: 'fixed-trace-web-lease' }),
    renewClientTurnLease: async () => true,
    setClientTurnStatus: async () => true,
  };
  const prepareRequest = async (message: string): Promise<PreparedRequest> => ({
    messageToProcess: message,
    requestContext: 'Fixed-trace no-network web evaluation.',
    memberContext: null,
    requestTools: { tools: [], handlers: new Map() },
    siRetrievalTimeMs: 0,
    siAgents: [],
    hasCertificationContext: false,
    hasThreadCertificationContext: false,
    certificationModuleContext: {},
    certificationProgress: [],
    threadExternalId: 'fixed-trace-web-external',
    isAAOAdmin: false,
  });
  const app = express();
  app.use(express.json());
  // The production app mounts cookie parsing before this router. Reproduce
  // that prerequisite explicitly so the anonymous-owner path is exercised.
  app.use((req, _res, next) => {
    req.cookies = {};
    next();
  });
  app.use('/api/addie/chat', createAddieChatRouter({
    chatClient: createFixedTraceIncidentClient(),
    router: null,
    requestThreadService: threadService,
    prepareRequest,
    evaluationMode: true,
  }).apiRouter);

  const json = await request(app)
    .post('/api/addie/chat')
    .send({ message: trace.request.message })
    .expect(200);
  const stream = await request(app)
    .post('/api/addie/chat/stream')
    .send({ message: trace.request.message })
    .expect(200);
  const jsonText = typeof json.body.response === 'string' ? json.body.response : null;
  const streamEvents = parseSse(stream.text);
  const streamText = streamEvents
    .filter((event): event is { event: string; data: { text: string } } => (
      event.event === 'text'
      && typeof event.data === 'object'
      && event.data !== null
      && typeof (event.data as { text?: unknown }).text === 'string'
    ))
    .map((event) => event.data.text)
    .join('');
  const assistantMessages = persisted.filter((message) => message.role === 'assistant');
  const persistedText = assistantMessages.at(-1)?.content ?? null;
  return {
    webJsonDelivery: jsonText !== null && jsonText.length > 9_500,
    webSseDelivery: streamText.length > 9_500
      && streamEvents.some((event) => event.event === 'done'),
    webJsonSseParity: jsonText !== null && jsonText === streamText,
    webPersistenceIntegrity: jsonText !== null
      && assistantMessages.length === 2
      && assistantMessages.every((message) => message.content === jsonText),
    web: {
      jsonOutputSha256: jsonText ? sha256(jsonText) : null,
      sseOutputSha256: streamText ? sha256(streamText) : null,
      persistedOutputSha256: persistedText ? sha256(persistedText) : null,
    },
  };
}

const outputArgument = argument('output');
if (!outputArgument?.trim()) throw new Error('--output is required');
const outputPath = resolve(outputArgument);
const sourceFiles = [
  'server/src/addie/eval/fixed-trace-incident-eval.ts',
  'server/src/addie/eval/fixed-trace-suite.ts',
  'server/src/addie/claude-client.ts',
  'server/src/addie/security.ts',
  'server/src/addie/direct-message-delivery.ts',
  'server/src/addie/bolt-app.ts',
  'server/src/routes/addie-chat.ts',
  'server/tests/manual/fixed-trace-incident-eval.ts',
];
const sourceBundleSha256 = createHash('sha256')
  .update(sourceFiles.map((file) => `${file}\0${readFileSync(file, 'utf8')}`).join('\0'), 'utf8')
  .digest('hex');
const coreArtifact = await runFixedTraceIncidentEval();
const webDelivery = await evaluateWebDelivery();
const { web, ...webDimensions } = webDelivery;
const webCoreDeliveryParity = web.jsonOutputSha256 === coreArtifact.deliveries
  .find((delivery) => delivery.provider === 'anthropic')?.json.outputSha256;
const artifact = {
  ...coreArtifact,
  dimensions: { ...coreArtifact.dimensions, ...webDimensions, webCoreDeliveryParity },
  web,
  passed: coreArtifact.passed
    && webDelivery.webJsonDelivery
    && webDelivery.webSseDelivery
    && webDelivery.webJsonSseParity
    && webDelivery.webPersistenceIntegrity
    && webCoreDeliveryParity,
  sourceBundleSha256,
  gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  gitDirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
console.log(JSON.stringify({
  outputPath,
  artifactVersion: FIXED_TRACE_INCIDENT_EVAL_VERSION,
  traceSuiteVersion: artifact.traceSuiteVersion,
  traceSuiteSha256: artifact.traceSuiteSha256,
  sourceBundleSha256,
  passed: artifact.passed,
  dimensions: artifact.dimensions,
}, null, 2));
if (!artifact.passed) process.exitCode = 1;
