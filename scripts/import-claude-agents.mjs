import fs from "node:fs";
import path from "node:path";

const workspaceRoot = process.cwd();
const rolesDir = path.join(workspaceRoot, ".agents", "roles");
const codexDir = path.join(workspaceRoot, ".codex");
const codexAgentsDir = path.join(codexDir, "agents");
const claudeAgentsDir = path.join(workspaceRoot, ".claude", "agents");

const sharedPreamble = [
  "Read AGENTS.md and .agents/playbook.md first.",
  "If the task is a shortcut-style workflow, check .agents/shortcuts/ when relevant.",
  "",
].join("\n");

// Repo-specific roles that live only in .codex (not in .agents/roles)
const codexOnlyRoles = [
  {
    name: "protocol-reviewer",
    description:
      "Review protocol, schema, and documentation changes for correctness, workflow regressions, versioning mistakes, and missing tests.",
    configFile: "agents/protocol-reviewer.toml",
  },
  {
    name: "docs-writer",
    description:
      "Write or revise AdCP documentation and walkthroughs while preserving schema accuracy, fictional examples, and character consistency.",
    configFile: "agents/docs-writer.toml",
  },
];

function parseFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error("Missing frontmatter block");
  }

  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) {
      continue;
    }
    const [, key, rawValue] = kv;
    frontmatter[key] = rawValue.replace(/^"(.*)"$/, "$1");
  }

  return { frontmatter, body: match[2].trim() };
}

function tomlString(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n")}"`;
}

function tomlMultiline(value) {
  // Escape backslashes first, then triple-quotes, so the backslash in \""" doesn't get double-escaped.
  return `"""\n${value.replaceAll("\\", "\\\\").replaceAll('"""', '\\"""')}\n"""`;
}

function buildRoleFile(body) {
  const instructions = `${sharedPreamble}${body}`.trim();
  return [
    'model_reasoning_summary = "concise"',
    "",
    `developer_instructions = ${tomlMultiline(instructions)}`,
    "",
  ].join("\n");
}

// Validate every role file before doing any I/O so a malformed input
// never leaves .claude/agents/ and .codex/agents/ half-written.
const MAX_DESCRIPTION_CHARS = 500;

const importedRoles = [];
const seenNames = new Set(codexOnlyRoles.map((r) => r.name));

for (const entry of fs.readdirSync(rolesDir).sort()) {
  if (!entry.endsWith(".md")) {
    continue;
  }

  const filePath = path.join(rolesDir, entry);
  const source = fs.readFileSync(filePath, "utf8");
  const { frontmatter, body } = parseFrontmatter(source);
  const name = frontmatter.name || path.basename(entry, ".md");

  if (!/^[a-z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid agent name "${name}" in ${entry}. Use only lowercase letters, digits, hyphens, and underscores.`);
  }

  if (name !== path.basename(entry, ".md")) {
    throw new Error(`Frontmatter name "${name}" does not match filename ${entry}. Keep them aligned so Claude Code and Codex resolve to the same agent.`);
  }

  if (seenNames.has(name)) {
    throw new Error(`Duplicate agent name "${name}" from ${entry}`);
  }
  seenNames.add(name);

  const description = frontmatter.description;

  if (!description) {
    throw new Error(`Missing description in ${entry}`);
  }

  if (description.length > MAX_DESCRIPTION_CHARS) {
    throw new Error(
      `Description in ${entry} is ${description.length} chars (limit ${MAX_DESCRIPTION_CHARS}). Long descriptions get silently truncated in Addie's expert-panel system prompt.`,
    );
  }

  importedRoles.push({
    name,
    description,
    body,
    source,
    configFile: `agents/${name}.toml`,
  });
}

// `-deep` is a reserved suffix for long-form design advisors that pair
// with a short triage variant. Addie's expert-panel filter in
// server/src/addie/rules/index.ts assumes every *-deep.md has a short
// counterpart (and vice versa is allowed: short-only is fine, deep-only
// is a misuse).
const allNames = new Set(importedRoles.map((r) => r.name));
for (const role of importedRoles) {
  if (role.name.endsWith("-deep")) {
    const shortName = role.name.slice(0, -"-deep".length);
    if (!allNames.has(shortName)) {
      throw new Error(
        `Role "${role.name}" has no matching short variant "${shortName}.md". The -deep suffix is reserved for design-advisor counterparts of triage checkers.`,
      );
    }
  }
}

// All validation passed — safe to regenerate output directories.
// .codex/agents/ is fully owned by this script (no hand-authored files
// live there), so wipe-and-write is safe. .claude/agents/ may contain
// a hand-authored README.md; remove only stale role files there.
fs.rmSync(codexAgentsDir, { recursive: true, force: true });
fs.mkdirSync(codexAgentsDir, { recursive: true });
fs.mkdirSync(claudeAgentsDir, { recursive: true });

const expectedClaudeFiles = new Set(importedRoles.map((r) => `${r.name}.md`));
for (const existing of fs.readdirSync(claudeAgentsDir)) {
  if (existing.endsWith(".md") && !expectedClaudeFiles.has(existing) && existing !== "README.md") {
    fs.rmSync(path.join(claudeAgentsDir, existing));
  }
}

for (const role of importedRoles) {
  fs.writeFileSync(path.join(codexAgentsDir, `${role.name}.toml`), buildRoleFile(role.body), "utf8");
  fs.writeFileSync(path.join(claudeAgentsDir, `${role.name}.md`), role.source, "utf8");
}

const allRoles = [...codexOnlyRoles, ...importedRoles];

const configSections = [
  'project_doc_fallback_filenames = ["AGENTS.md"]',
  "",
  ...allRoles.flatMap((role) => [
    `[agents.${role.name}]`,
    `description = ${tomlString(role.description)}`,
    `config_file = ${tomlString(role.configFile)}`,
    "",
  ]),
];

fs.writeFileSync(path.join(codexDir, "config.toml"), `${configSections.join("\n").trim()}\n`, "utf8");

console.log(
  `Synced ${importedRoles.length} roles from .agents/roles/ → .claude/agents/ (md) + .codex/agents/ (toml).`,
);
