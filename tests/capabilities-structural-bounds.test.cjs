/**
 * #8198: the structural bounds are the protocol's limit on the capabilities
 * response, and `MAX_CAPABILITIES_BYTES` is only a receiver backstop described
 * as deployment guidance. Every array has a maximum item count,
 * every string a maximum length (unless an enum, const, or format constrains
 * it), and every keyed map a maximum member count, across the response schema
 * and every schema it references.
 *
 * A field new in 3.3 or experimental enforces its bound with a schema keyword.
 * A field that was stable before 3.3 carries the bound as a 4.0 annotation,
 * because a minor release may not tighten it. The worst-case document the
 * bounds allow is computed by `scripts/capabilities-structural-bounds.cjs`
 * and pinned here so the figure in security.mdx cannot drift.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');

const bounds = require('../scripts/capabilities-structural-bounds.cjs');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const security = read('docs/building/by-layer/L1/security.mdx');

// The documented worst case. Update security.mdx with this number.
const DOCUMENTED_WORST_CASE_BYTES = 91_804_371;
const DOCUMENTED_OPEN_POSITIONS = 105;

const rows = bounds.coverage();
const KEYWORD_BY_KIND = { array: 'maxItems', string: 'maxLength', map: 'maxProperties' };

describe('capabilities structural bounds (#8198)', () => {
  it('bounds every array, string, and map the response reaches', () => {
    const unbounded = rows.filter((r) => !r.bounded);
    assert.deepEqual(
      unbounded.map((r) => `${r.kind} ${r.key} (${r.trail})`),
      [],
      'every position needs the keyword or its x-max-*-4.0 annotation',
    );
    assert.ok(rows.length > 300, `expected the walk to reach the shared schemas, saw ${rows.length} positions`);
  });

  it('enforces the bound on fields new in 3.3 and on experimental fields', () => {
    const lax = [];
    for (const r of rows) {
      const chain = ancestors(r.file, r.pointer);
      const isNew = chain.some((n) => n && n['x-added-in'] === '3.3.0');
      const isExperimental = chain.some((n) => n && n['x-status'] === 'experimental');
      if ((isNew || isExperimental) && !r.exempt && r.enforced === undefined) lax.push(`${r.kind} ${r.key}`);
    }
    assert.deepEqual(lax, [], 'a new or experimental field must carry the keyword, not only the annotation');
  });

  it('never annotates a limit below the keyword that enforces it', () => {
    for (const r of rows) {
      if (r.enforced !== undefined && r.annotated !== undefined) {
        assert.ok(r.annotated >= r.enforced, `${r.key}: x-max annotation ${r.annotated} < ${KEYWORD_BY_KIND[r.kind]} ${r.enforced}`);
      }
    }
  });

  it('leaves room for every value of a closed vocabulary a list can hold', () => {
    const tight = [];
    for (const r of rows) {
      if (r.kind !== 'array') continue;
      const node = nodeAt(r.file, r.pointer);
      if (!node.uniqueItems || !node.items) continue;
      const items = node.items.$ref ? bounds.resolveRef(node.items.$ref, r.file).node : node.items;
      const values = items.enum || items.anyOf?.find((b) => b.enum)?.enum;
      const limit = r.enforced ?? r.annotated;
      if (values && limit < values.length) tight.push(`${r.key}: ${limit} < ${values.length} enum values`);
    }
    assert.deepEqual(tight, []);
  });

  it('never gives union branches that share a property name different enforced bounds', () => {
    // The TypeScript SDK generator merges a oneOf/anyOf/allOf group into one
    // property and fails on "Conflicting @maxItems values" (#8505 CI).
    const conflicts = [];
    bounds.walk(({ file, node, key }) => {
      const groups = {};
      const collect = (sub, f) => {
        if (sub.$ref) {
          const target = bounds.resolveRef(sub.$ref, f);
          collect(target.node, target.file);
        }
        for (const [name, prop] of Object.entries(sub.properties || {})) {
          const resolved = prop.$ref ? bounds.resolveRef(prop.$ref, f).node : prop;
          for (const keyword of Object.values(KEYWORD_BY_KIND)) {
            if (resolved[keyword] !== undefined) (groups[`${name}:${keyword}`] ||= new Set()).add(resolved[keyword]);
          }
        }
        for (const inner of sub.allOf || []) collect(inner, f);
      };
      for (const k of ['oneOf', 'anyOf', 'allOf']) for (const branch of node[k] || []) collect(branch, file);
      collect({ properties: node.properties || {} }, file);
      for (const [group, values] of Object.entries(groups)) {
        if (values.size > 1) conflicts.push(`${key} ${group} ${[...values]}`);
      }
    });
    assert.deepEqual(conflicts, []);
  });

  it('uses only the three annotation names the docs define', () => {
    const allowed = new Set(Object.values(bounds.ANNOTATION));
    const stray = [];
    bounds.walk(({ key, node }) => {
      for (const name of Object.keys(node)) {
        if (/^x-max-/.test(name) && !allowed.has(name)) stray.push(`${key}: ${name}`);
      }
    });
    assert.deepEqual(stray, []);
  });

  it('keeps the earlier counterparty-asserted list bounds consistent', () => {
    const response = bounds.load(bounds.ROOT_FILE);
    for (const node of [
      response.properties.media_buy.properties.portfolio.properties.publisher_domains,
      response.properties.signals.properties.data_provider_domains,
    ]) {
      const advisory = node['x-adcp-validation'].advisory_bounds;
      assert.equal(node['x-max-items-4.0'], advisory.max_items);
      assert.equal(node.items['x-max-length-4.0'], advisory.item_max_length);
    }
  });
});

describe('exemptions', () => {
  it('measures the longest value an anchored pattern admits', () => {
    const cases = {
      '^[A-Z]{2}$': 2,
      '^sha256:[a-f0-9]{64}$': 71,
      '^[a-z0-9][a-z0-9.-]{2,63}$': 64,
      '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$': 8,
      '^(?=.{1,5}$)[a-z]{1,5}$': 5,
    };
    for (const [pattern, max] of Object.entries(cases)) assert.equal(bounds.patternMaxLength(pattern), max, pattern);
  });

  it('does not treat an unbounded or unanchored pattern as a bound', () => {
    for (const pattern of ['^[a-z][a-z0-9_]*$', '^[0-9]+\\.[0-9]+$', '^a{2,}$', '[A-Z]{2}', '^[A-Z]{2}', undefined]) {
      assert.equal(bounds.patternMaxLength(pattern), Infinity, String(pattern));
    }
  });

  it('exempts only closed-enum uniqueItems arrays and fully bounded strings', () => {
    const reasons = new Set(rows.filter((r) => r.exempt).map((r) => r.exempt));
    assert.deepEqual([...reasons].sort(), ['closed-enum', 'pattern']);
    for (const r of rows.filter((x) => x.exempt)) {
      const node = nodeAt(r.file, r.pointer);
      if (r.exempt === 'closed-enum') assert.equal(node.uniqueItems, true, r.key);
      if (r.exempt === 'pattern') assert.ok(Number.isFinite(bounds.patternMaxLength(node.pattern)), r.key);
    }
  });

  it('states the exemptions in the docs', () => {
    assert.match(security, /Three kinds of position need no keyword/);
    assert.match(security, /anchored `pattern` that admits only values of bounded\s+length/);
    assert.match(security, /`uniqueItems` whose items are a closed `enum` or a `const`/);
  });
});

describe('worst-case document', () => {
  const withAnnotations = bounds.worstCase('4.0');

  it('is finite once the 4.0 bounds apply, and matches the documented figure', () => {
    assert.ok(Number.isFinite(withAnnotations.total), `unbounded positions: ${withAnnotations.unboundedPositions.slice(0, 5)}`);
    assert.equal(withAnnotations.total, DOCUMENTED_WORST_CASE_BYTES);
    assert.equal(withAnnotations.openPositions, DOCUMENTED_OPEN_POSITIONS);
    assert.ok(security.includes(`${DOCUMENTED_WORST_CASE_BYTES.toLocaleString('en-US')} bytes`), 'security.mdx states the pinned figure');
    assert.ok(security.includes(`${DOCUMENTED_OPEN_POSITIONS} positions in the response are open`));
  });

  it('is not finite from the enforced keywords alone, because stable fields only annotate', () => {
    // 3.x enforces nothing new on a stable field. When 4.0 turns the annotations
    // into keywords this assertion flips and the test should be deleted.
    assert.ok(!Number.isFinite(bounds.worstCase('enforced').total));
  });

  it('is above the 4 MiB client default, so the 4.0 follow-ups tighten structure rather than add a byte cap', () => {
    assert.ok(withAnnotations.total > 4 * 1024 * 1024, 'the structural ceiling is above the 4 MiB client default');
    assert.match(security, /The way to lower that ceiling is a tighter structural bound on those\s+nested lists, not a byte cap/);
  });
});

describe('the structural bounds are the limit; the byte figure is a deployment backstop', () => {
  const capabilitiesDoc = read('docs/protocol/get_adcp_capabilities.mdx');
  const v4Doc = read('docs/reference/migration/v4-compatibility.mdx');
  const registry = read('static/compliance/source/universal/v4-compatibility.yaml');
  const backstopParagraph = (text, marker) => {
    const paragraph = text.split(/\n\s*\n/).find((p) => p.includes(marker));
    assert.ok(paragraph, `no paragraph contains ${marker}`);
    return paragraph;
  };

  it('states that the structural bounds are the limit and agents must not design to a byte figure', () => {
    assert.match(security, /\*\*The structural bounds are the limit\.\*\* The structural bounds are the\s+protocol's limit on the `get_adcp_capabilities` response\. Agents \*\*MUST NOT\*\*\s+design to a byte figure\./);
    assert.match(capabilitiesDoc, /The structural bounds are the protocol's limit on this response\. Agents MUST NOT design to a byte figure\./);
    assert.match(v4Doc, /the structural bounds are the protocol's limit on the capabilities document/);
  });

  it('describes MAX_CAPABILITIES_BYTES as a receiver backstop, not a design target', () => {
    const securityBackstop = backstopParagraph(security, '**The byte figure is a receiver backstop.**');
    assert.match(securityBackstop, /Receivers commonly bound response\s+size at the HTTP or gateway layer/);
    assert.match(securityBackstop, /A limit\s+around 64 KiB \(`MAX_CAPABILITIES_BYTES`\) is a reasonable backstop against\s+runaway or hostile documents\. It is not a design target\./);
    assert.match(securityBackstop, /deployment guidance for receivers, not a protocol rule on the response/);
    assert.match(securityBackstop, /keep such a document from exhausting a verifier/);
    const docBackstop = backstopParagraph(capabilitiesDoc, 'Receivers commonly bound response size');
    assert.match(docBackstop, /A limit around 64 KiB \(`MAX_CAPABILITIES_BYTES`\) is a reasonable backstop against runaway or hostile documents\. It is not a design target\./);
    assert.match(docBackstop, /deployment guidance for receivers, not a protocol rule on the response/);
    assert.match(v4Doc, /`MAX_CAPABILITIES_BYTES` \(64 KiB\) stays only as a receiver backstop against runaway or hostile documents, and 4\.0 does not lean on it/);
    assert.match(registry, /MAX_CAPABILITIES_BYTES\s+is only a receiver backstop/);
  });

  it('puts no sender obligation on the backstop', () => {
    // The backstop is deployment guidance for receivers. A MUST or SHOULD in
    // its paragraph would turn it back into a protocol size rule on senders.
    for (const [text, marker] of [
      [security, '**The byte figure is a receiver backstop.**'],
      [capabilitiesDoc, 'Receivers commonly bound response size'],
    ]) {
      assert.doesNotMatch(backstopParagraph(text, marker), /\b(MUST|SHOULD|REQUIRED|SHALL)\b/);
    }
  });

  it('describes the backstop with the protocol, not as an absence of any byte figure', () => {
    for (const [name, text] of Object.entries({
      'security.mdx': security,
      'get_adcp_capabilities.mdx': capabilitiesDoc,
      'v4-compatibility.mdx': v4Doc,
      'managing-response-size.mdx': read('docs/building/concepts/managing-response-size.mdx'),
      '3-2-to-3-3.mdx': read('docs/reference/migration/3-2-to-3-3.mdx'),
    })) {
      assert.doesNotMatch(text, /AdCP sets no byte limit/i, `${name} still says AdCP sets no byte limit`);
    }
  });

  it('does not keep the byte budget as an operative cap or a safety net', () => {
    const sources = {
      'security.mdx': security,
      'get_adcp_capabilities.mdx': capabilitiesDoc,
      'v4-compatibility.mdx': v4Doc,
      'v4-compatibility.yaml': registry,
      'managing-response-size.mdx': read('docs/building/concepts/managing-response-size.mdx'),
      '3-2-to-3-3.mdx': read('docs/reference/migration/3-2-to-3-3.mdx'),
      'whats-new-in-3-3.mdx': read('docs/reference/whats-new-in-3-3.mdx'),
    };
    for (const [name, text] of Object.entries(sources)) {
      assert.doesNotMatch(text, /operative cap/i, `${name} still calls a byte limit the operative cap`);
      for (const paragraph of text.split(/\n\s*\n/)) {
        if (!/MAX_CAPABILITIES_BYTES|64 KiB/.test(paragraph)) continue;
        assert.doesNotMatch(paragraph, /safety net/i, `${name} still calls the capabilities byte budget a safety net`);
      }
    }
  });

  it('keeps the constant name so existing references resolve', () => {
    assert.equal(bounds.MAX_CAPABILITIES_BYTES, 65_536);
    assert.ok(bounds.worstCase('4.0').total > bounds.MAX_CAPABILITIES_BYTES, 'the structural worst case is above the backstop, which is why 4.0 tightens structure');
  });
});

describe('what the decision changes in the docs', () => {
  it('adds no request field', () => {
    const request = JSON.parse(read('static/schemas/source/protocol/get-adcp-capabilities-request.json'));
    assert.equal(request.properties.scope, undefined);
  });

  it('says key material and key pointers stay out of capabilities on any new path', () => {
    assert.match(security, /\*\*Key material and key pointers do not belong in capabilities\.\*\*/);
    assert.match(security, /No new path reads keys, or a pointer to keys, from `get_adcp_capabilities`/);
    assert.match(security, /MUST NOT be added to the capabilities response/);
    const response = bounds.load(bounds.ROOT_FILE);
    assert.match(response.properties.identity.properties.brand_json_url.description, /No new path reads key material or a key pointer from capabilities/);
    assert.match(read('docs/building/by-layer/L1/wba-profile.mdx'), /never fetches `get_adcp_capabilities` for keys/);
  });

  it('keeps the deprecated RFC 9421 chain on the 64 KiB budget and points large catalogs at Web Bot Auth', () => {
    assert.match(security, /\*\*The capabilities budget binds this path only\.\*\*/);
    assert.match(security, /const MAX_CAPABILITIES_BYTES = 65_536; +\/\/ deprecated RFC 9421 chain only/);
    assert.match(security, /body: MAX_CAPABILITIES_BYTES, maxRedirects: 0/);
    assert.match(security, /It is not a protocol limit on the `get_adcp_capabilities` response, which is bounded by structure/);
    assert.match(security, /That budget is unchanged through 3\.x, and 4\.0 removes it with the chain\./);
    assert.match(security, /`MAX_CAPABILITIES_BYTES` \(64 KiB, on the capabilities\s+fetch of the deprecated RFC 9421 key-discovery chain only\)/);
    assert.match(security, /adopts the Web Bot Auth profile or keeps the document under the budget/);
    assert.match(security, /3\.x does not add a way around the limit to the RFC 9421 profile/);
  });

  it('lists the nested multipliers as 4.0 follow-ups', () => {
    const registry = yaml.load(read('static/compliance/source/universal/v4-compatibility.yaml'));
    const entry = registry.checks.find((c) => c.id === 'capabilities_structural_bounds_required_in_4_0');
    assert.match(entry.follow_ups.join(' '), /brand-ref[^]*provenance[^]*format\s+declaration[^]*macro_resolution_capabilities/);
    assert.match(security, /Tightening those nested limits is registered as a 4\.0 follow-up/);
  });

  it('registers the stable-field annotations as a 4.0 tightening', () => {
    const registry = yaml.load(read('static/compliance/source/universal/v4-compatibility.yaml'));
    const entry = registry.checks.find((c) => c.id === 'capabilities_structural_bounds_required_in_4_0');
    assert.ok(entry, 'registry entry missing');
    assert.equal(entry.issue, 8198);
    assert.ok(entry.observed_by.none.reason);
    assert.match(read('docs/reference/migration/v4-compatibility.mdx'), /<a id="capabilities_structural_bounds_required_in_4_0"><\/a>/);
  });
});

function nodeAt(file, pointer) {
  let node = bounds.load(file);
  for (const seg of pointer.replace(/^#\/?/, '').split('/').filter(Boolean)) {
    node = node?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node;
}

function ancestors(file, pointer) {
  const chain = [bounds.load(file)];
  let node = chain[0];
  for (const seg of pointer.replace(/^#\/?/, '').split('/').filter(Boolean)) {
    node = node?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
    chain.push(node);
  }
  return chain;
}
