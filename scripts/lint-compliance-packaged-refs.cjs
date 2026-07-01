#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const DEFAULT_COMPLIANCE_ROOT = path.join(__dirname, '..', 'static', 'compliance', 'source');
const PACKAGED_REF_KEYS = new Set([
  'jwks_source',
  'source_fixture',
  'test_kit',
  'test_vectors',
  'unit_test_fixture',
  'vector_ref',
  'vectors',
]);
const COMPLIANCE_VERSION_PREFIX = '/compliance/{version}/';

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out);
    } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
      out.push(full);
    }
  }
  return out;
}

function collectRefs(value, refs, trail = []) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectRefs(item, refs, trail.concat(String(i))));
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value)) {
    const childTrail = trail.concat(key);
    if (PACKAGED_REF_KEYS.has(key)) {
      if (typeof child === 'string') {
        refs.push({ key, value: child, path: childTrail.join('.') });
      } else if (Array.isArray(child)) {
        child.forEach((item, i) => {
          if (typeof item === 'string') {
            refs.push({ key, value: item, path: childTrail.concat(String(i)).join('.') });
          }
        });
      }
    }
    collectRefs(child, refs, childTrail);
  }
}

function splitFragment(ref) {
  const hash = ref.indexOf('#');
  if (hash === -1) return { fileRef: ref, fragment: '' };
  return {
    fileRef: ref.slice(0, hash),
    fragment: ref.slice(hash + 1),
  };
}

function isExternalRef(ref) {
  return /^[a-z][a-z0-9+.-]*:/i.test(ref);
}

function normalizePackagedRef(ref) {
  if (ref.startsWith(COMPLIANCE_VERSION_PREFIX)) {
    return ref.slice(COMPLIANCE_VERSION_PREFIX.length);
  }
  return ref;
}

function isPathSafe(fileRef) {
  if (!fileRef || path.isAbsolute(fileRef)) return false;
  const normalized = path.posix.normalize(fileRef.replace(/\\/g, '/'));
  return normalized !== '.' && !normalized.startsWith('../') && normalized !== '..';
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveJsonPointer(doc, pointer) {
  if (pointer === '') return true;
  if (!pointer.startsWith('/')) return false;
  let current = doc;
  for (const rawPart of pointer.slice(1).split('/')) {
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
    } else if (current && typeof current === 'object' && Object.hasOwn(current, part)) {
      current = current[part];
    } else {
      return false;
    }
  }
  return true;
}

function resolveVectorFragment(doc, fragment) {
  if (!fragment) return true;
  if (fragment.startsWith('/')) return resolveJsonPointer(doc, fragment);

  const [group, id, ...rest] = fragment.split('/');
  if (rest.length === 0 && Array.isArray(doc[group]) && id) {
    return doc[group].some((item) => item && typeof item === 'object' && item.id === id);
  }
  if (rest.length === 0 && group && Object.hasOwn(doc, group) && !id) {
    return true;
  }
  return false;
}

function validateRef(complianceRoot, yamlFile, ref) {
  if (isExternalRef(ref)) return null;

  const normalizedPackagedRef = normalizePackagedRef(ref);
  const { fileRef, fragment } = splitFragment(normalizedPackagedRef);
  if (!isPathSafe(fileRef)) {
    return `reference must be a relative packaged path, got "${ref}"`;
  }

  const normalizedRef = path.posix.normalize(fileRef.replace(/\\/g, '/'));
  const target = path.join(complianceRoot, normalizedRef);
  if (!fs.existsSync(target)) {
    return `referenced packaged file is missing: ${normalizedRef}`;
  }

  const stat = fs.statSync(target);
  if (fragment && !stat.isFile()) {
    return `fragment "#${fragment}" cannot target a directory: ${normalizedRef}`;
  }

  if (fragment && stat.isFile() && normalizedRef.endsWith('.json')) {
    let doc;
    try {
      doc = readJson(target);
    } catch (err) {
      return `referenced JSON file could not be parsed: ${normalizedRef} (${err.message})`;
    }
    if (!resolveVectorFragment(doc, fragment)) {
      return `fragment "#${fragment}" was not found in ${normalizedRef}`;
    }
  }

  return null;
}

function lint(complianceRoot = DEFAULT_COMPLIANCE_ROOT) {
  const violations = [];
  for (const file of walkFiles(complianceRoot)) {
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }

    const refs = [];
    collectRefs(doc, refs);
    for (const ref of refs) {
      const reason = validateRef(complianceRoot, file, ref.value);
      if (reason) {
        violations.push({
          file: path.relative(complianceRoot, file),
          path: ref.path,
          key: ref.key,
          ref: ref.value,
          reason,
        });
      }
    }
  }
  return violations;
}

function formatViolations(violations) {
  return violations.map((v) =>
    `  ${v.file} ${v.path}: ${v.reason} (${v.key}: ${JSON.stringify(v.ref)})`
  ).join('\n');
}

function assertCompliancePackagedRefs(complianceRoot = DEFAULT_COMPLIANCE_ROOT, context = 'Compliance packaged-reference lint') {
  const violations = lint(complianceRoot);
  if (violations.length === 0) return;
  throw new Error(
    `${context}: ${violations.length} unresolved reference(s).\n\n` +
    formatViolations(violations)
  );
}

if (require.main === module) {
  const complianceRoot = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_COMPLIANCE_ROOT;
  try {
    assertCompliancePackagedRefs(complianceRoot);
  } catch (err) {
    console.error(
      `${err.message}\n\n` +
      `References in compliance YAML must resolve inside the published compliance tree. ` +
      `For versioned test vectors, put the file under static/compliance/source/test-vectors/ ` +
      `and reference it as test-vectors/<name>.json.`
    );
    process.exit(1);
  }
}

module.exports = {
  assertCompliancePackagedRefs,
  lint,
  formatViolations,
  validateRef,
};
