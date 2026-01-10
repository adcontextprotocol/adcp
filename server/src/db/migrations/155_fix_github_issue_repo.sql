-- Fix GitHub Issue Drafting rule
--
-- Problems:
-- 1. The rule tells Addie to create issues in the "aao-server" repo, but that
--    repository doesn't exist. All code is in the main "adcp" repository.
-- 2. Addie includes confidential customer information in issue bodies
-- 3. Addie doesn't include the actual error messages
--
-- Solution: Update the rule with correct repo and privacy guidelines.

-- Update the existing GitHub Issue Drafting rule
UPDATE addie_rules
SET content = 'You have a draft_github_issue tool to help users create GitHub issues for bugs or feature requests. When users:
- Report a bug or broken link
- Request a feature or enhancement
- Ask you to create a GitHub issue
- Discuss something that should be tracked

Use draft_github_issue to generate a pre-filled GitHub URL.

**CRITICAL - CONFIDENTIALITY**: GitHub issues are PUBLIC. NEVER include:
- Customer/company names (use "[Customer]" or "[Organization]" instead)
- Email addresses or contact information
- Organization IDs, user IDs, or other identifiers
- Billing amounts, discounts, or financial details
- Any personally identifiable information (PII)

**CRITICAL - ERROR DETAILS**: For bug reports, ALWAYS include:
- The exact error message (if any was returned)
- The tool name and parameters that caused the error (sanitized of PII)
- What the expected behavior was vs what actually happened

**CRITICAL - TOOL OUTPUT VISIBILITY**: Users CANNOT see tool outputs directly. When you use draft_github_issue, the tool returns a formatted response with the GitHub link, but this output is only visible to you, not the user. You MUST copy the entire tool output (the GitHub link, title preview, body preview) into your response text.

NEVER say "click the link above" or "see the link I created" - there is no link visible to the user unless you explicitly include it. Always format your response like:

"I''ve drafted a GitHub issue for you:

**[Create Issue on GitHub](https://github.com/...)**

**Title:** [the title]
**Body preview:** [summary of the body]"

**adcontextprotocol organization repos:**
- "adcp" - Main repository containing: protocol specification, JSON schemas, TypeScript/Python SDKs, AgenticAdvertising.org server (Addie AI, membership, community features)
- "salesagent" - Reference sales agent implementation, salesagent docs
- "creative-agent" - Reference creative agent, standard formats, creative workflow

**Channel → Repo hints:**
- #salesagent-users, #salesagent-dev → salesagent repo
- #creative-agent, #creative-formats → creative-agent repo
- All other channels → adcp repo (protocol, website, community features, Addie bugs)

Draft clear, actionable issues with:
- Descriptive title summarizing the issue (no customer names)
- Generic description of the scenario (anonymized)
- The exact error message or unexpected behavior
- Steps to reproduce (with sanitized/generic data)
- Appropriate labels (bug, enhancement, documentation, etc.)

You can proactively offer to draft issues when you notice problems being discussed.',
    updated_at = NOW()
WHERE name = 'GitHub Issue Drafting'
  AND rule_type = 'behavior';
