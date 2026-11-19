// vitest reporter for the hook projects (vitest.config.ts): a failure in one
// sequence.groupOrder skips the groups after it, as the hook's phases did
// before (light checks, then the server suite). vitest runs the groups one
// after another, so when the first test module of a later group is queued,
// every module of the earlier groups has finished and reported; the run is
// then cancelled before that module's tests run. Within a group every module
// runs to the end, so one run shows every failing check of a phase.
// (--bail is not group-aware: it stops at the Nth failure anywhere.)
// ADCP_PRECOMMIT_KEEP_GOING=1 runs every group, as it ran every phase.
export default class HookGroupsReporter {
  onInit(vitest) {
    this.vitest = vitest;
    this.failedGroups = new Set();
    this.cancelled = process.env.ADCP_PRECOMMIT_KEEP_GOING === '1';
  }

  onTestModuleEnd(module) {
    if (module.state() === 'failed') this.failedGroups.add(module.project.config.sequence.groupOrder);
  }

  onTestModuleQueued(module) {
    if (this.cancelled) return;
    const group = module.project.config.sequence.groupOrder;
    const failed = [...this.failedGroups].filter((g) => g < group).sort((a, b) => a - b);
    if (failed.length === 0) return;
    this.cancelled = true;
    this.vitest.logger.log(`\nA test failed in group ${failed.join(', ')}; skipping group ${group} and later (${module.project.name} first).`);
    this.vitest.cancelCurrentRun('a test failed in an earlier sequence.groupOrder');
  }
}
