import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(root, 'server/src/services/format-shape-promotion-registry.ts'), 'utf8');
const vocabulary = readFileSync(path.join(root, 'static/schemas/source/core/format-shape-vocabulary.json'));
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('format promotion registry runtime assets', () => {
  for (const layout of ['server/src/services', 'dist/services']) {
    for (const environment of ['test', 'development', 'production']) {
      it(`loads the real vocabulary from ${layout} with NODE_ENV=${environment}`, () => {
        const fixture = mkdtempSync(path.join(tmpdir(), 'adcp-format-promotion-'));
        directories.push(fixture);
        const registry = path.join(fixture, layout, 'format-shape-promotion-registry.mjs');
        const asset = path.join(fixture, 'static/schemas/source/core/format-shape-vocabulary.json');
        const unrelatedCwd = path.join(fixture, 'unrelated-cwd');
        mkdirSync(path.dirname(registry), { recursive: true });
        mkdirSync(path.dirname(asset), { recursive: true });
        mkdirSync(unrelatedCwd);
        writeFileSync(registry, ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
        }).outputText);
        writeFileSync(asset, vocabulary);
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
          import { getPromotedFormatShapes } from ${JSON.stringify(pathToFileURL(registry).href)};
          const shapes = getPromotedFormatShapes();
          console.log(JSON.stringify({ shapes, cached: shapes === getPromotedFormatShapes(), frozen: Object.isFrozen(shapes) }));
        `], { cwd: unrelatedCwd, env: { NODE_ENV: environment }, encoding: 'utf8', timeout: 5000 });
        const result = JSON.parse(output);
        const authored = JSON.parse(vocabulary.toString('utf8')).vocabulary;
        expect(result.shapes.multi_state_display).toEqual(authored.multi_state_display);
        expect(result.shapes.multi_placement_takeover).toEqual(authored.multi_placement_takeover);
        expect(result.shapes.multi_state_display.promoted_to).toBe('seller_rendered_stateful_display');
        expect(result.shapes.multi_placement_takeover.promoted_to).toBe('coordinated_placements');
        expect(result.shapes.roadblock).toBeUndefined();
        expect(result.cached).toBe(true);
        expect(result.frozen).toBe(true);
      });
    }
  }
});
