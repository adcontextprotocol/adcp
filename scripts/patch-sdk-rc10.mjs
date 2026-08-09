#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const EXPECTED_VERSION = '13.0.0-rc.10';
const packageJson = JSON.parse(fs.readFileSync(path.resolve('node_modules/@adcp/sdk/package.json'), 'utf8'));

if (packageJson.version !== EXPECTED_VERSION) {
  throw new Error(
    `Refusing to patch @adcp/sdk ${packageJson.version}; expected ${EXPECTED_VERSION}. ` +
    'Remove this patcher when the upstream conditional sync_creatives registration ships.',
  );
}

const runtimeFiles = [
  'node_modules/@adcp/sdk/dist/lib/server/decisioning/runtime/from-platform.js',
  'node_modules/@adcp/sdk/dist/lib/server/decisioning/runtime/from-platform.mjs',
];
const clientFiles = [
  'node_modules/@adcp/sdk/dist/lib/core/SingleAgentClient.js',
  'node_modules/@adcp/sdk/dist/lib/core/SingleAgentClient.mjs',
];
const storyboardTaskMapFiles = [
  'node_modules/@adcp/sdk/dist/lib/testing/storyboard/task-map.js',
  'node_modules/@adcp/sdk/dist/lib/testing/storyboard/task-map.mjs',
];

for (const relative of runtimeFiles) {
  const file = path.resolve(relative);
  let source = fs.readFileSync(file, 'utf8');
  const patchedStart = '    ...sales?.syncCreatives && { syncCreatives: async (params, ctx) => {';
  if (source.includes(patchedStart)) continue;

  const originalStart = '    syncCreatives: async (params, ctx) => {';
  const nextHandler = '    ...sales?.getMediaBuyDelivery && {';
  const start = source.indexOf(originalStart);
  const end = source.indexOf(nextHandler, start);
  if (start < 0 || end < 0) {
    throw new Error(`Unexpected rc.10 media-buy handler shape in ${relative}`);
  }

  let handler = source.slice(start, end).replace(originalStart, patchedStart);
  const closing = handler.lastIndexOf('\n    },');
  if (closing < 0) throw new Error(`Could not locate sync_creatives handler boundary in ${relative}`);
  handler = `${handler.slice(0, closing)}\n    } },${handler.slice(closing + '\n    },'.length)}`;
  source = `${source.slice(0, start)}${handler}${source.slice(end)}`;
  fs.writeFileSync(file, source);
}

const originalLegacyClientMethod = `  async syncCreativesLegacy(params, inputHandler, options) {
    return await this.syncCreatives(
      params,
      inputHandler,
      options
    );
  }`;
const patchedLegacyClientMethod = `  async syncCreativesLegacy(params, inputHandler, options) {
    return await this.executeTaskUnprojected("sync_creatives", params, inputHandler, options);
  }`;

for (const relative of clientFiles) {
  const file = path.resolve(relative);
  let source = fs.readFileSync(file, 'utf8');
  if (!source.includes(patchedLegacyClientMethod)) {
    if (!source.includes(originalLegacyClientMethod)) {
      throw new Error(`Unexpected rc.10 legacy client shape in ${relative}`);
    }
    source = source.replace(originalLegacyClientMethod, patchedLegacyClientMethod);
    fs.writeFileSync(file, source);
  }
}

const originalStoryboardCallParams = '  const callParams = legacyMethodName ? withLegacyCreativeWireHint(params) : params;';
const patchedStoryboardCallParams = '  const callParams = legacyMethodName && taskName !== "get_products" ? withLegacyCreativeWireHint(params) : params;';

for (const relative of storyboardTaskMapFiles) {
  const file = path.resolve(relative);
  let source = fs.readFileSync(file, 'utf8');
  if (!source.includes(patchedStoryboardCallParams)) {
    if (!source.includes(originalStoryboardCallParams)) {
      throw new Error(`Unexpected rc.10 storyboard task-map shape in ${relative}`);
    }
    source = source.replace(originalStoryboardCallParams, patchedStoryboardCallParams);
    fs.writeFileSync(file, source);
  }
}

for (const relative of runtimeFiles) {
  const source = fs.readFileSync(path.resolve(relative), 'utf8');
  if (!source.includes('...sales?.syncCreatives && { syncCreatives: async (params, ctx) => {')) {
    throw new Error(`@adcp/sdk rc.10 patch verification failed for ${relative}`);
  }
}
for (const relative of clientFiles) {
  const source = fs.readFileSync(path.resolve(relative), 'utf8');
  if (!source.includes(patchedLegacyClientMethod)) {
    throw new Error(`@adcp/sdk rc.10 legacy client patch verification failed for ${relative}`);
  }
}
for (const relative of storyboardTaskMapFiles) {
  const source = fs.readFileSync(path.resolve(relative), 'utf8');
  if (!source.includes(patchedStoryboardCallParams)) {
    throw new Error(`@adcp/sdk rc.10 storyboard task-map patch verification failed for ${relative}`);
  }
}
