'use strict';

/**
 * YAML sources for the compliance build and its lints, parsed once per
 * process.
 *
 * scripts/build-compliance.cjs runs its lints in its own process, and every
 * lint reads the same storyboard sources. loadYamlFile reads the file on
 * every call, so an edited file is never served stale, but parses each
 * distinct text only once. Every caller gets its own deep copy of the
 * document, so a lint that changes what it loaded cannot affect another lint.
 * A parse error is not cached: the next call parses again and throws the same
 * error.
 */

const fs = require('node:fs');
const yaml = require('js-yaml');
// The deep copy lives in the projection module because the schemas build,
// whose cache input set lists that file, uses it too.
const { clonePlainData } = require('./mcp-schema-projection.cjs');

const parsedByText = new Map();

/** The YAML document in `file`: what yaml.load(fs.readFileSync(file, 'utf8')) returns. */
function loadYamlFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (!parsedByText.has(text)) parsedByText.set(text, yaml.load(text));
  return clonePlainData(parsedByText.get(text));
}

module.exports = { loadYamlFile };
