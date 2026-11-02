const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'docs/creative/task-reference/preview_creative.mdx'), 'utf8');
const advanced = fs.readFileSync(path.join(ROOT, 'docs/creative/task-reference/preview_creative-advanced.mdx'), 'utf8');

function blocks(document, language) {
  return [...document.matchAll(/```(\w+)[^\n]*\n([\s\S]*?)```/g)]
    .filter(match => match[1] === language).map(match => match[2]);
}

const srcdocCode = blocks(main, 'javascript').find(code => code.includes('function previewSrcdoc('));
const mountCode = blocks(main, 'javascript').find(code => code.includes("document.createElement('iframe')"));
const cacheCode = blocks(advanced, 'javascript').find(code => code.includes('async function getPreviewsWithCache('));
assert.ok(srcdocCode && mountCode && cacheCode, 'security and cache examples must remain executable');

function cacheFunctions() {
  return vm.runInNewContext(`${cacheCode}\n({ getPreviewsWithCache, previewCacheKey, effectivePreviewItem });`, {
    structuredClone, Date, Map
  });
}

function fixtures() {
  const calls = [];
  const context = {
    endpoint: 'https://creative.acme.example/mcp', principalScope: 'tenant-a:reviewer',
    sourceSnapshot: 'assets-and-brand-v1', renderingSnapshot: 'renderer-config-v1',
    authoritySnapshot: { kind: 'undelegated', catalogRevision: 'catalog-1' }
  };
  const item = {
    creative_manifest: { format_kind: 'image', assets: {
      image_main: { asset_type: 'image', url: 'https://cdn.acme.example/banner.png', width: 300, height: 250 }
    } },
    target_capability_id: 'image_preview', quality: 'production', output_format: 'html',
    inputs: [{ name: 'Desktop', macros: { DEVICE_TYPE: 'desktop' }, context_description: 'Sports article' }]
  };
  const client = { async preview_creative(request) {
    calls.push(structuredClone(request));
    return { response_type: 'batch', results: request.requests.map((request, index) => ({
      success: true, creative_id: `creative-${index}`, quality_used: request.quality,
      response: { previews: [{ preview_id: 'sample-1', input: request.inputs?.[0] ?? { name: 'Default' },
        renders: [{ render_id: 'render-1', role: 'primary', output_format: 'html', preview_html: '<p>Sample</p>',
          renderer: { renderer_id: 'image', version: '1.0.0', export: 'image',
            rendering_origin: 'agent_approximation', tracking_suppressed: true } }]
      }] }
    })) };
  } };
  return { calls, context, item, client };
}

test('preview examples isolate provider HTML with an empty sandbox and first-position caller CSP', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="review"><button>Review</button></div>', { url: 'https://buyer.acme.example/' });
  try {
    const container = dom.window.document.getElementById('review');
    const render = { preview_html: '<meta http-equiv="Content-Security-Policy" content="script-src *">' +
      '<img src="https://untrusted.acme.example/pixel" onerror="parent.compromised=true">' +
      '<script>parent.compromised=true</script>' };
    const frame = vm.runInNewContext(`${srcdocCode}\n${mountCode}\nframe;`, {
      document: dom.window.document, container, render
    });
    assert.equal(frame.tagName, 'IFRAME');
    assert.equal(frame.getAttribute('sandbox'), '');
    assert.equal(frame.referrerPolicy, 'no-referrer');
    assert.equal(container.querySelector('script'), null, 'provider markup never enters the host DOM');
    assert.equal(container.querySelector('img'), null);
    const isolated = new JSDOM(frame.srcdoc);
    try {
      const policy = isolated.window.document.head.firstElementChild;
      assert.equal(policy.getAttribute('http-equiv'), 'Content-Security-Policy');
      const csp = policy.getAttribute('content');
      for (const directive of ["default-src 'none'", "script-src 'none'", "connect-src 'none'",
        "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) {
        assert.ok(csp.includes(directive), directive);
      }
      assert.ok(frame.srcdoc.indexOf(csp) < frame.srcdoc.indexOf(render.preview_html));
    } finally { isolated.window.close(); }
    // jsdom does not enforce iframe sandbox/CSP; these assertions inspect the actual emitted boundary.
  } finally { dom.window.close(); }
});

test('all JSX examples compile and the reusable frame never grants provider sandbox permissions', () => {
  const jsx = blocks(advanced, 'tsx').join('\n');
  const compiled = ts.transpileModule(jsx, {
    fileName: 'preview-example.tsx', reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 }
  });
  assert.equal(compiled.diagnostics?.length ?? 0, 0);
  const { PreviewFrame, CampaignReview } = vm.runInNewContext(
    `${srcdocCode}\n${compiled.outputText}\n({ PreviewFrame, CampaignReview });`, {
      React: { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) }
    }
  );
  const frame = PreviewFrame({ render: { output_format: 'html', preview_html: '<p>Sample</p>', role: 'primary' } });
  assert.equal(frame.type, 'iframe');
  assert.equal(frame.props.sandbox, '');
  assert.equal(frame.props.referrerPolicy, 'no-referrer');
  assert.match(frame.props.srcDoc, /Content-Security-Policy/);
  assert.equal(PreviewFrame({ render: { output_format: 'url', preview_url: 'https://untrusted.acme.example/' } }).type, 'p');
  const failed = CampaignReview({ entries: [{ request: {}, result: { success: false, errors: [{ message: '<script>unsafe</script>' }] } }], onReview() {} });
  assert.equal(failed.children[0][0].type, 'p', 'failed items are text, never success responses or injected markup');
  for (const document of [main, advanced]) {
    assert.doesNotMatch(document, /dangerouslySetInnerHTML|\.innerHTML\s*=|\.insertAdjacentHTML\s*\(/);
    assert.doesNotMatch(document, /no iframe overhead|Just iframe/);
  }
});

test('production review rejects expired results and rechecks lifetime when a reviewer clicks', async () => {
  const compiled = ts.transpileModule(blocks(advanced, 'tsx').join('\n'), {
    fileName: 'preview-review.tsx', compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 }
  });
  let now = Date.parse('2030-01-01T00:00:00Z');
  const CampaignReview = vm.runInNewContext(`${cacheCode}\n${compiled.outputText}\nCampaignReview;`, {
    Date: { now: () => now, parse: Date.parse },
    React: { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) }
  });
  const { client, item } = fixtures();
  const response = await client.preview_creative({ requests: [item] });
  const result = response.results[0];
  let reviews = 0;
  function buttonFor(expiresAt) {
    const supplied = structuredClone(result);
    if (expiresAt !== undefined) supplied.response.expires_at = expiresAt;
    const tree = CampaignReview({ entries: [{ request: item, result: supplied }], onReview() { reviews++; } });
    return tree.children[0][0].children.find(child => child?.type === 'button');
  }
  const expired = buttonFor('2000-01-01T00:00:00Z');
  assert.equal(expired.props.disabled, true);
  expired.props.onClick();
  assert.equal(reviews, 0, 'expired production metadata cannot authorize a review action');
  const fresh = buttonFor('2030-01-01T00:01:00Z');
  assert.equal(fresh.props.disabled, false);
  fresh.props.onClick();
  assert.equal(reviews, 1);
  now = Date.parse('2030-01-01T00:02:00Z');
  fresh.props.onClick();
  assert.equal(reviews, 1, 'an artifact that expired after rendering is blocked at click time');
  const withoutExpiry = buttonFor(undefined);
  assert.equal(withoutExpiry.props.disabled, false);
  withoutExpiry.props.onClick();
  assert.equal(reviews, 2, 'omission retains existing no-protocol-expiration semantics');
});

test('review cache preserves complete quality, renderer, request and authority evidence across isolated hits', async () => {
  const { getPreviewsWithCache } = cacheFunctions();
  const { client, calls, context, item } = fixtures();
  const cache = new Map();
  const [first] = await getPreviewsWithCache(client, cache, context, [item]);
  const [hit] = await getPreviewsWithCache(client, cache, context, [item]);
  assert.equal(calls.length, 1);
  assert.deepEqual(hit, first);
  assert.equal(hit.result.quality_used, 'production');
  assert.equal(hit.result.response.previews[0].renders[0].renderer.rendering_origin, 'agent_approximation');
  assert.deepEqual(hit.provenance, context);
  first.result.quality_used = 'draft';
  hit.provenance.authoritySnapshot.kind = 'forged';
  const [unchanged] = await getPreviewsWithCache(client, cache, context, [item]);
  assert.equal(unchanged.result.quality_used, 'production');
  assert.equal(unchanged.provenance.authoritySnapshot.kind, 'undelegated');
});

test('cache keys separate every effective rendering input and caller trust scope', async () => {
  const { getPreviewsWithCache } = cacheFunctions();
  const { client, calls, context, item } = fixtures();
  const cache = new Map();
  await getPreviewsWithCache(client, cache, context, [item]);
  const cases = [
    [{ endpoint: 'https://other.acme.example/mcp' }, {}],
    [{ principalScope: 'tenant-b:reviewer' }, {}],
    [{ sourceSnapshot: 'assets-v2' }, {}],
    [{ renderingSnapshot: 'renderer-config-v2' }, {}],
    [{ authoritySnapshot: { kind: 'publisher_delegated', catalogRevision: 'catalog-2' } }, {}],
    [{}, { target_capability_id: 'other_route' }],
    [{}, { quality: 'draft' }],
    [{}, { output_format: 'url' }],
    [{}, { template_id: 'mobile' }],
    [{}, { item_limit: 3 }],
    [{}, { inputs: [{ name: 'Mobile', macros: { DEVICE_TYPE: 'mobile' } }] }],
    [{}, { inputs: [{ name: 'Desktop', context_description: 'Travel article' }] }]
  ];
  for (const [contextChange, itemChange] of cases) {
    await getPreviewsWithCache(client, cache, { ...context, ...contextChange }, [{ ...item, ...itemChange }]);
  }
  assert.equal(calls.length, cases.length + 1);
});

test('batch defaults and equivalent item overrides share the same effective identity', async () => {
  const { getPreviewsWithCache } = cacheFunctions();
  const { client, calls, context, item } = fixtures();
  const cache = new Map();
  const { target_capability_id, quality, output_format, ...bareItem } = item;
  await getPreviewsWithCache(client, cache, context, [bareItem], { target_capability_id, quality, output_format });
  await getPreviewsWithCache(client, cache, context, [item]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].requests[0].quality, 'production');
  assert.equal(calls[0].requests[0].target_capability_id, 'image_preview');
});

test('unknown dependencies bypass cache and mutable context is snapped before transport work', async () => {
  const { getPreviewsWithCache } = cacheFunctions();
  const { client, calls, context, item } = fixtures();
  const cache = new Map();
  for (const field of ['sourceSnapshot', 'renderingSnapshot', 'authoritySnapshot']) {
    const unknown = { ...context, [field]: undefined };
    await getPreviewsWithCache(client, cache, unknown, [item]);
    await getPreviewsWithCache(client, cache, unknown, [item]);
  }
  assert.equal(calls.length, 6);
  assert.equal(cache.size, 0);
  const modifyingClient = { async preview_creative(request) {
    context.renderingSnapshot = 'changed-while-pending';
    return client.preview_creative(request);
  } };
  const [entry] = await getPreviewsWithCache(modifyingClient, cache, context, [item]);
  assert.equal(entry.provenance.renderingSnapshot, 'renderer-config-v1');
});

test('partial failures retry only failed items and quality downgrades remain explicit', async () => {
  const { getPreviewsWithCache } = cacheFunctions();
  const { client, calls, context, item } = fixtures();
  const cache = new Map();
  const partialClient = { async preview_creative(request) {
    const response = await client.preview_creative(request);
    response.results[0].quality_used = 'draft';
    if (request.requests.length > 1) response.results[1] = {
      success: false, creative_id: 'failed', errors: [{ code: 'FORMAT_NOT_SUPPORTED', message: 'Unsupported route' }]
    };
    return response;
  } };
  const second = { ...item, template_id: 'second' };
  const result = await getPreviewsWithCache(partialClient, cache, context, [item, second]);
  assert.equal(result[0].request.quality, 'production');
  assert.equal(result[0].result.quality_used, 'draft');
  assert.equal(result[1].result.success, false);
  assert.equal(cache.size, 1);
  await getPreviewsWithCache(partialClient, cache, context, [item, second]);
  assert.equal(calls[1].requests.length, 1);
  assert.equal(calls[1].requests[0].template_id, 'second');
});

test('expired artifacts, malformed batches and missing quality evidence are not accepted as fresh reviews', async () => {
  const { getPreviewsWithCache } = cacheFunctions();
  const { client, calls, context, item } = fixtures();
  const cache = new Map();
  const expiringClient = { async preview_creative(request) {
    const response = await client.preview_creative(request);
    response.results[0].response.expires_at = '2000-01-01T00:00:00Z';
    return response;
  } };
  await assert.rejects(getPreviewsWithCache(expiringClient, cache, context, [item]), /fetched preview has expired/);
  assert.equal(cache.size, 0, 'the first expired fetch is never returned or cached as a review entry');
  await assert.rejects(getPreviewsWithCache(expiringClient, cache, context, [item]), /fetched preview has expired/);
  assert.equal(calls.length, 2);
  const freshClient = { async preview_creative(request) {
    const response = await client.preview_creative(request);
    response.results[0].response.expires_at = '2999-01-01T00:00:00Z';
    return response;
  } };
  const [fresh] = await getPreviewsWithCache(freshClient, cache, context, [item]);
  assert.equal(fresh.result.response.expires_at, '2999-01-01T00:00:00Z');
  await getPreviewsWithCache(freshClient, cache, context, [item]);
  assert.equal(calls.length, 3, 'a non-expired result is returned and reused');
  await assert.rejects(getPreviewsWithCache({ async preview_creative() {
    return { response_type: 'batch', results: [] };
  } }, new Map(), context, [item]), /one synchronous batch result/);
  await assert.rejects(getPreviewsWithCache({ async preview_creative(request) {
    const response = await client.preview_creative(request);
    delete response.results[0].quality_used;
    return response;
  } }, new Map(), context, [item]), /Missing quality_used/);
  await assert.rejects(getPreviewsWithCache({ async preview_creative() {
    return { errors: [{ message: 'Unavailable' }] };
  } }, new Map(), context, [item]), /Unavailable/);
});

test('historical preview guidance distinguishes optional retained output, summaries and unavailable evidence', () => {
  assert.match(main, /optional `manifest`/);
  assert.match(main, /MUST NOT silently re-generate missing output/);
  assert.match(main, /summary does not establish the wording/);
  assert.match(main, /structured error response/);
  assert.match(main, /issues\/6506/);
  assert.match(main, /issues\/6507/);
  assert.doesNotMatch(main, /Since each variant.*includes its full `manifest`/);
});
