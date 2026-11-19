// Vitest reporter that records, per test file, where the time went
// (environment, prepare, setup files, import/collect, tests) plus failures,
// and which imported modules cost the most across all files. It writes
// $ADCP_VITEST_TIMING_DIR/timing-<shard>.json and prints nothing.
// scripts/profile-precommit.mjs adds it with --reporter=<this file>.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const round = (ms) => Math.round((ms ?? 0) * 10) / 10;
const stripAnsi = (text) => String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '');

export default class TimingReporter {
  onInit(vitest) {
    this.vitest = vitest;
    this.startedAt = Date.now();
  }

  onTestRunEnd(testModules, unhandledErrors, reason) {
    const dir = process.env.ADCP_VITEST_TIMING_DIR;
    if (!dir) return;
    const root = this.vitest.config.root;
    const shard = this.vitest.config.shard;
    const imports = new Map();
    const files = testModules.map((module) => {
      const d = module.diagnostic();
      for (const [id, entry] of Object.entries(d.importDurations ?? {})) {
        const key = path.relative(root, id.replace(/^\/@fs/, '')) || id;
        const row = imports.get(key) ?? { self_ms: 0, total_ms: 0, count: 0, external: !!entry.external };
        row.self_ms += entry.selfTime ?? 0;
        row.total_ms += entry.totalTime ?? 0;
        row.count += 1;
        imports.set(key, row);
      }
      const failures = [];
      let tests = 0;
      for (const test of module.children.allTests()) {
        tests += 1;
        const result = test.result();
        if (result.state === 'failed') {
          failures.push({
            name: test.fullName,
            errors: (result.errors ?? []).map((e) => ({
              message: stripAnsi(e.message).slice(0, 2000),
              diff: e.diff ? stripAnsi(e.diff).slice(0, 2000) : undefined,
              stack: e.stack ? stripAnsi(e.stack).split('\n').slice(0, 6).join('\n') : undefined,
            })),
          });
        }
      }
      const moduleErrors = (module.errors?.() ?? []).map((e) => stripAnsi(e.message).slice(0, 2000));
      const total = d.environmentSetupDuration + d.prepareDuration + d.setupDuration + d.collectDuration + d.duration;
      return {
        file: path.relative(root, module.moduleId),
        project: module.project?.name || undefined,
        state: module.state(),
        tests,
        worker: d.concurrencyId,
        env_ms: round(d.environmentSetupDuration),
        prepare_ms: round(d.prepareDuration),
        setup_ms: round(d.setupDuration),
        collect_ms: round(d.collectDuration),
        tests_ms: round(d.duration),
        total_ms: round(total),
        heap: d.heap,
        failures,
        module_errors: moduleErrors,
      };
    });
    const topImports = [...imports.entries()]
      .map(([module, row]) => ({ module, ...row, self_ms: round(row.self_ms), total_ms: round(row.total_ms) }))
      .sort((a, b) => b.self_ms - a.self_ms)
      .slice(0, 60);
    const name = shard ? `timing-${shard.index}-of-${shard.count}.json` : 'timing-all.json';
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), JSON.stringify({
      root,
      shard: shard ?? null,
      reason,
      wall_ms: Date.now() - this.startedAt,
      pool: this.vitest.config.pool,
      isolate: this.vitest.config.isolate,
      max_workers: this.vitest.config.maxWorkers,
      file_parallelism: this.vitest.config.fileParallelism,
      files,
      top_imports: topImports,
      unhandled_errors: unhandledErrors.map((e) => stripAnsi(e.message).slice(0, 2000)),
    }, null, 1));
  }
}
