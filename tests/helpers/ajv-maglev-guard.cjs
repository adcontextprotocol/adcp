'use strict';

// Keep V8's Maglev compiler away from Ajv's generated validators.
//
// The SDK compiles the fully inlined `bundled/` release schemas with Ajv, which
// emits single functions of 9-18 MB bytecode (get-products-response alone is
// 13.7 MB of source). TurboFan refuses anything over 60 KB of bytecode, but
// Maglev on Node 24 (V8 13.6) has no size cap: once one of these validators
// turns hot — about 30 storyboard runs in one process — a concurrent Maglev
// compile allocates ~10 GB of zone memory for ~15 s while the main thread waits
// at a GC safepoint. That spike, not a leak, is what took these suites to
// 11 GB peak RSS and got runners OOM-killed.
//
// Excluding Ajv's `validateN` functions from Maglev leaves them on Sparkplug,
// exactly where TurboFan's size cap already leaves them. It changes no
// validation result, only which JIT tier runs the code. Remove once the SDK
// stops generating multi-megabyte validators:
// https://github.com/adcontextprotocol/adcp-client/issues/3457
//
// The filter is read when V8 decides to tier a function up, so setting it at
// module load (before any storyboard has run) takes effect for the whole file.
require('node:v8').setFlagsFromString('--maglev-filter=-validate*');
