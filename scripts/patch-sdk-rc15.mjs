#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const EXPECTED_VERSION = '13.0.0-rc.15';
const packageJson = JSON.parse(fs.readFileSync(path.resolve('node_modules/@adcp/sdk/package.json'), 'utf8'));

if (packageJson.version !== EXPECTED_VERSION) {
  throw new Error(
    `Refusing to patch @adcp/sdk ${packageJson.version}; expected ${EXPECTED_VERSION}. ` +
    'Remove this patcher when the upstream storyboard get_products routing fix ships.',
  );
}

const storyboardTaskMapFiles = [
  'node_modules/@adcp/sdk/dist/lib/testing/storyboard/task-map.js',
  'node_modules/@adcp/sdk/dist/lib/testing/storyboard/task-map.mjs',
];

const originalCallParams = '  const callParams = legacyMethodName ? withLegacyCreativeWireHint(params) : params;';
const patchedCallParams = '  const callParams = legacyMethodName && taskName !== "get_products" ? withLegacyCreativeWireHint(params) : params;';

function countOccurrences(source, token) {
  return source.split(token).length - 1;
}

const storyboardTaskMaps = storyboardTaskMapFiles.map(relative => {
  const file = path.resolve(relative);
  const source = fs.readFileSync(file, 'utf8');
  const originalCount = countOccurrences(source, originalCallParams);
  const patchedCount = countOccurrences(source, patchedCallParams);
  const needsPatch = originalCount === 1 && patchedCount === 0;
  const alreadyPatched = originalCount === 0 && patchedCount === 1;
  if (!needsPatch && !alreadyPatched) {
    throw new Error(`Unexpected ${EXPECTED_VERSION} storyboard task-map shape in ${relative}`);
  }
  return {
    file,
    source,
    output: needsPatch ? source.replace(originalCallParams, patchedCallParams) : source,
  };
});

// Validate both module formats before writing either one so a corrupt or
// unexpected SDK artifact cannot leave the install only partially patched.
for (const { file, source, output } of storyboardTaskMaps) {
  if (output !== source) {
    fs.writeFileSync(file, output);
  }
}

for (const relative of storyboardTaskMapFiles) {
  const source = fs.readFileSync(path.resolve(relative), 'utf8');
  if (
    countOccurrences(source, originalCallParams) !== 0 ||
    countOccurrences(source, patchedCallParams) !== 1
  ) {
    throw new Error(`@adcp/sdk ${EXPECTED_VERSION} storyboard task-map patch verification failed for ${relative}`);
  }
}
