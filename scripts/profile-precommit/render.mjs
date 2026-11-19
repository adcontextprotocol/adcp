// Static HTML for a run summary and a run comparison. Opened from disk; no
// network, no scripts beyond plain HTML and CSS.

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const s1 = (v) => (v === null || v === undefined ? '' : Number(v).toFixed(1));
const sec = (ms) => (ms === null || ms === undefined ? '' : (ms / 1000).toFixed(1));

const STYLE = `
:root{--bg:#fbfaf8;--fg:#1d1d1f;--muted:#6b6b70;--line:#e3e1dc;--card:#fff;--bar:#3b6fd4;--bar2:#c9772b;--ok:#2f7d4a;--bad:#b3261e;--code:#f2f0ec}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#17171a;--fg:#ececef;--muted:#9a9aa2;--line:#2e2e34;--card:#1f1f23;--bar:#6d9bf0;--bar2:#e39a55;--ok:#6cc58a;--bad:#f2867e;--code:#26262b}}
:root[data-theme="dark"]{--bg:#17171a;--fg:#ececef;--muted:#9a9aa2;--line:#2e2e34;--card:#1f1f23;--bar:#6d9bf0;--bar2:#e39a55;--ok:#6cc58a;--bad:#f2867e;--code:#26262b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:10px 0;overflow-x:auto}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:12px}td.n,th.n{text-align:right;white-space:nowrap}
.bar{height:8px;background:var(--bar);border-radius:2px;min-width:1px}.bar.b2{background:var(--bar2)}
.ok{color:var(--ok)}.bad{color:var(--bad);font-weight:600}code,pre{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);border-radius:4px}
code{padding:1px 4px}pre{padding:8px;white-space:pre-wrap;word-break:break-word;max-height:360px;overflow:auto}
.kpis{display:flex;flex-wrap:wrap;gap:10px}.kpi{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-width:150px}
.kpi b{display:block;font-size:20px}.wrap{word-break:break-all}details summary{cursor:pointer}
`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>\n`;
}

function bar(value, max, cls = '') {
  const pct = max > 0 ? Math.max(0.5, (value / max) * 100) : 0;
  return `<div class="bar ${cls}" style="width:${pct.toFixed(1)}%"></div>`;
}

function machineLine(m) {
  if (!m) return '';
  return `${m.cpus} CPUs (${esc(m.cpu_model)}), load ${m.loadavg?.join(' / ')}, ${m.available_mem_gb} GB available of ${m.total_mem_gb} GB${m.competing_processes?.length ? `, <span class="bad">${m.competing_processes.length} competing processes</span>` : ', no competing processes'}`;
}

export function renderSummaryHtml(s) {
  const maxWall = Math.max(...s.commands.map((c) => c.wall_s), 1);
  const cmdRows = [...s.commands].sort((a, b) => b.wall_s - a.wall_s).map((c) => `
    <tr><td>${esc(c.name)}<div class="muted wrap"><code>${esc(c.command)}</code></div></td>
    <td class="n">${s1(c.wall_s)}</td><td style="width:22%">${bar(c.wall_s, maxWall)}</td>
    <td class="n">${(c.share * 100).toFixed(0)}%</td><td class="n">${s1(c.user_s)}</td><td class="n">${s1(c.sys_s)}</td>
    <td class="n">${c.max_rss_mb ?? ''}</td><td class="n">${c.tree_peak_rss_mb ?? ''}</td><td class="n">${c.tree_mean_cpu_pct ?? ''}</td>
    <td class="n ${c.exit_code === 0 ? 'ok' : 'bad'}">${c.exit_code}${c.timed_out ? ' (timeout)' : ''}</td></tr>`).join('');

  const maxShard = Math.max(...s.vitest_shards.map((x) => x.wall_s), 1);
  const shardRows = s.vitest_shards.map((x) => `<tr><td>${esc(x.command)}</td><td>${esc(x.shard)}</td><td class="n">${x.wall_s}</td><td style="width:20%">${bar(x.wall_s, maxShard)}</td><td class="n">${x.files}</td><td class="n">${x.tests}</td><td class="n">${x.sum_prepare_s}</td><td class="n">${x.sum_setup_s}</td><td class="n">${x.sum_collect_s}</td><td class="n">${x.sum_tests_s}</td><td class="n ${x.failed_files ? 'bad' : ''}">${x.failed_files}</td><td>${esc(x.pool)} / isolate=${esc(x.isolate)}${x.file_parallelism ? ` / ${x.max_workers} workers` : ''}${x.lanes?.length > 1 ? `<div class="muted">lanes busy s: ${x.lanes.map((l) => l.busy_s).join(', ')}</div>` : ''}</td></tr>`).join('');

  const maxFile = Math.max(...s.vitest_files_top.map((f) => f.total_ms), 1);
  const fileRows = s.vitest_files_top.map((f) => `<tr><td class="wrap">${esc(f.file)}</td><td>${esc(f.command)} ${esc(f.shard)}</td><td class="n">${sec(f.total_ms)}</td><td style="width:16%">${bar(f.total_ms, maxFile)}</td><td class="n">${sec(f.prepare_ms + f.env_ms)}</td><td class="n">${sec(f.setup_ms)}</td><td class="n">${sec(f.collect_ms)}</td><td class="n">${sec(f.tests_ms)}</td><td class="n">${f.tests}</td><td class="${f.state === 'failed' ? 'bad' : ''}">${esc(f.state)}</td></tr>`).join('');

  const importRows = s.vitest_top_imports.map((i) => `<tr><td class="wrap">${esc(i.module)}</td><td>${esc(i.command)}</td><td class="n">${sec(i.self_ms)}</td><td class="n">${sec(i.total_ms)}</td><td class="n">${i.count}</td></tr>`).join('');
  const nodeRows = s.node_test_files.slice(0, 30).map((f) => `<tr><td class="wrap">${esc(f.file)}</td><td>${esc(f.command)}</td><td class="n">${sec(f.ms)}</td></tr>`).join('');

  const cpu = s.commands.filter((c) => c.cpu_profile).map((c) => `
    <div class="card"><b>${esc(c.name)}</b> <span class="muted">${c.cpu_profile.profiles} profiles written; ${c.cpu_profile.node_processes_seen} Node processes seen by the sampler</span>
    <table><tr><th>Category</th><th class="n">Self s</th><th class="n">Share</th></tr>${c.cpu_profile.categories.map((r) => `<tr><td>${esc(r.name)}</td><td class="n">${sec(r.ms)}</td><td class="n">${(r.share * 100).toFixed(0)}%</td></tr>`).join('')}</table>
    <details><summary>Top packages / paths and functions</summary><table><tr><th>Bucket</th><th class="n">Self s</th></tr>${c.cpu_profile.buckets.map((r) => `<tr><td class="wrap">${esc(r.name)}</td><td class="n">${sec(r.ms)}</td></tr>`).join('')}</table>
    <table><tr><th>Function</th><th class="n">Self s</th></tr>${c.cpu_profile.functions.map((r) => `<tr><td class="wrap">${esc(r.name)}</td><td class="n">${sec(r.ms)}</td></tr>`).join('')}</table></details></div>`).join('');

  const failures = (s.failures ?? []).map((f) => `
    <div class="card"><b class="bad">${esc(f.name)}</b> exit ${f.exit_code}${f.timed_out ? ' (timed out)' : ''} <span class="muted">— ${esc(f.dir)}/stderr.log</span>
    ${f.message ? `<p>${esc(f.message)}</p>` : ''}
    ${(f.vitest_failed_files ?? []).map((v) => `<div><b>${esc(v.file)}</b> <span class="muted">${esc(v.shard)}</span>${v.module_errors.map((m) => `<pre>${esc(m)}</pre>`).join('')}${v.failures.map((t) => `<div>✗ ${esc(t.name)}</div>${t.errors.map((e) => `<pre>${esc(e.message)}${e.diff ? `\n${esc(e.diff)}` : ''}</pre>`).join('')}`).join('')}</div>`).join('')}
    ${f.serial_rerun ? `<p>Serial re-run of ${f.serial_rerun.files.length} file(s): exit ${f.serial_rerun.code}</p>` : ''}
    ${(f.node_test_failures ?? []).map((t) => `<div><b>${esc(t.file)}:${t.line ?? ''}</b> ✗ ${esc(t.name)}<pre>${esc(t.message)}${t.expected !== undefined ? `\nexpected: ${esc(t.expected)}\nactual:   ${esc(t.actual)}` : ''}</pre></div>`).join('')}
    ${(f.typecheck_errors_by_file ?? []).map((t) => `<div><b>${esc(t.file)}</b> (${t.count})<pre>${t.errors.map((e) => `${e.line}:${e.col} ${e.code} ${esc(e.message)}`).join('\n')}</pre></div>`).join('')}
    <details><summary>stderr tail</summary><pre>${esc(f.stderr_tail)}</pre></details>
    <details><summary>stdout tail</summary><pre>${esc(f.stdout_tail)}</pre></details></div>`).join('');

  const body = `
  <h1>Pre-commit run ${esc(s.label ?? '')}</h1>
  <div class="muted">${esc(s.run_dir)}<br>${esc(s.started_at)} → ${esc(s.ended_at)} · HEAD ${esc(s.git?.head?.slice(0, 10))} (${esc(s.git?.branch)}) · Node ${esc(s.node)} · options ${esc(JSON.stringify(s.options))}</div>
  <div class="kpis" style="margin-top:12px">
    <div class="kpi"><span class="muted">Total wall</span><b>${(s.total_wall_s / 60).toFixed(1)} min</b>${s.total_wall_s}s</div>
    <div class="kpi"><span class="muted">Result</span><b class="${s.exit_code === 0 ? 'ok' : 'bad'}">${s.exit_code === 0 ? 'passed' : `failed (${s.exit_code})`}</b>${s.commands.length} commands</div>
  </div>
  <div class="card"><b>Machine at start:</b> ${machineLine(s.machine_start)}<br><b>At end:</b> ${machineLine(s.machine_end)}
  ${s.machine_start?.competing_processes?.length ? `<details><summary>Competing processes at start</summary><pre>${esc(s.machine_start.competing_processes.join('\n'))}</pre></details>` : ''}</div>
  ${failures ? `<h2>Failures</h2>${failures}` : ''}
  <h2>Commands by wall time</h2>
  <div class="card"><table><tr><th>Command</th><th class="n">Wall s</th><th></th><th class="n">Share</th><th class="n">User s</th><th class="n">Sys s</th><th class="n">Max proc RSS MB</th><th class="n">Tree peak RSS MB</th><th class="n">Mean CPU %</th><th class="n">Exit</th></tr>${cmdRows}</table></div>
  ${shardRows ? `<h2>Vitest shards</h2><div class="card"><table><tr><th>Command</th><th>Shard</th><th class="n">Wall s</th><th></th><th class="n">Files</th><th class="n">Tests</th><th class="n">Σ prepare s</th><th class="n">Σ setup s</th><th class="n">Σ import s</th><th class="n">Σ tests s</th><th class="n">Failed</th><th>Pool</th></tr>${shardRows}</table>
  <p class="muted">Σ columns sum per-file phases; with one worker per shard they add up to roughly the shard's wall time, minus worker start-up between files.</p></div>` : ''}
  ${s.vitest_durations?.length ? `<div class="card"><b>Vitest duration lines</b><pre>${esc(s.vitest_durations.join('\n'))}</pre>${s.vitest_hints?.length ? `<b>Vitest hints</b><pre>${esc(s.vitest_hints.join('\n'))}</pre>` : ''}</div>` : ''}
  ${fileRows ? `<h2>Slowest vitest files</h2><div class="card"><table><tr><th>File</th><th>Where</th><th class="n">Total s</th><th></th><th class="n">Prepare</th><th class="n">Setup</th><th class="n">Import</th><th class="n">Tests</th><th class="n">#</th><th>State</th></tr>${fileRows}</table></div>` : ''}
  ${importRows ? `<h2>Costliest imports (self time summed over files)</h2><div class="card"><table><tr><th>Module</th><th>Command</th><th class="n">Self s</th><th class="n">Total s</th><th class="n">Files</th></tr>${importRows}</table></div>` : ''}
  ${nodeRows ? `<h2>node:test files</h2><div class="card"><table><tr><th>File</th><th>Command</th><th class="n">s</th></tr>${nodeRows}</table></div>` : ''}
  ${cpu ? `<h2>CPU profiles (self time)</h2>${cpu}` : ''}
  `;
  return page(`Pre-commit run ${s.label ?? ''}`.trim(), body);
}

export function renderCompareHtml(r) {
  const delta = (d, unit = 's') => (d === null ? '' : `<span class="${d < 0 ? 'ok' : d > 0 ? 'bad' : ''}">${d > 0 ? '+' : ''}${unit === 'ms' ? (d / 1000).toFixed(1) : d.toFixed(1)}</span>`);
  const cmdRows = r.commands.map((c) => `<tr><td>${esc(c.name)}</td><td class="n">${s1(c.a_s)}</td><td class="n">${s1(c.b_s)}</td><td class="n">${delta(c.delta_s)}</td><td class="n">${s1(c.a_cpu_s)}</td><td class="n">${s1(c.b_cpu_s)}</td><td class="n">${c.a_exit ?? ''} → ${c.b_exit ?? ''}</td></tr>`).join('');
  const shard = (list) => (list ?? []).map((x) => `${x.command} ${x.shard}: ${x.wall_s}s, ${x.files} files`).join('<br>');
  const fileRows = r.files_changed_most.map((f) => `<tr><td class="wrap">${esc(f.file)}</td><td>${esc(f.command)}</td><td class="n">${sec(f.a_ms)}</td><td class="n">${sec(f.b_ms)}</td><td class="n">${delta(f.delta_ms, 'ms')}</td><td>${esc(f.a_state ?? '—')} → ${esc(f.b_state ?? '—')}</td></tr>`).join('');
  const body = `
  <h1>Pre-commit run comparison</h1>
  <div class="card"><b>A</b> ${esc(r.a.dir)} — ${r.a.total_wall_s}s, exit ${r.a.exit_code}<br><span class="muted">${machineLine(r.a.machine)} · ${esc(JSON.stringify(r.a.options))}</span><br>
  <b>B</b> ${esc(r.b.dir)} — ${r.b.total_wall_s}s, exit ${r.b.exit_code}<br><span class="muted">${machineLine(r.b.machine)} · ${esc(JSON.stringify(r.b.options))}</span></div>
  <div class="kpis"><div class="kpi"><span class="muted">Total delta</span><b>${delta(r.total_delta_s)} s</b>${(r.a.total_wall_s / 60).toFixed(1)} → ${(r.b.total_wall_s / 60).toFixed(1)} min</div><div class="kpi"><span class="muted">Delta over shared commands</span><b>${delta(r.common_delta_s)} s</b>commands both runs executed</div></div>
  <h2>Commands</h2><div class="card"><table><tr><th>Command</th><th class="n">A s</th><th class="n">B s</th><th class="n">Δ s</th><th class="n">A CPU s</th><th class="n">B CPU s</th><th class="n">Exit</th></tr>${cmdRows}</table></div>
  <h2>Shards</h2><div class="card"><b>A</b><br>${shard(r.shards.a)}<br><br><b>B</b><br>${shard(r.shards.b)}</div>
  <h2>Vitest files with the largest change</h2><div class="card"><table><tr><th>File</th><th>Command</th><th class="n">A s</th><th class="n">B s</th><th class="n">Δ s</th><th>State</th></tr>${fileRows}</table>
  ${r.files_only_in_a.length ? `<p>Only in A: ${r.files_only_in_a.length}</p>` : ''}${r.files_only_in_b.length ? `<p>Only in B: ${r.files_only_in_b.length}</p>` : ''}</div>`;
  return page('Pre-commit comparison', body);
}
