---
name: adcp-si
description: Execute AdCP Sponsored Intelligence (SI) Protocol operations with brand agents - start conversational sessions, send messages, preview offerings, and manage session lifecycle. Use when users want to have conversations with brand agents, explore product offerings, or manage sponsored interactions.
---

# AdCP Sponsored Intelligence (SI) Protocol

This skill enables you to execute the AdCP SI Protocol with brand agents. SI enables conversational commerce sessions where users engage directly with brand agents for shopping, inquiries, and transactions.

> **Buyer-side basics** — idempotency replay, `oneOf` variants, async `status:'submitted'` polling, error recovery from `adcp_error.issues[]` — live in `skills/call-adcp-agent/SKILL.md`. This skill covers per-task semantics only.

## Overview

The SI Protocol provides 4 standardized tasks for managing conversational sessions:

| Task | Purpose | Response Time |
|------|---------|---------------|
| `si_initiate_session` | Start a brand conversation | ~2-5s |
| `si_send_message` | Send a message in an active session | ~1-5s |
| `si_get_offering` | Preview offerings before starting | ~1-3s |
| `si_terminate_session` | End a session | ~1s |

## Typical Workflow

1. **Preview** (optional): `si_get_offering` to see what the brand offers before consent
2. **Start session**: `si_initiate_session` with the user's `intent` and consent
3. **Converse**: `si_send_message` to relay user messages and action responses
4. **End**: `si_terminate_session` when done

---

## Task Reference

### si_initiate_session

Start a conversational session with a brand agent.

**Request:**
```json
{
  "intent": "I'm interested in your winter jacket collection",
  "identity": {
    "consent_granted": true,
    "consent_timestamp": "2025-01-15T10:30:00Z",
    "consent_scope": ["email", "name"],
    "user": {
      "email": "user@example.com",
      "name": "Jane Smith",
      "locale": "en-US"
    }
  },
  "placement": "chatgpt_search"
}
```

**Key fields:**
- `intent` (string, required): Natural language description of user intent — the conversation handoff from host to brand agent
- `identity` (object, required): User identity with consent status
  - `consent_granted` (boolean, required): Whether user consented to share identity
  - `consent_timestamp` (string, optional): ISO 8601 timestamp of consent
  - `consent_scope` (array, optional): Fields user agreed to share
  - `user` (object, optional): PII (only if consent_granted is true) — `email`, `name`, `locale`
  - `anonymous_session_id` (string, optional): Session ID if no consent
- `media_buy_id` (string, optional): AdCP media buy ID if triggered by advertising
- `placement` (string, optional): Where the session was triggered
- `offering_id` (string, optional): Brand-specific offering reference
- `offering_token` (string, optional): Token from `si_get_offering` for session continuity
- `supported_capabilities` (object, optional): Host platform capabilities (modalities, components, commerce)
- `context` (object, optional): Opaque correlation data (e.g., `{"trace_id": "abc-123"}`) echoed unchanged in the response — never parsed by the brand agent

**Response contains:**
- `session_id`: Use in subsequent `si_send_message` and `si_terminate_session` calls
- `greeting`: Brand agent's initial message
- `suggested_actions`: Optional UI elements (buttons, quick replies)

---

### si_send_message

Send a message within an active SI session.

**Text message:**
```json
{
  "session_id": "sess_abc123",
  "message": "Do you have this in size medium?"
}
```

**Action response (button click, form submit):**
```json
{
  "session_id": "sess_abc123",
  "action_response": {
    "action": "add_to_cart",
    "element_id": "btn_add_cart_sku789",
    "payload": {
      "size": "M",
      "color": "navy"
    }
  }
}
```

**Key fields:**
- `session_id` (string, required): Session ID from `si_initiate_session`
- `message` (string, conditional): User's text message. Required unless `action_response` is provided.
- `action_response` (object, conditional): Response to a UI action — `action`, `element_id`, `payload`. Required unless `message` is provided.

**Response contains:**
- `message`: Brand agent's response text
- `suggested_actions`: Optional UI elements for next interaction
- `components`: Optional rich UI components (product cards, carousels, forms)

---

### si_get_offering

Get offering details and availability before initiating a session. Allows showing rich previews before asking for user consent.

**Request:**
```json
{
  "offering_id": "winter-collection-2025",
  "intent": "Looking for warm jackets under $200",
  "include_products": true,
  "product_limit": 5
}
```

**Key fields:**
- `offering_id` (string, required): Offering identifier from the catalog
- `intent` (string, optional): Natural language description of user intent for personalized results (no PII)
- `include_products` (boolean, optional): Include matching products
- `product_limit` (number, optional): Max products to return (default 5, max 50)
- `context` (object, optional): Opaque correlation data echoed unchanged in the response — never parsed by the brand agent

**Response contains:**
- `offering`: Offering details (name, description, availability)
- `products`: Matching products if `include_products` is true
- `offering_token`: Pass to `si_initiate_session` for session continuity

---

### si_terminate_session

End an SI session.

**Request:**
```json
{
  "session_id": "sess_abc123",
  "reason": "user_exit"
}
```

**Key fields:**
- `session_id` (string, required): Session ID to terminate
- `reason` (string, required): Why the session is ending — `handoff_transaction`, `handoff_complete`, `user_exit`, `session_timeout`, `host_terminated`
- `termination_context` (object, optional): Conversation summary, transaction intent, and cause for the termination
- `context` (object, optional): Opaque correlation data echoed unchanged in the response — never parsed by the brand agent

**Reason values:**
- `handoff_transaction`: User is being redirected to complete a transaction
- `handoff_complete`: Transaction completed within the session
- `user_exit`: User chose to leave
- `session_timeout`: Session timed out
- `host_terminated`: Host platform ended the session

---

## Key Concepts

### Consent Model

SI sessions require explicit user consent before sharing PII:
- `consent_granted: false` + `anonymous_session_id`: Anonymous session
- `consent_granted: true` + `user` object: Personalized session with identity

### Session Lifecycle

```
si_get_offering (optional) → si_initiate_session → si_send_message (repeat) → si_terminate_session
```

Sessions are stateful. The brand agent maintains context across messages within a session.

### Placements

Where the SI session was triggered:
- `chatgpt_search`: Within ChatGPT search results
- `publisher_article`: On a publisher's article page
- `social_feed`: In a social media feed
- `ctv_overlay`: On a CTV streaming overlay

---

## Error Handling

Common error codes:

- `SESSION_NOT_FOUND`: Invalid or expired session_id
- `SESSION_EXPIRED`: Session timed out
- `CONSENT_REQUIRED`: Attempting to share PII without consent
- `OFFERING_NOT_FOUND`: Invalid offering_id
- `RATE_LIMITED`: Too many messages in quick succession
