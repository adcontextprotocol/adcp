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

  test('idempotent: rewriting twice does not double-prepend', () => {
    const once = rewriteContent('[x](../../static/y)', 1);
    const twice = rewriteContent(once, 3);
    // After one rewrite, the path has 4 ../, sourceDepth=3 means count(4) > 3
    // → would rewrite again. So the rewrite is NOT mathematically idempotent
    // by content alone; it is idempotent at the (file, sourceDepth) tuple
    // level — calling with the same depth twice on the same content yields
    // the same output.
    const stable = rewriteContent(once, 1);
    assert.equal(stable, once, 'second pass with same depth should be stable');
    // Sanity: the (incorrect) double-rewrite path would over-apply.
    assert.notEqual(twice, once);
  });
})();
