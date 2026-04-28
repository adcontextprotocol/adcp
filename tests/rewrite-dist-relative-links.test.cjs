/**
 * Tests for the depth-aware relative-link rewriter
 * (scripts/rewrite-dist-relative-links.mjs).
 *
 * The rewriter compensates for the `dist/docs/<version>/` mirror layer:
 * a source link that escapes `docs/` needs +2 `../` segments to land on
 * the same target from the dist mirror. Links that stay within `docs/`
 * are left alone (their target also gets mirrored, so the relative path
 * remains correct).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

(async () => {
  const { rewriteContent } = await import('../scripts/rewrite-dist-relative-links.mjs');

  test('depth 1 source: escaping link gains +2 ../', () => {
    const input = '[runner](../../static/compliance/runner.yaml)';
    const out = rewriteContent(input, 1);
    assert.equal(out, '[runner](../../../../static/compliance/runner.yaml)');
  });

  test('depth 1 source: in-docs link unchanged', () => {
    const input = '[sibling](../media-buy/index.mdx)';
    const out = rewriteContent(input, 1);
    assert.equal(out, '[sibling](../media-buy/index.mdx)');
  });

  test('depth 0 source: escaping link gains +2 ../', () => {
    const input = '[ref](../static/compliance/x.yaml)';
    const out = rewriteContent(input, 0);
    assert.equal(out, '[ref](../../../static/compliance/x.yaml)');
  });

  test('depth 2 source: in-docs link unchanged, escaping link gains +2', () => {
    const input = [
      '[stay](../../sibling.md)',
      '[escape](../../../scripts/x.sh)',
    ].join('\n');
    const out = rewriteContent(input, 2);
    assert.equal(out, [
      '[stay](../../sibling.md)',
      '[escape](../../../../../scripts/x.sh)',
    ].join('\n'));
  });

  test('href= attribute is rewritten the same way', () => {
    const input = '<a href="../../signatures/index.json">sigs</a>';
    const out = rewriteContent(input, 1);
    assert.equal(out, '<a href="../../../../signatures/index.json">sigs</a>');
  });

  test('multiple links in one file each get the right treatment', () => {
    const input = [
      'See [yaml](../../static/test-kits/runner.yaml).',
      'See [adjacent](../media-buy/file.mdx).',
      'See [also-yaml](../../static/spec/another.yaml).',
    ].join('\n');
    const out = rewriteContent(input, 1);
    assert.equal(out, [
      'See [yaml](../../../../static/test-kits/runner.yaml).',
      'See [adjacent](../media-buy/file.mdx).',
      'See [also-yaml](../../../../static/spec/another.yaml).',
    ].join('\n'));
  });

  test('over-escaping link (count > sourceDepth+1) is left untouched as malformed source', () => {
    // From depth 1, count=3 escapes past repo root — malformed in source.
    // The script does NOT silently fix it; the user should fix the source.
    const input = '[escape](../../../static/x)';
    const out = rewriteContent(input, 1);
    assert.equal(out, input);
  });

  test('non-relative links are not touched', () => {
    const input = [
      '[abs](/docs/foo)',
      '[ext](https://example.com/x)',
      '[curr](./local.md)',
    ].join('\n');
    const out = rewriteContent(input, 5);
    assert.equal(out, input);
  });

  test('inline-code link rewriting (` ` ` lead-in)', () => {
    const input = 'See `../../static/compliance/x.yaml` for the source.';
    const out = rewriteContent(input, 1);
    assert.equal(out, 'See `../../../../static/compliance/x.yaml` for the source.');
  });

  test('idempotent at fixed source depth (the documented contract)', () => {
    // Post-rewrite count is sourceDepth+3, which never matches the
    // sourceDepth+1 minimal-escape predicate. So a second pass at the same
    // depth is a no-op. This is the only contract — the rewriter is
    // depth-aware and the dist file's depth is fixed by its path.
    const once = rewriteContent('[x](../../static/y)', 1);
    assert.equal(once, '[x](../../../../static/y)');
    const twice = rewriteContent(once, 1);
    assert.equal(twice, once, 'second pass at same depth is a no-op');
  });
})();

// ── sourceDepthInDocs() ──────────────────────────────────────────────

(async () => {
  const { sourceDepthInDocs } = await import('../scripts/rewrite-dist-relative-links.mjs');

  test('sourceDepthInDocs: file at root of dist/docs/<version>/ → 0', () => {
    assert.equal(sourceDepthInDocs('dist/docs/3.0.1/file.md'), 0);
  });

  test('sourceDepthInDocs: depth 1', () => {
    assert.equal(sourceDepthInDocs('dist/docs/3.0.1/contributing/file.md'), 1);
  });

  test('sourceDepthInDocs: depth 3', () => {
    assert.equal(sourceDepthInDocs('dist/docs/9.9.9/a/b/c/file.md'), 3);
  });

  test('sourceDepthInDocs: malformed path throws', () => {
    assert.throws(() => sourceDepthInDocs('not/a/dist/path.md'), /Not a dist\/docs/);
  });

  test('sourceDepthInDocs: prerelease versions handled (3.1.0-beta.2)', () => {
    assert.equal(sourceDepthInDocs('dist/docs/3.1.0-beta.2/x/y.md'), 1);
  });
})();
