# Email Conversations

Addie should be able to have full conversations via email, just like she does through Slack and web chat. The channel shouldn't matter.

## Problem

When someone replies to an email from Addie (escalation resolution, welcome email, newsletter), their reply is received by the webhook but Addie doesn't respond. The person gets silence. This is broken — an SDR that doesn't listen to responses isn't an SDR.

## Architecture

Email conversations use the same thread service, Claude client, and tools as Slack and web chat. The only differences are:

1. **Message ingestion**: webhook → parse email → find/create thread → add message
2. **Response delivery**: generate response → send email reply (not Slack message or SSE stream)
3. **Threading**: keyed by `In-Reply-To` / `References` headers (standard email threading), falling back to sender email + subject normalization

## Flow

1. Inbound email arrives at Resend webhook (`POST /api/webhooks/resend-inbound`)
2. Parse sender, subject, body, `In-Reply-To` header
3. Find existing thread by `In-Reply-To` → `email_message_ids` mapping, or create new thread
4. Add user message to thread via `threadService.addMessage()`
5. Route through Addie's normal pipeline (same `processMessage` as web/Slack)
6. Get response from Claude with full tool access
7. Send response as email reply (same `from` address as original email, proper `In-Reply-To` and `References` headers)
8. Add assistant message to thread
9. If Addie needs a human: escalate to Slack with thread link, same as other channels

## Threading

New table or column to map email `Message-ID` headers to thread IDs:

```sql
ALTER TABLE addie_thread_messages ADD COLUMN email_message_id TEXT;
CREATE INDEX idx_thread_messages_email_mid ON addie_thread_messages(email_message_id) WHERE email_message_id IS NOT NULL;
```

To find the right thread for a reply:
1. Look up `In-Reply-To` header in `addie_thread_messages.email_message_id`
2. If found, use that thread
3. If not, look for a thread with the same sender email within 7 days
4. If not, create a new thread

## Response Timing

Send immediately. Email is async by nature — people don't expect instant replies, but they do expect replies. A 30-second response from Addie via email feels fast, not slow.

## Escalation

Same as other channels. If Addie can't handle something, she:
1. Creates an escalation record
2. Posts to the relevant Slack channel with the email thread context
3. Responds to the email: "I've flagged this for the team — someone will follow up shortly."
4. When a human resolves the escalation, the resolution email goes back through the same thread

## What Addie Can Do Via Email

Everything she can do via web chat, minus the real-time streaming. Specifically:
- Answer protocol questions (search_docs)
- Look up member info (search_members, get_agent)
- Handle billing questions (billing tools)
- Process certification questions
- Create escalations
- Suggest newsletter content

## Admin Visibility

Email threads show up in the same thread list as Slack and web threads. The thread has a `channel: 'email'` marker. Admins can see the full conversation in the admin panel.

## Implementation

1. Update `parseAddieContext` to extract thread context from email headers (already done: routes to prospect handler)
2. Modify `handleProspectEmail` to create/find Addie thread instead of just contact activity
3. Route the message through Addie's Claude pipeline
4. Send the response as an email via Resend
5. Store the outbound email's `Message-ID` for future threading
