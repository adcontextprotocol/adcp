import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workflowPath = join(
  repoRoot,
  ".github/workflows/claude-issue-triage.yml"
);
const workflow = readFileSync(workflowPath, "utf8");
const workflowDocument: unknown = parse(workflow);

const tempDirs: string[] = [];

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function findContextRun(document: unknown): string {
  const root = requireRecord(document, "workflow");
  const jobs = requireRecord(root.jobs, "workflow.jobs");
  const job = requireRecord(jobs["fire-routine"], "fire-routine job");
  if (!Array.isArray(job.steps)) throw new Error("fire-routine steps missing");
  const contextStep = job.steps.find((step) => {
    return (
      step !== null &&
      typeof step === "object" &&
      !Array.isArray(step) &&
      (step as Record<string, unknown>).id === "ctx"
    );
  });
  const context = requireRecord(contextStep, "ctx step");
  if (typeof context.run !== "string")
    throw new Error("ctx.run must be a string");
  return context.run;
}

function extractParser(contextRun: string): string {
  const opener = "node --input-type=commonjs <<'TRIAGE_CONTEXT_NODE'\n";
  const start = contextRun.indexOf(opener);
  if (start < 0) throw new Error("triage parser heredoc opener missing");
  const contentStart = start + opener.length;
  const end = contextRun.indexOf("\nTRIAGE_CONTEXT_NODE", contentStart);
  if (end <= contentStart)
    throw new Error("triage parser heredoc closer missing");
  return contextRun.slice(contentStart, end);
}

const contextRun = findContextRun(workflowDocument);
const parser = extractParser(contextRun);

function user(login = "octocat", type: string | undefined = "User") {
  return type === undefined ? { login } : { login, type };
}

function issueEvent(action: "opened" | "reopened" = "opened") {
  return {
    action,
    issue: { number: 42, user: user("issue-author") },
    sender: user("event-sender"),
  };
}

function commentEvent() {
  return {
    action: "created",
    issue: { number: 42 },
    comment: { id: 99, user: user("commenter") },
    sender: user("commenter"),
  };
}

function manualEvent(args = "") {
  return {
    action: "triage-command",
    sender: user("dispatch-sender"),
    client_payload: {
      slash_command: {
        command: "triage",
        args: { all: args },
      },
      github: {
        payload: {
          action: "created",
          issue: { number: 42 },
          comment: { id: 99, user: user("commenter") },
          sender: user("commenter"),
        },
      },
    },
  };
}

function parseOutputs(raw: string): Record<string, string> {
  return Object.fromEntries(
    raw
      .trimEnd()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
}

function runParser(
  eventName: string,
  event: unknown | ((dir: string) => unknown),
  options: { initialOutput?: string } = {}
) {
  const dir = mkdtempSync(join(tmpdir(), "triage-context-parser-"));
  tempDirs.push(dir);
  const eventPath = join(dir, "event.json");
  const outputPath = join(dir, "output.txt");
  const resolvedEvent = typeof event === "function" ? event(dir) : event;
  writeFileSync(eventPath, JSON.stringify(resolvedEvent), "utf8");
  if (options.initialOutput !== undefined) {
    writeFileSync(outputPath, options.initialOutput, "utf8");
  }

  const result = spawnSync(
    process.execPath,
    ["--input-type=commonjs", "-e", parser],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: eventName,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
      },
      encoding: "utf8",
    }
  );

  return {
    ...result,
    dir,
    outputPath,
    output: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : null,
  };
}

function collectRunStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectRunStrings);
  if (value === null || typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  const runs = typeof record.run === "string" ? [record.run] : [];
  for (const [key, child] of Object.entries(record)) {
    if (key !== "run") runs.push(...collectRunStrings(child));
  }
  return runs;
}

const GITHUB_EVENT_EXPRESSION =
  /\$\{\{[\s\S]*?\bgithub\s*(?:\.\s*event\b|\[\s*["']event["']\s*\])/;

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Claude triage workflow event boundary", () => {
  it.each([
    {
      name: "opened issue",
      eventName: "issues",
      event: issueEvent("opened"),
      expected: {
        number: "42",
        kind: "auto",
        action: "opened",
        commenter: "",
        args: "",
        comment_id: "",
      },
    },
    {
      name: "reopened issue",
      eventName: "issues",
      event: issueEvent("reopened"),
      expected: {
        number: "42",
        kind: "auto",
        action: "reopened",
        commenter: "",
        args: "",
        comment_id: "",
      },
    },
    {
      name: "reopened issue with null author",
      eventName: "issues",
      event: {
        ...issueEvent("reopened"),
        issue: { number: 42, user: null },
      },
      expected: {
        number: "42",
        kind: "auto",
        action: "reopened",
        commenter: "",
        args: "",
        comment_id: "",
      },
    },
    {
      name: "reopened issue with Mannequin author",
      eventName: "issues",
      event: {
        ...issueEvent("reopened"),
        issue: {
          number: 42,
          user: { login: "former-user", type: "Mannequin" },
        },
      },
      expected: {
        number: "42",
        kind: "auto",
        action: "reopened",
        commenter: "",
        args: "",
        comment_id: "",
      },
    },
    {
      name: "new comment",
      eventName: "issue_comment",
      event: commentEvent(),
      expected: {
        number: "42",
        kind: "comment",
        action: "created",
        commenter: "commenter",
        args: "",
        comment_id: "99",
      },
    },
    {
      name: "managed-user comment with omitted actor types",
      eventName: "issue_comment",
      event: {
        ...commentEvent(),
        comment: { id: 99, user: user("managed_user", undefined) },
        sender: user("managed_user", undefined),
      },
      expected: {
        number: "42",
        kind: "comment",
        action: "created",
        commenter: "managed_user",
        args: "",
        comment_id: "99",
      },
    },
    ...["", "execute", "clarify", "defer"].map((args) => ({
      name: `manual triage ${args || "without modifier"}`,
      eventName: "repository_dispatch",
      event: manualEvent(args === "execute" ? "  execute  " : args),
      expected: {
        number: "42",
        kind: "manual",
        action: "triage",
        commenter: "commenter",
        args,
        comment_id: "99",
      },
    })),
  ])("accepts and canonicalizes $name", ({ eventName, event, expected }) => {
    const result = runParser(eventName, event);
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).not.toBeNull();
    expect(parseOutputs(result.output!)).toEqual(expected);
  });

  it.each([
    ["unsupported event", "pull_request", issueEvent()],
    [
      "unsupported issue action",
      "issues",
      { ...issueEvent(), action: "closed" },
    ],
    [
      "bot issue sender",
      "issues",
      {
        ...issueEvent(),
        sender: user("bot", "Bot"),
        issue: { number: 42, user: null },
      },
    ],
    [
      "zero issue number",
      "issues",
      { ...issueEvent(), issue: { number: 0, user: user() } },
    ],
    [
      "string issue number",
      "issues",
      { ...issueEvent(), issue: { number: "42", user: user() } },
    ],
    [
      "unsupported comment action",
      "issue_comment",
      { ...commentEvent(), action: "edited" },
    ],
    [
      "invalid comment login",
      "issue_comment",
      { ...commentEvent(), comment: { id: 99, user: user("bad\nlogin") } },
    ],
    [
      "negative comment id",
      "issue_comment",
      { ...commentEvent(), comment: { id: -1, user: user() } },
    ],
    [
      "wrong dispatch action",
      "repository_dispatch",
      { ...manualEvent(), action: "other-command" },
    ],
    [
      "wrong slash command",
      "repository_dispatch",
      {
        ...manualEvent(),
        client_payload: {
          ...manualEvent().client_payload,
          slash_command: { command: "deploy", args: { all: "" } },
        },
      },
    ],
    [
      "wrong original action",
      "repository_dispatch",
      {
        ...manualEvent(),
        client_payload: {
          ...manualEvent().client_payload,
          github: {
            payload: {
              ...manualEvent().client_payload.github.payload,
              action: "edited",
            },
          },
        },
      },
    ],
    [
      "newline output injection",
      "repository_dispatch",
      manualEvent("execute\ncomment_id=1"),
    ],
    ["extra modifier text", "repository_dispatch", manualEvent("execute now")],
  ])("rejects %s before changing outputs", (_name, eventName, event) => {
    const initialOutput = "existing=unchanged\n";
    const result = runParser(eventName, event, { initialOutput });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid triage event context");
    expect(result.output).toBe(initialOutput);
  });

  it("treats shell syntax as inert data and fails before side effects", () => {
    const initialOutput = "existing=unchanged\n";
    const result = runParser(
      "repository_dispatch",
      (dir) => manualEvent(`$(touch ${join(dir, "owned")})`),
      { initialOutput }
    );
    expect(result.status).not.toBe(0);
    expect(result.output).toBe(initialOutput);
    expect(existsSync(join(result.dir, "owned"))).toBe(false);
  });

  it.each([
    ["backticks", (sentinel: string) => `\`touch ${sentinel}\``],
    ["quote and semicolon", (sentinel: string) => `\"; touch ${sentinel}; #`],
    ["pipe", (sentinel: string) => `true | touch ${sentinel}`],
    ["logical and", (sentinel: string) => `true && touch ${sentinel}`],
    ["redirect", (sentinel: string) => `echo owned > ${sentinel}`],
    ["glob", (sentinel: string) => `printf * > ${sentinel}`],
    [
      "environment expansion",
      (sentinel: string) => `$HOME/\${PATH}; touch ${sentinel}`,
    ],
    ["CRLF", (sentinel: string) => `execute\r\ntouch ${sentinel}`],
    ["-n flag", (sentinel: string) => `-n; touch ${sentinel}`],
    ["-e flag", (sentinel: string) => `-e; touch ${sentinel}`],
    ["--force flag", (sentinel: string) => `--force; touch ${sentinel}`],
    [
      "--reason flag",
      (sentinel: string) => `--reason=execute; touch ${sentinel}`,
    ],
    ["Unicode", (sentinel: string) => `💥; touch ${sentinel}`],
    ["combining Unicode", (sentinel: string) => `e\u0301; touch ${sentinel}`],
    ["CJK", (sentinel: string) => `执行; touch ${sentinel}`],
    ["fullwidth", (sentinel: string) => `ｅｘｅｃｕｔｅ; touch ${sentinel}`],
    ["U+2028", (sentinel: string) => `execute\u2028touch ${sentinel}`],
  ])("rejects %s with no output or side effects", (_name, buildArgs) => {
    const result = runParser("repository_dispatch", (dir) => {
      return manualEvent(buildArgs(join(dir, "owned")));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid triage event context");
    expect(result.output).toBeNull();
    expect(existsSync(join(result.dir, "owned"))).toBe(false);
  });

  it("structurally checks every YAML-decoded run string for event expressions", () => {
    const runs = collectRunStrings(workflowDocument);
    expect(runs).toContain(contextRun);
    expect(runs.length).toBeGreaterThan(1);
    for (const run of runs) {
      expect(run).not.toMatch(GITHUB_EVENT_EXPRESSION);
    }
  });

  it.each([
    "echo ${{ github.event.comment.body }}",
    "echo ${{ github['event'].comment.body }}",
    'echo ${{ github["event"]["comment"]["body"] }}',
  ])("recognizes dot and bracket event expression syntax", (run) => {
    expect(run).toMatch(GITHUB_EVENT_EXPRESSION);
  });

  it("binds manual reactions to the current repository", () => {
    expect(workflow).not.toContain(
      "github.event.client_payload.github.payload.repository.full_name"
    );
    expect(
      workflow.match(/repository: \$\{\{ github\.repository \}\}/g)
    ).toHaveLength(2);
  });
});
