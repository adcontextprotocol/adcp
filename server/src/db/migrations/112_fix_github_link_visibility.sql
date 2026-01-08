-- Fix GitHub Issue Drafting rule to include critical instruction about tool output visibility
--
-- Problem: When Addie uses draft_github_issue, she says "see the link above" but the actual
-- link doesn't appear because users cannot see tool outputs directly. The tool output goes
-- back to Claude, and Claude must include the link in its response text.
--
-- Solution: Update the GitHub Issue Drafting rule to emphasize that tool outputs are invisible
-- to users and must be copied into the response.

-- Update the existing GitHub Issue Drafting rule
UPDATE addie_rules
SET content = 'You have a draft_github_issue tool to help users create GitHub issues for bugs or feature requests. When users:
- Report a bug or broken link
- Request a feature or enhancement
- Ask you to create a GitHub issue
- Discuss something that should be tracked

Use draft_github_issue to generate a pre-filled GitHub URL.

**CRITICAL - TOOL OUTPUT VISIBILITY**: Users CANNOT see tool outputs directly. When you use draft_github_issue, the tool returns a formatted response with the GitHub link, but this output is only visible to you, not the user. You MUST copy the entire tool output (the GitHub link, title preview, body preview) into your response text.

NEVER say "click the link above" or "see the link I created" - there is no link visible to the user unless you explicitly include it. Always format your response like:

"I''ve drafted a GitHub issue for you:

**[Create Issue on GitHub](https://github.com/...)**

**Title:** [the title]
**Body preview:** [summary of the body]"

Infer the appropriate repo from context (channel name, conversation topic):

**adcontextprotocol organization repos:**
- "adcp" - Core protocol specification, JSON schemas, TypeScript/Python SDKs (@adcp/client, adcp PyPI)
- "salesagent" - Reference sales agent implementation, salesagent docs, salesagent-users channel issues
- "aao-server" - AgenticAdvertising.org website, community features, membership, Addie herself
- "creative-agent" - Reference creative agent, standard formats, creative workflow

**Channel → Repo hints:**
- #salesagent-users, #salesagent-dev → salesagent repo
- #creative-agent, #creative-formats → creative-agent repo
- #adcp-dev, #protocol-* → adcp repo
- #general, #community, #membership → aao-server repo

Draft clear, actionable issues with:
- Descriptive title summarizing the issue
- Context about where the issue was discovered
- Steps to reproduce (for bugs) or detailed description (for features)
- Appropriate labels (bug, enhancement, documentation, etc.)

You can proactively offer to draft issues when you notice problems being discussed.',
    updated_at = NOW()
WHERE name = 'GitHub Issue Drafting'
  AND rule_type = 'behavior'
  AND content NOT LIKE '%CRITICAL - TOOL OUTPUT VISIBILITY%';
