const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("ContextSignals protects non-public single-user content", () => {
  const requestSchema = JSON.parse(
    read("static/schemas/source/trusted-match/context-match-request.json")
  );
  const contextSignals = requestSchema.properties.context_signals;

  assert.match(contextSignals.description, /classifier and privacy boundary/);
  assert.match(
    contextSignals.description,
    /Ephemeral content that many users encounter.*is shared content; one user's turn or query is not/
  );
  assert.match(
    contextSignals.properties.topics.description,
    /MUST use standardized taxonomy identifiers or bounded custom category labels/
  );
  assert.match(
    contextSignals.properties.embedding.description,
    /MUST NOT be computed directly or indirectly from non-public content/
  );
  assert.match(contextSignals.properties.keywords.description, /MUST be policy-filtered/);
  assert.match(
    contextSignals.properties.summary.description,
    /MUST NOT reproduce raw user-authored text/
  );

  const specification = read("docs/trusted-match/specification.mdx");
  assert.match(
    specification,
    /Router isolation prevents identity-path data from entering the context path; it does not make user-derived context anonymous\./
  );

  const aiAssistantSurface = read("docs/trusted-match/surfaces/ai-assistants.mdx");
  assert.match(aiAssistantSurface, /omits `artifact_refs`/);
  assert.doesNotMatch(aiAssistantSurface, /"value": "turn:/);
});
