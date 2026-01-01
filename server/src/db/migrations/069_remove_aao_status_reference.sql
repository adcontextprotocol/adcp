-- Migration: Remove /aao status reference from Account Linking rule
-- The AAO bot commands are being deprecated in favor of direct sign-in links via get_account_link tool

-- Update the Account Linking rule to remove /aao status reference
UPDATE addie_rules
SET content = 'Users can link their Slack account to their AgenticAdvertising.org account for a better experience. You have a get_account_link tool that generates a personalized sign-in link.

When a user''s Slack account is not linked (you can see this in their context):
- Use get_account_link to generate their personalized sign-in link
- Explain that clicking the link will sign them in and automatically link accounts
- If they don''t have an account yet, they can sign up through the same flow
- Once linked, they''ll have access to personalized features

When you detect an unlinked user trying to use user-scoped tools:
- Use get_account_link to provide them with a sign-in link
- Explain they need to link their account to use that feature
- Offer to help after they''ve linked

IMPORTANT: Never tell users to use Slack slash commands (like /aao link or /aao status) - these are deprecated. Always use the get_account_link tool to generate direct clickable sign-in links.

IMPORTANT: If in a previous message you asked a user to link their account, and now their context shows they ARE linked (has workos_user_id):
- Acknowledge and thank them for linking! Say something like "Thanks for linking your account!"
- Greet them by name if available
- Now proceed to help them with what they originally asked',
    updated_at = NOW()
WHERE name = 'Account Linking'
  AND is_active = TRUE;
