/** Planning-only manual entrypoint: it has no dispatch or output path. */
import { parseFixedTraceDiagnosticCliArguments } from "../../src/addie/eval/fixed-trace-diagnostic-cli.js";
import {
  FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL,
  assertFixedTraceEvaluationProtocol,
  estimateFixedTraceEvaluationProtocol,
} from "../../src/addie/eval/fixed-trace-evaluation-protocol.js";

const arguments_ = parseFixedTraceDiagnosticCliArguments(process.argv.slice(2));
if (!arguments_.validateOnly)
  throw new Error(
    "This planning-only evaluator requires --validate-only and cannot dispatch providers",
  );
if (arguments_.output !== undefined)
  throw new Error(
    "--output is unavailable in validate-only mode; no artifact may be written",
  );
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
