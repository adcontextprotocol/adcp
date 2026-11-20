#!/usr/bin/env node
// Static docs pages for extensions, the way a WG docs site publishes WG-hosted extension
// specs: one page per extension plus an index, in docs-site/.
//
//   node scripts/render-extension-docs.mjs
//
// Each page is rendered from what the registry serves for the extension's uri@digest: the
// bundle (manifest), and the spec, storyboards, and reference code it pins, all re-verified by
// sha256 first. Each row of the extension-point table names the core layer that declares the extension point or union (the final layout: the kernel, or a buying layer such as `buying (pricing layer)`). Coverage comes
// from running the conformance suites (scripts/run-conformance.mjs). Pages are
// self-contained: inline CSS, no scripts, light theme.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Digest } from '../lib/digest.mjs';
import { parseSpec, sha256Of } from '../lib/extension-spec.mjs';
import { annotatedHooks } from './build-core.mjs';
import { ownerLabel } from '../lib/layout.mjs';
import { registryDocsDir, registryPath } from './build-extensions.mjs';
import { runConformance } from './run-conformance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs-site');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Inline markdown: code spans, bold, italics, links. Input is raw text; output is HTML. */
function inline(text) {
  const parts = text.split(/(`[^`]+`)/g);
  return parts
    .map((p) => {
      if (p.startsWith('`') && p.endsWith('`') && p.length > 1) return `<code>${esc(p.slice(1, -1))}</code>`;
      return esc(p)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
    })
    .join('');
}

/**
 * The markdown subset spec.md uses: headings, paragraphs, bullet and numbered lists, tables,
 * and fenced code. A rule heading (#### XX-Rn: title) gets the rule id as its anchor and a
 * badge with its level, enforcement, and coverage.
 */
/** GitHub's anchor for a markdown heading: lower case, punctuation dropped, spaces to hyphens. */
const headingSlug = (t) => t.toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim().replace(/ /g, '-');

function renderMarkdown(text, rulesById, specHref) {
  const lines = text.split('\n');
  const html = [];
  let i = 0;
  const isBlockStart = (l) => /^(#{1,4} |```|- |\d+\. |\|)/.test(l) || l.trim() === '';
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const body = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i]);
      i++;
      html.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4}) (.*)$/);
    if (h) {
      const level = h[1].length;
      const rule = h[2].match(/^([A-Z]+-R\d+): (.*)$/);
      if (level === 1) {
        i++;
        continue; // the page header carries the title
      }
      if (rule && rulesById[rule[1]]) {
        const r = rulesById[rule[1]];
        html.push(
          `<h4 class="rule-head" id="${r.id}"><a class="rule-id" href="#${r.id}">${r.id}</a> ${inline(rule[2])}` +
            (specHref ? ` <a class="src" href="${specHref}#${headingSlug(h[2])}">spec.md, line ${i + 1}</a>` : '') +
            ` <span class="badge level-${(r.level ?? 'none').toLowerCase()}">${r.level ?? '?'}</span>` +
            `${r.conformanceOnly ? ' <span class="badge co">conformance only</span>' : ''}` +
            ` <span class="badge st-${r.status}">${r.status === 'covered' ? `covered by ${r.storyboards.length} storyboard${r.storyboards.length === 1 ? '' : 's'}` : r.status}</span></h4>`
        );
      } else html.push(`<h${level} id="${slug(h[2])}">${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (line.startsWith('|')) {
      const rows = [];
      for (; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i].slice(1, -1).split('|').map((c) => c.trim()));
      const [head, , ...body] = rows;
      html.push(
        `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
          body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table></div>'
      );
      continue;
    }
    const list = line.match(/^(- |\d+\. )/);
    if (list) {
      const ordered = list[1] !== '- ';
      const items = [];
      while (i < lines.length && /^(- |\d+\. )/.test(lines[i])) {
        let item = lines[i].replace(/^(- |\d+\. )/, '');
        for (i++; i < lines.length && /^ {2,}\S/.test(lines[i]); i++) item += ' ' + lines[i].trim();
        items.push(item);
      }
      html.push(`<${ordered ? 'ol' : 'ul'}>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    const para = [];
    for (; i < lines.length && !isBlockStart(lines[i]); i++) para.push(lines[i]);
    if (!para.length) para.push(lines[i++]);
    const p = para.join(' ');
    const enforced = p.match(/^Enforced by: (.*)$/);
    html.push(enforced ? `<p class="enforced"><span>Enforced by</span> ${inline(enforced[1])}</p>` : `<p>${inline(p)}</p>`);
  }
  return html.join('\n');
}

const CSS = `
:root{color-scheme:light;--bg:#fbfaf7;--panel:#ffffff;--ink:#1d1f24;--muted:#5d6370;--line:#e3e0d8;--accent:#1f5fbf;--code:#f2efe8;
--ok:#1d7a46;--ok-bg:#e3f4ea;--warn:#9a5b00;--warn-bg:#fdf0d9;--bad:#b42318;--bad-bg:#fde7e4;--co:#6941c6;--co-bg:#efe9fb}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:960px;margin:0 auto;padding:32px 16px 64px;min-width:0}
a{color:var(--accent)}code{font:0.88em/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
pre{background:var(--code);padding:12px;border-radius:6px;overflow-x:auto}pre code{padding:0;background:none}
h1{font-size:1.9rem;line-height:1.2;margin:0 0 6px}h2{margin-top:2.2em;padding-top:.6em;border-top:1px solid var(--line);font-size:1.35rem}
h3{margin-top:1.8em;font-size:1.1rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.crumb{font-size:.9rem;color:var(--muted);margin-bottom:18px}.lede{color:var(--muted);margin:0 0 20px}
.meta{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 16px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:0 0 24px}
.meta dt{color:var(--muted);font-size:.9rem}.meta dd{margin:0;min-width:0;overflow-wrap:anywhere}
.table-wrap{overflow-x:auto;margin:12px 0;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
table{border-collapse:collapse;width:100%;font-size:.93rem}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:none}td:first-child code,td:nth-child(2) code{white-space:nowrap;overflow-wrap:normal}td:first-child a{white-space:nowrap}th{color:var(--muted);font-weight:600;font-size:.85rem}
.badge{display:inline-block;font-size:.72rem;font-weight:600;line-height:1;padding:4px 7px;border-radius:999px;vertical-align:middle;white-space:nowrap;background:var(--code);color:var(--muted)}
.level-must{background:var(--bad-bg);color:var(--bad)}.level-should{background:var(--warn-bg);color:var(--warn)}
.st-covered{background:var(--ok-bg);color:var(--ok)}.st-failing,.st-uncovered{background:var(--bad-bg);color:var(--bad)}.co{background:var(--co-bg);color:var(--co)}
.rule-head{margin:1.6em 0 .4em;font-size:1.02rem;line-height:1.5}.rule-head .src{font-size:.8rem;font-weight:400;margin-left:6px}.rule-id{font-family:ui-monospace,Menlo,monospace;text-decoration:none;margin-right:4px}
.enforced{font-size:.9rem;color:var(--muted);border-left:3px solid var(--line);padding-left:10px}.enforced span{font-weight:600}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}.card h2{border:none;margin:0 0 4px;padding:0;font-size:1.15rem}
.card p{margin:6px 0;color:var(--muted);font-size:.92rem}.small{font-size:.85rem;color:var(--muted)}
footer{margin-top:48px;font-size:.85rem;color:var(--muted)}
@media (max-width:600px){.meta{grid-template-columns:minmax(0,1fr)}.meta dt{margin-top:6px}h1{font-size:1.5rem}}
`;

const page = (title, body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${body}
<footer><code>scripts/render-extension-docs.mjs</code> generates these pages from the registry copy of each uri@digest, and re-verifies every document on them against the sha256 that the extension digest pins.</footer>
</main>
</body>
</html>
`;

/** The core layer that declares a hook (its owner), from core's annotations. */
const ownerOf = (hooks, e) => {
  const h = hooks.find((x) => x.name === e.point);
  return h ? ownerLabel(h.layer) : 'unknown';
};

/** The core hook policy for a manifest entry, from core's annotations. */
function policyOf(hooks, e) {
  const h = hooks.find((x) => x.name === e.point);
  if (!h) return 'unknown extension point';
  if (h.kind === 'union' && (h.value.must_understand ?? 'always') === 'never') return `branch: an offer in the declaration; ignored when not understood`;
  if (h.kind === 'union') return `branch: always must-understand; unknown in a list: ${h.value.unknown_in_list ?? 'reject'}`;
  return `extension point policy: ${h.value.must_understand}${h.value.order ? `; order: ${h.value.order}` : ''}`;
}

/** Bundle and spec as the registry serves them for uri@digest, verified. */
function fromRegistry(uri, digest) {
  const bytes = readFileSync(registryPath(uri, digest));
  if (sha256Digest(bytes) !== digest) throw new Error(`${uri}: registry bundle does not hash to ${digest}`);
  const bundle = JSON.parse(bytes);
  const manifest = bundle['x-adcp-extension'];
  const docsDir = registryDocsDir(uri, digest);
  const spec = readFileSync(path.join(docsDir, manifest.docs.spec.path));
  if (sha256Of(spec) !== manifest.docs.spec.sha256) throw new Error(`${uri}@${digest}: spec.md does not match docs.spec.sha256`);
  for (const c of [...manifest.docs.conformance, manifest.docs.reference_code]) {
    if (sha256Of(readFileSync(path.join(docsDir, c.path))) !== c.sha256) throw new Error(`${uri}@${digest}: ${c.path} does not match its sha256`);
  }
  return { bundle, manifest, specText: spec.toString('utf8') };
}

/** The package directory that ships this extension (packages/<dir>), for links to its spec.md source. */
function packageDirOf(uri) {
  const pk = path.join(ROOT, 'packages');
  return readdirSync(pk).find((d) => existsSync(path.join(pk, d, 'extension.json')) && JSON.parse(readFileSync(path.join(pk, d, 'extension.json'), 'utf8')).id === uri);
}

function extensionPage(ext, hooks) {
  const { manifest, specText } = fromRegistry(ext.uri, ext.digest);
  const pkgDir = packageDirOf(ext.uri);
  const spec = parseSpec(specText);
  const rulesById = Object.fromEntries(ext.rules.map((r) => [r.id, r]));
  const must = ext.rules.filter((r) => r.level === 'MUST');
  const covered = (rs) => rs.filter((r) => r.status === 'covered').length;
  const hookRows = manifest.extends
    .map(
      (e) =>
        `<tr><td><code>${esc(e.point)}${e.branch ? `#${esc(e.branch)}` : ''}</code></td><td>${esc(ownerOf(hooks, e))}</td><td><code>${esc(e.definition)}</code>${e.response ? ` → <code>${esc(e.response)}</code>` : ''}</td>` +
        `<td>${esc(e.must_understand ?? 'not applicable')}</td><td>${esc(policyOf(hooks, e))}</td><td>${inline(e.semantics ?? '')}</td></tr>`
    )
    .join('');
  const ruleRows = ext.rules
    .map(
      (r) =>
        `<tr><td><a href="#${r.id}"><code>${r.id}</code></a></td><td>${inline(r.title)}</td><td><span class="badge level-${(r.level ?? 'none').toLowerCase()}">${r.level}</span></td>` +
        `<td>${r.enforcement.map((x) => inline(x)).join('<br>')}</td><td><span class="badge st-${r.status}">${r.status}</span></td>` +
        `<td>${r.storyboards.map((s) => `<code>${esc(s.split('/').pop())}</code>`).join(' ')}</td></tr>`
    )
    .join('');
  const sbRows = ext.storyboards
    .map((s) => {
      const pin = manifest.docs.conformance.find((c) => c.path === s.file);
      const passed = s.steps.filter((x) => x.status === 'passed').length;
      return (
        `<tr><td><code>${esc(s.id)}</code><br><span class="small">${esc(s.title)}</span></td><td><code>${esc(s.file)}</code><br><span class="small"><code>${esc(pin.sha256.slice(0, 19))}…</code></span></td>` +
        `<td><span class="badge ${s.ok ? 'st-covered' : 'st-failing'}">${passed}/${s.steps.length} steps</span></td><td>${s.grease.join(', ') || '–'}</td>` +
        `<td>${s.covers.map((c) => `<a href="#${c}"><code>${c}</code></a>`).join(' ')}</td></tr>`
      );
    })
    .join('');
  const changelog = (manifest.changelog ?? []).map((c) => `<li><strong>${esc(c.version)}</strong>: ${inline(c.change)}</li>`).join('');
  const body = `
<div class="crumb"><a href="index.html">Extensions</a> / ${esc(manifest.name)}</div>
<h1>${esc(spec.title)}</h1>
<p class="lede">${inline(manifest.title)}</p>
<dl class="meta">
  <dt>URI</dt><dd><code>${esc(ext.uri)}</code></dd>
  <dt>Version</dt><dd>${esc(manifest.version)} <span class="badge">${esc(manifest.status)}</span></dd>
  <dt>Digest</dt><dd><code>${esc(ext.digest)}</code></dd>
  <dt>Owner</dt><dd>${esc(manifest.owner)}</dd>
  <dt>Requires</dt><dd>core <code>${esc(manifest.requires.core)}</code>; extension points and unions ${Object.entries(manifest.requires.points).map(([k, v]) => `<code>${esc(k)}</code> v${v}`).join(', ')}${Object.keys(manifest.requires.core_types ?? {}).length ? `; core types ${Object.entries(manifest.requires.core_types).map(([k, v]) => `<code>${esc(k)}</code> v${v}`).join(', ')}` : ''}</dd>
  <dt>Spec</dt><dd><code>${esc(manifest.docs.spec.path)}</code> <code>${esc(manifest.docs.spec.sha256)}</code></dd>
  <dt>Reference code</dt><dd><code>${esc(manifest.docs.reference_code.path)}</code> <code>${esc(manifest.docs.reference_code.sha256)}</code></dd>
  <dt>Coverage</dt><dd><span class="badge ${ext.ok ? 'st-covered' : 'st-failing'}">${covered(ext.rules)}/${ext.rules.length} rules</span> <span class="badge">MUST ${covered(must)}/${must.length}</span> <span class="badge">GREASE reject ${ext.grease.reject ? 'yes' : 'no'}, ignore ${ext.grease.ignore ? 'yes' : 'no'}</span></dd>
</dl>
<p class="small">The digest covers the schema, the manifest, this spec, the storyboards, and the reference code. A change to any of them, the prose included, gives a different digest, which the registry accepts only under a higher version. A buyer SDK runs the reference code only if it hashes to the pinned sha256.</p>

<h2 id="hooks">Extension points, open unions, and must-understand policy</h2>
<p>The extension attaches at the following extension points and open unions. The <strong>Owner</strong> column names the core layer whose schema declares each one. The <strong>Core policy</strong> column says what that annotation tells a buyer to do with unknown data there.</p>
<div class="table-wrap"><table><thead><tr><th>Extension point or open union</th><th>Owner</th><th>Definition</th><th>Must understand</th><th>Core policy</th><th>Semantics</th></tr></thead><tbody>${hookRows}</tbody></table></div>

<h2 id="rule-index">Rules and storyboard coverage</h2>
<p>Each rule has an ID. A rule is covered when a storyboard that cites it passes in full.</p>
<div class="table-wrap"><table><thead><tr><th>ID</th><th>Rule</th><th>Level</th><th>Enforced by</th><th>Status</th><th>Storyboards</th></tr></thead><tbody>${ruleRows}</tbody></table></div>

<h2 id="spec">Specification</h2>
<p class="small">The following text is the pinned spec, verbatim. Each rule heading links to its line in <code>spec.md</code>.</p>
${renderMarkdown(specText, rulesById, pkgDir ? `../packages/${pkgDir}/spec.md` : null)}

<h2 id="conformance">Conformance storyboards</h2>
<p>The extension digest pins each storyboard file by sha256.</p>
<div class="table-wrap"><table><thead><tr><th>Storyboard</th><th>File</th><th>Result</th><th>GREASE</th><th>Covers</th></tr></thead><tbody>${sbRows}</tbody></table></div>

<h2 id="changelog">Changelog</h2>
<ul>${changelog}</ul>
`;
  return page(`${spec.title} ${manifest.version}`, body);
}

function indexPage(result, hooks) {
  const cards = result.extensions
    .map((e) => {
      const must = e.rules.filter((r) => r.level === 'MUST');
      const covered = (rs) => rs.filter((r) => r.status === 'covered').length;
      const { manifest } = fromRegistry(e.uri, e.digest);
      return `<div class="card">
  <h2><a href="${esc(e.name)}.html">${esc(manifest.name)}</a> <span class="small">${esc(e.version)}</span></h2>
  <p>${inline(manifest.title)}</p>
  <p><code>${esc(e.uri)}</code></p>
  <p><code>${esc(e.digest.slice(0, 23))}…</code></p>
  <p><span class="badge">${esc(manifest.status)}</span> <span class="badge ${e.ok ? 'st-covered' : 'st-failing'}">${covered(e.rules)}/${e.rules.length} rules covered</span> <span class="badge">MUST ${covered(must)}/${must.length}</span> <span class="badge">${e.storyboards.length} storyboards</span></p>
  <p class="small">${manifest.extends.map((x) => `<code>${esc(x.point)}${x.branch ? `#${esc(x.branch)}` : ''}</code> (${esc(ownerOf(hooks, x))})`).join(' ')}</p>
</div>`;
    })
    .join('\n');
  const body = `
<h1>AdCP extensions</h1>
<p class="lede">Extension specs, each pinned by its digest. Each extension carries its fields (JSON Schema), its rules (a normative spec with rule IDs), declarative constraints where possible, conformance storyboards, and non-normative reference code. The digest covers all five.</p>
<div class="cards">
${cards}
</div>
`;
  return page('AdCP extensions', body);
}

export async function renderDocs() {
  const result = await runConformance();
  const hooks = annotatedHooks();
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  for (const ext of result.extensions) writeFileSync(path.join(OUT, `${ext.name}.html`), extensionPage(ext, hooks));
  writeFileSync(path.join(OUT, 'index.html'), indexPage(result, hooks));
  return { result, files: ['index.html', ...result.extensions.map((e) => `${e.name}.html`)] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { result, files } = await renderDocs();
  for (const f of files) console.log(`wrote docs-site/${f}`);
  if (!result.ok) {
    console.error('conformance failed; the pages show the failing rules');
    process.exitCode = 1;
  }
}
