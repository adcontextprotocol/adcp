#!/usr/bin/env node
/**
 * Report test coverage for documentation examples.
 *
 * This is intentionally non-gating by default. It gives maintainers a baseline
 * for JSON examples with schema validation and runnable snippets, so CI can
 * publish trends before enforcing thresholds.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DOCS_DIR = path.join(ROOT, 'docs');
const EXECUTABLE_LANGUAGES = new Set([
  'bash',
  'javascript',
  'js',
  'py',
  'python',
  'sh',
  'shell',
  'ts',
  'typescript'
]);

const args = process.argv.slice(2);

function readArg(name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) return fallback;
  return args[index + 1];
}

const docsDir = path.resolve(readArg('--docs-dir', DEFAULT_DOCS_DIR));
const topN = Number.parseInt(readArg('--top', '10'), 10);
const format = args.includes('--json')
  ? 'json'
  : args.includes('--markdown')
    ? 'markdown'
    : 'text';

function percent(part, whole) {
  if (!whole) return 0;
  return Number(((part / whole) * 100).toFixed(1));
}

function pct(part, whole) {
  return `${percent(part, whole).toFixed(1)}%`;
}

function walkFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else if (entry.isFile() && /\.(md|mdx)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : '';
}

function isTestablePage(content) {
  return /(?:^|\n)testable:\s*true\s*(?:\n|$)/i.test(parseFrontmatter(content));
}

function metadataHas(metadata, pattern) {
  return pattern.test(metadata || '');
}

function isPlaceholderJson(text) {
  return /\[\.\.\.\]|\{\.\.\.\}|\.\.\./.test(text);
}

function extractCodeBlocks(content) {
  const blocks = [];
  const codeBlockRegex = /```(\w+)([^\n]*)\n([\s\S]*?)```/g;
  let match;
  let index = 0;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    blocks.push({
      language: match[1].toLowerCase(),
      metadata: match[2] || '',
      code: match[3].trim(),
      line: content.substring(0, match.index).split('\n').length,
      index: index++
    });
  }

  return blocks;
}

function emptyFileStats(relativePath) {
  return {
    path: relativePath,
    json: {
      total: 0,
      parseable: 0,
      placeholder: 0,
      invalid: 0,
      schemaBacked: 0,
      unvalidated: 0
    },
    snippets: {
      executable: 0,
      eligible: 0,
      testable: 0,
      disabled: 0,
      untested: 0,
      integration: 0,
      requiresEnv: 0
    }
  };
}

function analyzeFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const relativePath = path.relative(ROOT, filePath);
  const pageTestable = isTestablePage(content);
  const stats = emptyFileStats(relativePath);

  for (const block of extractCodeBlocks(content)) {
    if (block.language === 'json') {
      stats.json.total++;

      if (isPlaceholderJson(block.code)) {
        stats.json.placeholder++;
      } else {
        try {
          const parsed = JSON.parse(block.code);
          stats.json.parseable++;
          if (parsed && typeof parsed === 'object' && typeof parsed.$schema === 'string') {
            stats.json.schemaBacked++;
          } else {
            stats.json.unvalidated++;
          }
        } catch {
          stats.json.invalid++;
        }
      }
    }

    if (EXECUTABLE_LANGUAGES.has(block.language)) {
      stats.snippets.executable++;

      const disabled = metadataHas(block.metadata, /\btest=false\b/);
      const testable = !disabled && (
        pageTestable ||
        metadataHas(block.metadata, /\btest=true\b/) ||
        metadataHas(block.metadata, /\btestable\b/)
      );

      if (disabled) {
        stats.snippets.disabled++;
      } else {
        stats.snippets.eligible++;
      }

      if (testable) {
        stats.snippets.testable++;
        if (metadataHas(block.metadata, /\bintegration(?:=true)?\b/) || metadataHas(block.metadata, /\blive\b/)) {
          stats.snippets.integration++;
        }
        if (metadataHas(block.metadata, /\b(?:requires-env|requires_env|env|requires)=/)) {
          stats.snippets.requiresEnv++;
        }
      }
    }
  }

  stats.snippets.untested = Math.max(0, stats.snippets.eligible - stats.snippets.testable);
  return stats;
}

function addTotals(target, fileStats) {
  for (const key of Object.keys(target.json)) {
    target.json[key] += fileStats.json[key];
  }
  for (const key of Object.keys(target.snippets)) {
    target.snippets[key] += fileStats.snippets[key];
  }
}

function sectionName(relativePath) {
  const withoutRoot = relativePath.replace(/^docs\//, '');
  const parts = withoutRoot.split('/');
  return parts.length > 1 ? parts[0] : '(root)';
}

function buildReport() {
  const files = walkFiles(docsDir);
  const fileStats = files.map(analyzeFile);
  const totals = emptyFileStats('TOTAL');
  const sections = new Map();

  for (const stat of fileStats) {
    addTotals(totals, stat);
    const section = sectionName(stat.path);
    if (!sections.has(section)) {
      sections.set(section, emptyFileStats(section));
    }
    addTotals(sections.get(section), stat);
  }

  const jsonDenominator = totals.json.parseable;
  const snippetDenominator = totals.snippets.eligible;

  return {
    docsDir: path.relative(ROOT, docsDir) || '.',
    generatedAt: new Date().toISOString(),
    files: {
      scanned: files.length,
      withJson: fileStats.filter((f) => f.json.total > 0).length,
      withExecutableSnippets: fileStats.filter((f) => f.snippets.executable > 0).length
    },
    json: {
      ...totals.json,
      schemaCoverage: percent(totals.json.schemaBacked, jsonDenominator)
    },
    snippets: {
      ...totals.snippets,
      testableCoverage: percent(totals.snippets.testable, snippetDenominator)
    },
    sections: [...sections.values()]
      .map((section) => ({
        path: section.path,
        json: {
          ...section.json,
          schemaCoverage: percent(section.json.schemaBacked, section.json.parseable)
        },
        snippets: {
          ...section.snippets,
          testableCoverage: percent(section.snippets.testable, section.snippets.eligible)
        }
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    topGaps: {
      json: fileStats
        .filter((f) => f.json.unvalidated > 0)
        .sort((a, b) => b.json.unvalidated - a.json.unvalidated || a.path.localeCompare(b.path))
        .slice(0, topN)
        .map((f) => ({
          path: f.path,
          unvalidated: f.json.unvalidated,
          schemaBacked: f.json.schemaBacked,
          total: f.json.total
        })),
      snippets: fileStats
        .filter((f) => f.snippets.untested > 0)
        .sort((a, b) => b.snippets.untested - a.snippets.untested || a.path.localeCompare(b.path))
        .slice(0, topN)
        .map((f) => ({
          path: f.path,
          untested: f.snippets.untested,
          testable: f.snippets.testable,
          executable: f.snippets.executable
        }))
    }
  };
}

function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(
    h.length,
    ...rows.map((row) => String(row[i]).length)
  ));
  const line = (cols) => cols.map((col, i) => String(col).padEnd(widths[i])).join('  ');
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

function renderText(report) {
  const rows = [
    ['Files scanned', report.files.scanned],
    ['Files with JSON', report.files.withJson],
    ['Files with executable snippets', report.files.withExecutableSnippets],
    ['JSON schema-backed', `${report.json.schemaBacked}/${report.json.parseable} (${report.json.schemaCoverage.toFixed(1)}%)`],
    ['JSON placeholders', report.json.placeholder],
    ['JSON invalid', report.json.invalid],
    ['Runnable snippets testable', `${report.snippets.testable}/${report.snippets.eligible} (${report.snippets.testableCoverage.toFixed(1)}%)`],
    ['Runnable snippets disabled', report.snippets.disabled]
  ];

  const sectionRows = report.sections.map((section) => [
    section.path,
    `${section.json.schemaBacked}/${section.json.parseable}`,
    pct(section.json.schemaBacked, section.json.parseable),
    `${section.snippets.testable}/${section.snippets.eligible}`,
    pct(section.snippets.testable, section.snippets.eligible)
  ]);

  const jsonGapRows = report.topGaps.json.map((gap) => [
    gap.path,
    gap.unvalidated,
    gap.schemaBacked,
    gap.total
  ]);

  const snippetGapRows = report.topGaps.snippets.map((gap) => [
    gap.path,
    gap.untested,
    gap.testable,
    gap.executable
  ]);

  return [
    'Documentation Example Coverage',
    `Docs directory: ${report.docsDir}`,
    '',
    table(['Metric', 'Value'], rows),
    '',
    'By Section',
    table(['Section', 'JSON schema', 'JSON %', 'Snippets', 'Snippet %'], sectionRows),
    '',
    `Top ${report.topGaps.json.length} JSON schema gaps`,
    jsonGapRows.length
      ? table(['File', 'Unvalidated', 'Schema-backed', 'JSON blocks'], jsonGapRows)
      : 'No unvalidated JSON blocks found.',
    '',
    `Top ${report.topGaps.snippets.length} runnable snippet gaps`,
    snippetGapRows.length
      ? table(['File', 'Untested', 'Testable', 'Executable'], snippetGapRows)
      : 'No untested runnable snippets found.'
  ].join('\n');
}

function renderMarkdown(report) {
  const lines = [
    '## Documentation Example Coverage',
    '',
    `Docs directory: \`${report.docsDir}\``,
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| Files scanned | ${report.files.scanned} |`,
    `| Files with JSON | ${report.files.withJson} |`,
    `| Files with executable snippets | ${report.files.withExecutableSnippets} |`,
    `| JSON schema-backed | ${report.json.schemaBacked}/${report.json.parseable} (${report.json.schemaCoverage.toFixed(1)}%) |`,
    `| JSON placeholders | ${report.json.placeholder} |`,
    `| JSON invalid | ${report.json.invalid} |`,
    `| Runnable snippets testable | ${report.snippets.testable}/${report.snippets.eligible} (${report.snippets.testableCoverage.toFixed(1)}%) |`,
    `| Runnable snippets disabled | ${report.snippets.disabled} |`,
    '',
    '### By Section',
    '',
    '| Section | JSON schema | JSON % | Snippets | Snippet % |',
    '|---|---:|---:|---:|---:|'
  ];

  for (const section of report.sections) {
    lines.push(`| \`${section.path}\` | ${section.json.schemaBacked}/${section.json.parseable} | ${pct(section.json.schemaBacked, section.json.parseable)} | ${section.snippets.testable}/${section.snippets.eligible} | ${pct(section.snippets.testable, section.snippets.eligible)} |`);
  }

  lines.push('', '### Top JSON Schema Gaps', '');
  if (report.topGaps.json.length === 0) {
    lines.push('No unvalidated JSON blocks found.');
  } else {
    lines.push('| File | Unvalidated | Schema-backed | JSON blocks |', '|---|---:|---:|---:|');
    for (const gap of report.topGaps.json) {
      lines.push(`| \`${gap.path}\` | ${gap.unvalidated} | ${gap.schemaBacked} | ${gap.total} |`);
    }
  }

  lines.push('', '### Top Runnable Snippet Gaps', '');
  if (report.topGaps.snippets.length === 0) {
    lines.push('No untested runnable snippets found.');
  } else {
    lines.push('| File | Untested | Testable | Executable |', '|---|---:|---:|---:|');
    for (const gap of report.topGaps.snippets) {
      lines.push(`| \`${gap.path}\` | ${gap.untested} | ${gap.testable} | ${gap.executable} |`);
    }
  }

  return lines.join('\n');
}

const report = buildReport();

if (format === 'json') {
  console.log(JSON.stringify(report, null, 2));
} else if (format === 'markdown') {
  console.log(renderMarkdown(report));
} else {
  console.log(renderText(report));
}
