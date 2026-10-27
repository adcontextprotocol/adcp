/**
 * Contract test for the client-side response-size bound.
 *
 * A seller agent that answers a discovery call with tens of megabytes is an
 * availability attack on every buyer that reads the body before checking its
 * size. The normative client obligation lives in `security.mdx` under
 * "Response Size Bounds"; the transport profiles restate it with their own
 * defaults, and the migration guide carries the adopter-facing warning.
 *
 * Each assertion below pins one property that closes a specific bypass. A
 * byte cap alone does not close the reported bug — the parse bounds, the
 * deadline, the raw-byte count and the SSE accounting rule each cover a way a
 * hostile peer stays conformant and still exhausts the client — so the tests
 * fail if any of them is dropped rather than only if the 4 MiB figure moves.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const DOCS = path.join(__dirname, '..', 'docs');
const SECURITY = 'building/by-layer/L1/security.mdx';
const MCP_EXTRACTION = 'building/by-layer/L0/mcp-response-extraction.mdx';
const A2A_EXTRACTION = 'building/by-layer/L0/a2a-response-extraction.mdx';
const RESPONSE_SIZE = 'building/concepts/managing-response-size.mdx';
const MIGRATION = 'reference/migration/3-2-to-3-3.mdx';

const CEILING_BYTES = 4 * 1024 * 1024;
const SECTION_ANCHOR = '/docs/building/by-layer/L1/security#response-size-bounds';

const read = (relative) => fs.readFileSync(path.join(DOCS, relative), 'utf8');

/** Mintlify's heading-to-anchor slug. */
function slugify(heading) {
  return heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9_\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Body of the section with the given heading, up to the next heading of the same or higher level. */
function section(content, heading) {
  const level = heading.match(/^#+/)[0].length;
  const start = content.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, `missing heading: ${heading}`);
  const rest = content.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next === -1 ? rest : rest.slice(0, next);
}

describe('client response-size bound (security.mdx)', () => {
  const body = section(read(SECURITY), '### Response Size Bounds');

  it('states the 4 MiB default ceiling with its exact byte count', () => {
    assert.match(body, /4 MiB \(4,194,304 bytes\)/);
    assert.equal(4_194_304, CEILING_BYTES);
  });

  it('covers the async MCP retrieval path, not just tools/call', () => {
    // An async seller returns the large payload through tasks/result. Naming
    // only tools/call leaves the same OOM one hop away.
    assert.match(body, /`tasks\/get` and\s+`tasks\/result`/);
    assert.match(body, /`initialize`/);
  });

  it('requires enforcement while the body is received, not after buffering', () => {
    assert.match(body, /enforced while the body is received/i);
    assert.match(body, /aborted as soon as the count exceeds the\s+limit/i);
    assert.match(body, /after the body is buffered, decoded, or parsed is\s+not such a bound/i);
    // The buffered-body convenience APIs are the footgun in all four target SDKs.
    assert.match(body, /stream=True/);
    assert.match(body, /io\.ReadAll/);
  });

  it('requires pre-rejecting an over-limit or self-contradictory Content-Length', () => {
    assert.match(body, /`Content-Length` already above the\s+limit is rejected before the body is read/i);
    assert.match(body, /absent, chunked, or understated/i);
    assert.match(body, /`Transfer-Encoding: chunked`/);
  });

  it('pairs the cap with a deadline so a slow body cannot hold a worker', () => {
    assert.match(body, /connect timeout, a read-idle timeout,\s+and a total deadline/i);
    assert.match(body, /drips\s+bytes below the cap forever/i);
  });

  it('bounds raw bytes and decoded bytes, and the decoder output buffer', () => {
    assert.match(body, /bytes received \*and\* to the bytes after content decoding/i);
    assert.match(body, /decompressor's output buffer is bounded/i);
    assert.match(body, /`Accept-Encoding: identity`/);
  });

  it('counts every SSE byte and scopes the cumulative bound to retained bytes', () => {
    assert.match(body, /comment and keepalive lines/i);
    assert.match(body, /on bytes accumulated rather than on events dispatched/i);
    assert.match(body, /total decoded bytes the client \*\*retains\*\* for one\s+task/i);
    assert.match(body, /resumes its count rather than resetting it/i);
    assert.match(body, /`Content-Type: text\/event-stream`/);
  });

  it('bounds parse depth and node count after the byte cap passes', () => {
    // The byte cap bounds ingress; this is what bounds memory.
    assert.match(body, /nesting depth of 64/);
    assert.match(body, /100,000 aggregate object members and array elements/);
    assert.match(body, /A byte cap bounds ingress; it does not\s+bound memory/i);
  });

  it('requires an error rather than truncation, with a distinct client-local type', () => {
    assert.match(body, /It errors; it does not truncate/i);
    assert.match(body, /`ResponseTooLarge`/);
    assert.match(body, /client-local error class, not an `adcp_error\.code`/i);
    assert.match(body, /MUST NOT automatically retry the same\s+request/);
    assert.match(body, /MUST NOT carry a prefix,\s+sample, or excerpt of the oversized body/);
  });

  it('requires per-agent and per-call configuration, and forbids a default opt-out', () => {
    assert.match(body, /configurable per agent and per call/i);
    assert.match(body, /MUST NOT ship an\s+unbounded mode as the default/);
    assert.match(body, /separately named unsafe switch/i);
    assert.match(body, /not settable per call/i);
  });

  it('bounds aggregate exposure across a fan-out batch, in nodes as well as bytes', () => {
    assert.match(body, /concurrent in-flight response reads/i);
    assert.match(body, /individually conformant and collectively fatal/i);
    // Raising the per-call default 4x makes the aggregate term the one that bites.
    assert.match(body, /not multiplied by concurrency/i);
    assert.match(body, /N . 100,000 nodes resident/);
  });

  it('says the node bound does not limit a single scalar', () => {
    assert.match(body, /do not bound the length of a single scalar/i);
    assert.match(body, /Per-field length\s+limits, not the node count/i);
  });

  it('states precedence over path-specific caps so the ceiling does not loosen them', () => {
    assert.match(body, /ceiling on what a \*default\* may be/i);
    for (const cap of ['MAX_BRAND_JSON_BYTES', 'MAX_JWKS_BYTES', 'MAX_CAPABILITIES_BYTES']) {
      assert.ok(body.includes(cap), `precedence paragraph must name ${cap}`);
    }
    assert.match(body, /4096-byte `adcp_error` cap/);
    assert.match(body, /backstop for a path with no cap of its own/i);
  });

  it('confines the capabilities budget to the RFC 9421 profile and points large catalogs at Web Bot Auth (#8198)', () => {
    const rs = read(RESPONSE_SIZE);
    assert.match(rs, /binds only the discovery path of the \[RFC 9421 signing profile\]/);
    assert.match(rs, /adds no way around it to that profile/);
    assert.match(rs, /Adopt the \[Web Bot Auth profile\][^]*keep the capabilities document under 64 KiB/);
    assert.doesNotMatch(rs, /scope: "signing_discovery"/, 'no request field was added');
    const sec = read(SECURITY);
    assert.match(sec, /\*\*The capabilities budget binds this path only\.\*\*/);
    assert.match(sec, /3\.x does not add a way around the limit to the RFC 9421 profile/);
  });

  it('points large-catalog producers at pagination rather than raised buyer limits', () => {
    assert.match(body, /it does not ask buyers to raise their limits/i);
  });

  it('tells agents to keep discovery surfaces under the default client cap', () => {
    assert.match(body, /Discovery responses stay small/);
    for (const surface of ['`tools/list`', '`get_adcp_capabilities`', 'A2A agent card']) {
      assert.ok(body.includes(surface), `discovery clause must cover ${surface}`);
    }
    assert.match(body, /MAX_CAPABILITIES_BYTES` \(64 KiB\)/);
    assert.match(body, /request_signature_capabilities_unreachable/);
    // Recourse differs per surface; claiming none anywhere was the overstatement.
    assert.match(body, /narrow `get_adcp_capabilities` with `protocols\[\]`/);
    assert.match(body, /page size is the server's choice/i);
  });

  it('states that both transports default to 4 MiB without raising path caps', () => {
    assert.match(body, /Both transport profiles default to 4 MiB/);
    assert.match(body, /Aligning the transport defaults raises\s+none of these/);
    assert.match(body, /A tighter default is always conformant; a larger one is not/);
  });

  it('says whether inbound pushed deliveries are in scope', () => {
    assert.match(body, /A2A push notifications and/i);
    assert.match(body, /own request-body cap/i);
  });

  it('is reachable from the buyer-agent security checklist', () => {
    const checklist = section(read(SECURITY), '### For Buyer Agents (AdCP Clients)');
    assert.match(checklist, /\(#response-size-bounds\)/);
  });
});

describe('Inbound body bounds', () => {
  const body = section(read(SECURITY), '### Inbound body bounds');

  it('bounds the body before RFC 9421 or WBA verification', () => {
    assert.match(body, /pre-rejects on `Content-Length`/);
    assert.match(body, /\*\*before\*\* RFC 9421 or WBA verification/);
    assert.match(body, /maximum JSON nesting depth of 64/);
    assert.match(body, /100,000 aggregate object members/);
  });

  it('rejects with 413, never truncates, and defaults to 4 MiB', () => {
    assert.match(body, /HTTP `413 Content Too Large`/);
    assert.match(body, /does not truncate/);
    assert.match(body, /no more than 4 MiB \(4,194,304 bytes\)/);
  });

  it('lets a tighter per-feature cap govern', () => {
    assert.match(body, /that cap governs that feature's deliveries/);
  });

  it('is pointed at from the webhook verifier checklist and the buyer checklist', () => {
    assert.match(section(read(SECURITY), '#### Webhook callbacks'), /\(#inbound-body-bounds\)/);
    assert.match(section(read(SECURITY), '### For Buyer Agents (AdCP Clients)'), /\(#inbound-body-bounds\)/);
  });
});

describe('transport profiles restate the bound', () => {
  for (const [name, relative] of [['MCP', MCP_EXTRACTION], ['A2A', A2A_EXTRACTION]]) {
    describe(name, () => {
      const body = section(read(relative), '### Size Limits');

      it('links to the normative client obligation', () => {
        assert.ok(body.includes(SECTION_ANCHOR), `must link to ${SECTION_ANCHOR}`);
      });

      it('covers SSE per event and cumulatively, across resumption', () => {
        assert.match(body, /text\/event-stream/);
        assert.match(body, /resumption/i);
      });

      it('states a whole-call default of 4 MiB, matching the SDKs', () => {
        // The two transports must not diverge: an SDK picking 4 MiB for one
        // and 1 MiB for the other makes the same response succeed on one
        // transport and fail on the other.
        assert.match(
          body,
          name === 'MCP'
            ? /4 MiB is the MCP default/
            : /whole-call default is \*\*4 MiB \(4,194,304 bytes\)\*\*, matching the MCP profile/,
        );
        assert.match(body, /ceiling on a default/i);
        // Both branches must pin the exact byte count, not just the prose.
        assert.ok(
          body.includes('4,194,304 bytes') || read(SECURITY).includes('4 MiB (4,194,304 bytes)'),
        );
        // Silently reverting this transport to 1 MiB is the failure pinned here.
        assert.doesNotMatch(body, /(whole-call|MCP) default is \*?\*?1 MiB/);
      });

      it('carries the parse and deadline bounds forward, not just the byte cap', () => {
        assert.match(body, /deadline/i);
        assert.match(body, /depth and node count/i);
      });
    });
  }

  it('A2A sets the per-DataPart bound to the call limit, not a tighter number', () => {
    // The single-artifact invariant makes the authoritative DataPart the whole
    // response, so any tighter per-part figure silently becomes the effective
    // A2A cap and diverges from MCP on a byte-identical payload.
    const body = section(read(A2A_EXTRACTION), '### Size Limits');
    assert.match(body, /no single part exceeds the configured call limit/);
    assert.match(body, /single-artifact invariant/);
    assert.doesNotMatch(body, /maximum DataPart size \(recommended 1 MiB\)/);
  });

  it('no L0 transport profile states a sub-default byte figure without justifying it', () => {
    // This is the invariant both transports broke: a tighter inner bound that
    // nothing explains becomes the real cap.
    for (const relative of [MCP_EXTRACTION, A2A_EXTRACTION]) {
      const body = section(read(relative), '### Size Limits');
      const figures = [...body.matchAll(/(\d+(?:,\d{3})*)\s*(KiB|MiB)\b/g)].map(([, v, u]) => ({
        bytes: Number(v.replace(/,/g, '')) * (u === 'MiB' ? 1024 * 1024 : 1024),
        text: `${v} ${u}`,
      }));
      for (const f of figures) {
        if (f.bytes >= CEILING_BYTES) continue;
        assert.ok(
          /tighter|target|deliberate|same limit|producer/i.test(body),
          `${relative} cites ${f.text}, below the ${CEILING_BYTES}-byte default, with no justification clause`,
        );
      }
    }
  });

  it('MCP covers both the single-JSON and SSE Streamable HTTP shapes', () => {
    const body = section(read(MCP_EXTRACTION), '### Size Limits');
    assert.match(body, /single `application\/json` body or with an SSE stream/i);
    assert.match(body, /stdio/);
  });
});

describe('pagination guidance (managing-response-size.mdx)', () => {
  const content = read(RESPONSE_SIZE);

  it('tells large-catalog sellers to paginate rather than rely on raised buyer limits', () => {
    const body = section(content, '## Pagination for cardinality control');
    assert.match(body, /Paginate; do not ask buyers to raise their limits/);
    assert.match(body, /over-limit response as an error, not as a truncated page/i);
    assert.ok(body.includes(SECTION_ANCHOR));
  });

  it('ties the interoperability target to the general client bound without raising it', () => {
    const body = section(content, '## Interoperability size target');
    assert.ok(body.includes(SECTION_ANCHOR));
    assert.match(body, /That cap defaults to 4 MiB/);
    // The producer target and the client backstop must not be conflated now
    // that they are thirty-fold apart.
    assert.match(body, /32x gap/);
    assert.match(body, /not slack a producer may spend/i);
  });

  it('tells agents to keep every discovery surface small', () => {
    const body = section(content, '## Discovery responses stay small');
    for (const surface of ['`tools/list`', '`get_adcp_capabilities`', 'A2A agent card']) {
      assert.ok(body.includes(surface), `discovery guidance must cover ${surface}`);
    }
    // An oversized discovery response is not slow, it is unreachable.
    assert.match(body, /MAX_CAPABILITIES_BYTES/);
    assert.match(body, /paginate a large catalog/i);
    // The agent-card figure is editorial; reading it as a cap breaks interop
    // with agents the spec calls conformant.
    assert.match(body, /No normative cap exists/);
    assert.match(body, /MUST NOT reject an agent card at 64 KiB/);
    // The capabilities figure binds RFC 9421 signers only; the response itself
    // is bounded by structure, not by bytes (#8198).
    assert.match(body, /The response itself has no byte limit; its structural bounds are the limit/);
    assert.match(body, /Binding only on an agent that signs under that profile/);
    assert.match(body, /does not sign, is bounded only by the structural limits and by whatever transport limit its client applies/i);
  });
});

describe('adopter-facing migration entry', () => {
  const content = read(MIGRATION);
  const body = section(content, '## Recommended: bound agent response size');

  it('warns that the limit tightens and the failure is a connection abort', () => {
    assert.match(body, /tightens a limit/i);
    assert.match(body, /mid-body connection abort/i);
  });

  it('tells buyers how to raise the limit and sellers to paginate', () => {
    assert.match(body, /raise it for a specific agent or a specific call, never globally/i);
    assert.match(body, /Sellers with large catalogs\.\*\* Paginate/);
  });

  it('tells every agent to check its discovery surfaces', () => {
    assert.match(body, /check your discovery surfaces first/i);
    assert.match(body, /cannot discover you at all/i);
    assert.match(body, /MAX_CAPABILITIES_BYTES/);
  });

  it('documents the loosening the way the brand.json cap change was documented', () => {
    const loosening = section(content, '### Client response-size default rises to 4 MiB');
    assert.match(loosening, /This loosens a limit, so interop is asymmetric/);
    // A seller spending the new headroom still breaks against 3.2-era clients.
    assert.match(loosening, /while counterparties remain on 3\.2-era clients/i);
    assert.match(loosening, /per-call default is not an aggregate budget/i);
    assert.ok(content.includes('(#client-response-size-default-rises-to-4-mib)'));
  });

  it('is reachable from the guide intro and the upgrade checklist', () => {
    assert.ok(content.includes('(#recommended-bound-agent-response-size)'));
    assert.match(content, /\|\s*12\s*\|[^|]*\|[^|]*response-size bound/i);
  });
});

describe('cross-links introduced by this section resolve', () => {
  const headingsOf = (relative) =>
    [...read(relative).matchAll(/^#{2,6} (.+)$/gm)].map(([, h]) => slugify(h));

  it('security.mdx defines the #response-size-bounds anchor', () => {
    assert.ok(headingsOf(SECURITY).includes('response-size-bounds'));
  });

  it('every page that cites the bound uses the canonical link target', () => {
    for (const relative of [MCP_EXTRACTION, A2A_EXTRACTION, RESPONSE_SIZE, MIGRATION]) {
      assert.ok(read(relative).includes(SECTION_ANCHOR), `${relative} must link to ${SECTION_ANCHOR}`);
    }
  });

  it('the bound links to anchors that exist on the pages it cites', () => {
    const body = section(read(SECURITY), '### Response Size Bounds');
    const targets = [...body.matchAll(/\]\((\/docs\/[a-zA-Z0-9/_-]+)#([a-z0-9_-]+)\)/g)];
    assert.ok(targets.length >= 3, 'expected cross-links to the transport and pagination pages');

    for (const [, page, anchor] of targets) {
      const file = path.join(DOCS, '..', `${page.replace(/^\/docs\//, 'docs/')}.mdx`);
      assert.ok(fs.existsSync(file), `${page} does not exist`);
      const headings = [...fs.readFileSync(file, 'utf8').matchAll(/^#{2,6} (.+)$/gm)]
        .map(([, h]) => slugify(h));
      assert.ok(headings.includes(anchor), `unresolved anchor ${page}#${anchor}`);
    }
  });

  it('the bound links only to same-page anchors that exist', () => {
    const body = section(read(SECURITY), '### Response Size Bounds');
    const headings = headingsOf(SECURITY);
    for (const [, anchor] of body.matchAll(/\]\(#([a-z0-9_-]+)\)/g)) {
      assert.ok(headings.includes(anchor), `unresolved same-page anchor #${anchor}`);
    }
  });

  it('the pages that cite the bound link back to anchors that exist here', () => {
    const headings = headingsOf(SECURITY);
    for (const relative of [MCP_EXTRACTION, A2A_EXTRACTION, RESPONSE_SIZE, MIGRATION]) {
      for (const [, anchor] of read(relative).matchAll(
        /\]\(\/docs\/building\/by-layer\/L1\/security#([a-z0-9_-]+)\)/g,
      )) {
        assert.ok(headings.includes(anchor), `${relative}: unresolved security#${anchor}`);
      }
    }
  });
});
