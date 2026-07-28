import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const REVIEW_SENTINEL = '## Things I checked';
const MAX_DENIAL_LOG_LENGTH = 2_000;

function escapeWorkflowCommand(value) {
  return value
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

function truncate(value, maxLength = MAX_DENIAL_LOG_LENGTH) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function denialSummary(denial) {
  const toolName = typeof denial?.tool_name === 'string' ? denial.tool_name : 'unknown tool';
  const toolInput = denial?.tool_input && typeof denial.tool_input === 'object'
    ? denial.tool_input
    : {};
  return truncate(`${toolName}: ${JSON.stringify(toolInput)}`);
}

function assistantText(message) {
  if (message?.type !== 'assistant' || !Array.isArray(message.message?.content)) return '';
  return message.message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export function inspectExecution(messages) {
  if (!Array.isArray(messages)) {
    throw new Error('Argus execution trace must be a JSON array');
  }

  const result = [...messages].reverse().find((message) => message?.type === 'result');
  const completed = result?.subtype === 'success' && result.is_error === false;
  const denials = Array.isArray(result?.permission_denials) ? result.permission_denials : [];

  const candidates = [];
  if (typeof result?.result === 'string') candidates.push(result.result.trim());
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = assistantText(messages[index]);
    if (text) candidates.push(text);
  }
  const recoveryBody = completed
    ? candidates.find((candidate) => candidate.includes(REVIEW_SENTINEL))
    : undefined;

  return {
    completed,
    denials,
    recoveryBody: recoveryBody || undefined,
  };
}

async function appendOutput(outputFile, name, value) {
  await writeFile(outputFile, `${name}=${value}\n`, { flag: 'a' });
}

async function main() {
  const [executionFile, recoveryFile, outputFile] = process.argv.slice(2);
  if (!executionFile || !recoveryFile || !outputFile) {
    throw new Error('Usage: inspect-execution.mjs <execution-file> <recovery-file> <github-output>');
  }

  const messages = JSON.parse(await readFile(executionFile, 'utf8'));
  const inspection = inspectExecution(messages);

  for (const denial of inspection.denials) {
    const summary = escapeWorkflowCommand(denialSummary(denial));
    console.log(`::warning title=Argus tool call denied::${summary}`);
  }

  await appendOutput(outputFile, 'completed', String(inspection.completed));
  await appendOutput(outputFile, 'denial_count', String(inspection.denials.length));
  await appendOutput(outputFile, 'recovery_available', String(Boolean(inspection.recoveryBody)));
  if (inspection.recoveryBody) {
    await writeFile(recoveryFile, inspection.recoveryBody, 'utf8');
    await appendOutput(outputFile, 'recovery_file', recoveryFile);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::warning title=Argus trace inspection failed::${escapeWorkflowCommand(String(error))}`);
    process.exitCode = 1;
  });
}
