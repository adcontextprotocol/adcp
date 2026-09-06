/** Planning-only manual entrypoint: it has no dispatch or output path. */
import { parseFixedTraceDiagnosticCliArguments } from "../../src/addie/eval/fixed-trace-diagnostic-cli.js";

const arguments_ = parseFixedTraceDiagnosticCliArguments(process.argv.slice(2));
if (!arguments_.validateOnly)
  throw new Error(
    "This planning-only evaluator requires --validate-only and cannot dispatch providers",
  );
// This entrypoint is deliberately data-only. Some transitive corpus modules
// initialize diagnostic loggers while their immutable declarations load; keep
// those process-local diagnostics isolated from the one-machine-readable-line
// validate-only contract.
process.env.LOG_LEVEL = "silent";
const {
  FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL,
  assertFixedTraceEvaluationProtocol,
  estimateFixedTraceEvaluationProtocol,
} = await import("../../src/addie/eval/fixed-trace-evaluation-protocol.js");
assertFixedTraceEvaluationProtocol(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL);
const estimate = estimateFixedTraceEvaluationProtocol(
  FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL,
);
console.log(
  JSON.stringify({
    diagnosticOnly: true,
    dispatchable: false,
    outputWritten: false,
    providerCalls: 0,
    externalFinalN: estimate.externalFinalN,
    totalCeilingUsd: estimate.totalCeilingUsd,
  }),
);
