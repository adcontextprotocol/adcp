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

fs.rmSync(codexAgentsDir, { recursive: true, force: true });
fs.mkdirSync(codexAgentsDir, { recursive: true });
fs.rmSync(claudeAgentsDir, { recursive: true, force: true });
fs.mkdirSync(claudeAgentsDir, { recursive: true });

const importedRoles = [];
const seenNames = new Set();

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

  fs.writeFileSync(path.join(codexAgentsDir, `${name}.toml`), buildRoleFile(body), "utf8");
  fs.writeFileSync(path.join(claudeAgentsDir, `${name}.md`), source, "utf8");

  importedRoles.push({
    name,
    description,
    configFile: `agents/${name}.toml`,
  });
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
