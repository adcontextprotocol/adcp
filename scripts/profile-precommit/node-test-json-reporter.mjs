// node:test reporter that writes one JSON document: every test and suite
// result with its file, duration and (on failure) the assertion details.
// scripts/profile-precommit.mjs adds it next to the spec reporter:
//   node --test --test-reporter=spec --test-reporter-destination=stdout \
//     --test-reporter=<this file> --test-reporter-destination=<out.json> ...

function serializeError(error, depth = 0) {
  if (!error || typeof error !== 'object' || depth > 3) return error === undefined ? undefined : String(error);
  const out = {
    name: error.name,
    code: error.code,
    message: typeof error.message === 'string' ? error.message : undefined,
  };
  if ('expected' in error) out.expected = safe(error.expected);
  if ('actual' in error) out.actual = safe(error.actual);
  if (error.operator) out.operator = error.operator;
  if (typeof error.stack === 'string') out.stack = error.stack.split('\n').slice(0, 8).join('\n');
  if (error.cause) out.cause = serializeError(error.cause, depth + 1);
  if (error.failureType) out.failureType = error.failureType;
  return out;
}

function safe(value) {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text && text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
  } catch {
    return String(value);
  }
}

export default async function* jsonReporter(source) {
  const tests = [];
  const diagnostics = [];
  const stderr = [];
  for await (const event of source) {
    const data = event.data ?? {};
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      tests.push({
        status: event.type === 'test:pass' ? (data.skip ? 'skipped' : data.todo ? 'todo' : 'passed') : 'failed',
        type: data.details?.type ?? 'test',
        name: data.name,
        file: data.file,
        line: data.line,
        nesting: data.nesting,
        duration_ms: data.details?.duration_ms,
        error: event.type === 'test:fail' ? serializeError(data.details?.error) : undefined,
      });
    } else if (event.type === 'test:diagnostic') {
      diagnostics.push(data.message);
    } else if (event.type === 'test:stderr' && stderr.length < 200) {
      stderr.push({ file: data.file, message: data.message });
    }
  }
  yield `${JSON.stringify({ tests, diagnostics, stderr }, null, 1)}\n`;
}
