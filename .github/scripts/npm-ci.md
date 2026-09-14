# CI npm install retry

Run `node .github/scripts/npm-ci.mjs` from the repository root on Linux x64.
It executes ordinary `npm ci` and permits **one retry only** when exit 1 and
the contiguous npm stderr block identify the exact C2PA 0.9.4 release download,
Rust fallback, and missing workspace manifest. Other versions, platforms,
partial signatures, additional npm error codes/paths, and signals do not retry.
A second failure remains a job failure with its own exit status or signal.

The matcher comes from [main job 104032687845](https://github.com/adcontextprotocol/adcp/actions/runs/34860948128/job/104032687845)
on 2026-09-14. The same release installed in other jobs of that run, and
[#7511's failed install](https://github.com/adcontextprotocol/adcp/actions/runs/34857319525/job/104020125889)
[passed unchanged](https://github.com/adcontextprotocol/adcp/actions/runs/34857319525/job/104028425924).
Upstream returns false on a non-2xx download without logging the HTTP status;
the fallback then fails because the published Cargo manifest inherits workspace
fields without a workspace root. The logs cannot establish the exact HTTP code.
Keep the match narrow; reassess/remove this workaround when upstream fixes the
installer or the locked version changes. This is not a general npm retry policy.

Both attempts stream stdout/stderr live, with backpressure, and retain separate
complete files in a unique `adcp-npm-ci-*` directory under `RUNNER_TEMP` (or the
OS temporary directory). The path is printed, directory permissions are 0700,
and files are 0600. Capture failure disables retry. No environment/config dump,
shell evaluation, log replay, or artifact upload is added. GitHub's existing
masking applies to the live streams; runner-local files are raw npm output and
must not be uploaded as public artifacts. They live until runner cleanup.
SIGINT/SIGTERM/SIGHUP are forwarded to npm's process group, including lifecycle
children, and the wrapper preserves signal termination even if npm traps it.

The helper covers 11 root installs: Build Check (4 job definitions), migration
smoke (2), training storyboards (2), broken links, schema PR bundle construction,
and the untrusted runtime-attestation build. Existing workflow gates, environment
variables, permissions and timeouts remain in force. `release.yml` and
`deploy.yml` stay outside this CI-only change, including release verification.
The separate `apps/web` and checked-out `sdk` packages are excluded, as is the
existing `sdk-response-conformance.yml` install with scripts disabled (which
cannot execute this postinstall). No dependency, lockfile or install policy changes.

Offline tests run before Build Check's install and can also be run locally:

```sh
node --test .github/scripts/npm-ci.test.cjs
```

Draft #7511 owns external-smoke isolation; Draft #7514 owns PostgreSQL test
barriers. This helper only addresses their shared dependency-install failure.
