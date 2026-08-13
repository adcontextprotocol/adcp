#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

// This temporary patch remains version-locked even though its filename dates
// from the release where it was introduced. Remove it when the upstream
// get_products routing and scoped capability propagation fixes ship.
const EXPECTED_VERSION = '13.0.0-rc.17';
const packageJson = JSON.parse(fs.readFileSync(path.resolve('node_modules/@adcp/sdk/package.json'), 'utf8'));

if (packageJson.version !== EXPECTED_VERSION) {
  throw new Error(
    `Refusing to patch @adcp/sdk ${packageJson.version}; expected ${EXPECTED_VERSION}. ` +
    'Remove this patcher when the upstream storyboard routing and scoped capability fixes ship.',
  );
}

const storyboardTaskMapFiles = [
  'node_modules/@adcp/sdk/dist/lib/testing/storyboard/task-map.js',
  'node_modules/@adcp/sdk/dist/lib/testing/storyboard/task-map.mjs',
];

const singleAgentClientFiles = [
  {
    relative: 'node_modules/@adcp/sdk/dist/lib/core/SingleAgentClient.js',
    resolveAdapterOriginal:
      '    const adapterKey = (0, import_version2.resolveAdapterKey)(this.resolvedAdcpVersion, this.cachedCapabilities);',
    resolveAdapterPatched:
      '    const adapterKey = (0, import_version2.resolveAdapterKey)(this.resolvedAdcpVersion, perCallCapabilities ?? this.cachedCapabilities);',
  },
  {
    relative: 'node_modules/@adcp/sdk/dist/lib/core/SingleAgentClient.mjs',
    resolveAdapterOriginal:
      '    const adapterKey = resolveAdapterKey(this.resolvedAdcpVersion, this.cachedCapabilities);',
    resolveAdapterPatched:
      '    const adapterKey = resolveAdapterKey(this.resolvedAdcpVersion, perCallCapabilities ?? this.cachedCapabilities);',
  },
];

const originalCallParams = '  const callParams = legacyMethodName ? withLegacyCreativeWireHint(params) : params;';
const patchedCallParams = '  const callParams = legacyMethodName && taskName !== "get_products" ? withLegacyCreativeWireHint(params) : params;';

function countOccurrences(source, token) {
  return source.split(token).length - 1;
}

function preparePatch(relative, replacements) {
  const file = path.resolve(relative);
  const source = fs.readFileSync(file, 'utf8');
  const states = replacements.map(({ original, patched, expectedCount = 1 }) => {
    const originalCount = countOccurrences(source, original);
    const patchedCount = countOccurrences(source, patched);
    const needsPatch = originalCount === expectedCount && patchedCount === 0;
    const alreadyPatched = originalCount === 0 && patchedCount === expectedCount;
    if (!needsPatch && !alreadyPatched) {
      throw new Error(`Unexpected ${EXPECTED_VERSION} SDK shape in ${relative}`);
    }
    return needsPatch ? 'original' : 'patched';
  });
  if (new Set(states).size !== 1) {
    throw new Error(`Mixed ${EXPECTED_VERSION} SDK patch state in ${relative}`);
  }
  const output = states[0] === 'original'
    ? replacements.reduce((current, { original, patched }) => current.replaceAll(original, patched), source)
    : source;
  return { file, source, output, replacements };
}

const storyboardTaskMaps = storyboardTaskMapFiles.map(relative => preparePatch(relative, [{
  original: originalCallParams,
  patched: patchedCallParams,
}]));

const adaptRequestSignature =
  '  adaptRequest(taskType, params, serverVersion, debugLogs, perCallToolSchemas) {';
const patchedAdaptRequestSignature =
  '  adaptRequest(taskType, params, serverVersion, debugLogs, perCallToolSchemas, perCallCapabilities) {';
const perCallToolSchemasArgument = 'capabilityDiscoveryContext.toolSchemas\n';
const patchedPerCallToolSchemasArgument =
  'capabilityDiscoveryContext.toolSchemas, capabilityDiscoveryContext.capabilities\n';
const detectServerVersion = `  async detectServerVersion(options) {
    const capabilities = await this.getCapabilities(options);
    return capabilities.version;
  }`;
const patchedDetectServerVersion = `  async detectServerVersion(options) {
    const capabilities = await this.getCapabilities(options);
    const discoveryContext = options?.[CAPABILITY_DISCOVERY_CONTEXT];
    if (discoveryContext) discoveryContext.capabilities = capabilities;
    return capabilities.version;
  }`;

const singleAgentClients = singleAgentClientFiles.map(({
  relative,
  resolveAdapterOriginal,
  resolveAdapterPatched,
}) => preparePatch(relative, [
  {
    original: perCallToolSchemasArgument,
    patched: patchedPerCallToolSchemasArgument,
    expectedCount: 2,
  },
  { original: adaptRequestSignature, patched: patchedAdaptRequestSignature },
  { original: resolveAdapterOriginal, patched: resolveAdapterPatched },
  { original: detectServerVersion, patched: patchedDetectServerVersion },
]));

// Validate both module formats before writing either one so a corrupt or
// unexpected SDK artifact cannot leave the install only partially patched.
for (const { file, source, output } of [...storyboardTaskMaps, ...singleAgentClients]) {
  if (output !== source) {
    fs.writeFileSync(file, output);
  }
}

for (const { file, replacements } of [...storyboardTaskMaps, ...singleAgentClients]) {
  const source = fs.readFileSync(file, 'utf8');
  for (const { original, patched, expectedCount = 1 } of replacements) {
    if (
      countOccurrences(source, original) !== 0 ||
      countOccurrences(source, patched) !== expectedCount
    ) {
      throw new Error(`@adcp/sdk ${EXPECTED_VERSION} patch verification failed for ${file}`);
    }
  }
}
