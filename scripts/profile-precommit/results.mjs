// Structured results for one pre-commit run directory: per-step results
// (vitest timing reports, node:test JSON), failure summaries, and the run
// summary (summary.json + summary.html). Shared by the hook runner and the
// profiler (scripts/profile-precommit.mjs), so .hook-runs/ has one layout.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderSummaryHtml } from './render.mjs';

export function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function tail(file, lines) {
  try {
    return readFileSync(file, 'utf8').replace(/\u001b\[[0-9;]*m/g, '').split('\n').slice(-lines).join('\n');
  } catch { return ''; }
}

function readLog(dir, name) {
  try { return readFileSync(path.join(dir, name), 'utf8').replace(/\u001b\[[0-9;]*m/g, ''); } catch { return ''; }
}

export function collectResults(cmd, dir, root) {
  const out = {};
  if (cmd.kind === 'vitest' || cmd.kind === 'server-unit') {
    const vdir = path.join(dir, 'vitest');
    const timings = existsSync(vdir)
      ? readdirSync(vdir).filter((f) => /^timing-.*\.json$/.test(f)).sort().map((f) => ({ file: f, ...readJson(path.join(vdir, f)) }))
      : [];
    const shardsRecord = readJson(path.join(vdir, 'shards.json'));
    const shards = timings.map((t) => {
      const rec = shardsRecord?.shards?.find((s) => t.shard && s.index === t.shard.index);
      const files = t.files ?? [];
      return {
        shard: t.shard ? `${t.shard.index}/${t.shard.count}` : 'all',
        wall_s: rec ? +((rec.endedAt - rec.startedAt) / 1000).toFixed(1) : +(t.wall_ms / 1000).toFixed(1),
        exit_code: rec?.code ?? null,
        files: files.length,
        tests: files.reduce((a, f) => a + f.tests, 0),
        sum_file_s: +(files.reduce((a, f) => a + f.total_ms, 0) / 1000).toFixed(1),
        sum_prepare_s: +(files.reduce((a, f) => a + f.prepare_ms + f.env_ms, 0) / 1000).toFixed(1),
        sum_setup_s: +(files.reduce((a, f) => a + f.setup_ms, 0) / 1000).toFixed(1),
        sum_collect_s: +(files.reduce((a, f) => a + f.collect_ms, 0) / 1000).toFixed(1),
        sum_tests_s: +(files.reduce((a, f) => a + f.tests_ms, 0) / 1000).toFixed(1),
        failed_files: files.filter((f) => f.state === 'failed').length,
        isolate: t.isolate,
        pool: t.pool,
        max_workers: t.max_workers,
        file_parallelism: t.file_parallelism,
        // Busy time per worker lane (concurrencyId): the balance inside one run.
        lanes: Object.values(files.reduce((acc, f) => {
          const lane = (acc[f.worker] ??= { worker: f.worker, files: 0, busy_s: 0 });
          lane.files += 1;
          lane.busy_s = +(lane.busy_s + f.total_ms / 1000).toFixed(1);
          return acc;
        }, {})),
      };
    });
    const files = timings.flatMap((t) => (t.files ?? []).map((f) => ({
      shard: t.shard ? `${t.shard.index}/${t.shard.count}` : 'all', ...f,
    }))).sort((a, b) => b.total_ms - a.total_ms);
    const imports = new Map();
    for (const t of timings) {
      for (const row of t.top_imports ?? []) {
        const cur = imports.get(row.module) ?? { module: row.module, self_ms: 0, total_ms: 0, count: 0 };
        cur.self_ms += row.self_ms; cur.total_ms += row.total_ms; cur.count += row.count;
        imports.set(row.module, cur);
      }
    }
    const log = readLog(dir, 'stdout.log');
    out.vitest = {
      shards,
      files: files.map(({ failures, module_errors, ...rest }) => rest),
      top_imports: [...imports.values()].sort((a, b) => b.self_ms - a.self_ms).slice(0, 40)
        .map((r) => ({ ...r, self_ms: Math.round(r.self_ms), total_ms: Math.round(r.total_ms) })),
      duration_lines: [...log.matchAll(/^(?:\[shard [^\]]+\] )?\s*Duration\s+.*$/gm)].map((m) => m[0].trim()),
      hints: [...log.matchAll(/^.*(?:faster with|modules were evaluated|workers spawned).*$/gm)].map((m) => m[0].trim()).slice(0, 12),
      rerun: shardsRecord?.rerun ?? null,
      failed: timings.flatMap((t) => (t.files ?? []).filter((f) => f.state === 'failed' || f.failures.length || f.module_errors.length)
        .map((f) => ({ file: f.file, shard: t.shard ? `${t.shard.index}/${t.shard.count}` : 'all', failures: f.failures, module_errors: f.module_errors }))),
      unhandled_errors: timings.flatMap((t) => t.unhandled_errors ?? []),
    };
    if (!timings.length) out.vitest.note = 'No timing report found (the run crashed before reporting, or the plan skipped the suite).';
  }
  if (cmd.kind === 'node-test') {
    const nt = readJson(path.join(dir, 'node-test.json'));
    if (nt) {
      const perFile = new Map();
      for (const t of nt.tests) {
        if (t.nesting !== 0) continue;
        const key = path.relative(root, t.file ?? '?');
        perFile.set(key, (perFile.get(key) ?? 0) + (t.duration_ms ?? 0));
      }
      out.node_test = {
        tests: nt.tests.filter((t) => t.type === 'test').length,
        failed: nt.tests.filter((t) => t.status === 'failed' && t.type === 'test').length,
        files: [...perFile.entries()].map(([file, ms]) => ({ file, ms: Math.round(ms) })).sort((a, b) => b.ms - a.ms),
      };
    }
  }
  return out;
}

function tsErrors(text) {
  const byFile = new Map();
  for (const m of text.matchAll(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/gm)) {
    const list = byFile.get(m[1]) ?? [];
    list.push({ line: +m[2], col: +m[3], code: m[4], message: m[5] });
    byFile.set(m[1], list);
  }
  return [...byFile.entries()].map(([file, errors]) => ({ file, count: errors.length, errors: errors.slice(0, 50) }))
    .sort((a, b) => b.count - a.count);
}

export function failureSummary(cmd, dir, report, root) {
  const summary = { exit_code: report.exit_code, timed_out: report.timed_out };
  if (report.timed_out) summary.message = `Killed by the with-timeout budget (${report.budget_s}s for this group).`;
  if (report.vitest) {
    summary.vitest_failed_files = report.vitest.failed;
    if (report.vitest.unhandled_errors.length) summary.unhandled_errors = report.vitest.unhandled_errors;
    if (report.vitest.rerun) summary.serial_rerun = report.vitest.rerun;
  }
  if (cmd.kind === 'node-test') {
    const nt = readJson(path.join(dir, 'node-test.json'));
    summary.node_test_failures = (nt?.tests ?? [])
      .filter((t) => t.status === 'failed' && t.type === 'test')
      .map((t) => ({
        file: path.relative(root, t.file ?? '?'),
        line: t.line,
        name: t.name,
        message: t.error?.cause?.message ?? t.error?.message,
        expected: t.error?.cause?.expected,
        actual: t.error?.cause?.actual,
        stack: t.error?.cause?.stack ?? t.error?.stack,
      }));
  }
  if (cmd.kind === 'tsc' || cmd.kind === 'tsc-wrapper') {
    summary.typecheck_errors_by_file = tsErrors(readLog(dir, 'stdout.log') + '\n' + readLog(dir, 'stderr.log'));
  }
  summary.stderr_tail = tail(path.join(dir, 'stderr.log'), 40);
  summary.stdout_tail = tail(path.join(dir, 'stdout.log'), 25);
  return summary;
}

export function buildSummary(runDir) {
  const meta = readJson(path.join(runDir, 'run.json')) ?? {};
  const reports = readdirSync(runDir)
    .filter((d) => /^\d\d-/.test(d) && existsSync(path.join(runDir, d, 'report.json')))
    .sort()
    .map((d) => ({ dir: d, ...readJson(path.join(runDir, d, 'report.json')) }));
  const total = reports.reduce((a, r) => a + r.wall_s, 0);
  const commands = reports.map((r) => ({
    dir: r.dir, name: r.name, kind: r.kind, command: r.command, status: r.status, advisory: r.advisory, wall_s: r.wall_s,
    share: total ? +(r.wall_s / total).toFixed(3) : 0,
    exit_code: r.exit_code, timed_out: r.timed_out, budget_s: r.budget_s,
    user_s: r.rusage?.user_s, sys_s: r.rusage?.sys_s, max_rss_mb: r.rusage?.max_rss_mb,
    tree_peak_rss_mb: r.tree?.peak_rss_mb, tree_mean_cpu_pct: r.tree?.mean_cpu_pct,
    cpu_profile: r.cpu_profile ? { profiles: r.cpu_profile.profiles, node_processes_seen: r.tree?.node_processes_seen, categories: r.cpu_profile.categories, buckets: r.cpu_profile.buckets.slice(0, 15), functions: r.cpu_profile.functions.slice(0, 15) } : undefined,
    failure: r.failure,
  }));
  const vitestFiles = reports.flatMap((r) => (r.vitest?.files ?? []).map((f) => ({ command: r.name, ...f })))
    .sort((a, b) => b.total_ms - a.total_ms);
  const summary = {
    run_dir: runDir,
    ...meta,
    // Real elapsed time: steps overlap in concurrent runs, so the sum of
    // step walls (sum_command_wall_s) can exceed it.
    total_wall_s: meta.started_at && meta.ended_at
      ? +((Date.parse(meta.ended_at) - Date.parse(meta.started_at)) / 1000).toFixed(1)
      : +total.toFixed(1),
    sum_command_wall_s: +total.toFixed(1),
    exit_code: meta.exit_code,
    commands_ranked: [...commands].sort((a, b) => b.wall_s - a.wall_s).map((c) => c.name),
    commands,
    vitest_shards: reports.flatMap((r) => (r.vitest?.shards ?? []).map((s) => ({ command: r.name, ...s }))),
    vitest_files_top: vitestFiles.slice(0, 60),
    vitest_files_all: vitestFiles.map((f) => ({ command: f.command, file: f.file, shard: f.shard, total_ms: f.total_ms, collect_ms: f.collect_ms, tests_ms: f.tests_ms, setup_ms: f.setup_ms, prepare_ms: f.prepare_ms + f.env_ms, state: f.state })),
    vitest_top_imports: reports.flatMap((r) => (r.vitest?.top_imports ?? []).map((i) => ({ command: r.name, ...i }))).sort((a, b) => b.self_ms - a.self_ms).slice(0, 30),
    vitest_hints: reports.flatMap((r) => (r.vitest?.hints ?? []).map((h) => `${r.name}: ${h}`)),
    vitest_durations: reports.flatMap((r) => (r.vitest?.duration_lines ?? []).map((h) => `${r.name}: ${h}`)),
    node_test_files: reports.flatMap((r) => (r.node_test?.files ?? []).map((f) => ({ command: r.name, ...f }))).sort((a, b) => b.ms - a.ms),
    failures: commands.filter((c) => c.failure).map((c) => ({ name: c.name, dir: c.dir, ...c.failure })),
  };
  writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(path.join(runDir, 'summary.html'), renderSummaryHtml(summary));
  return summary;
}
