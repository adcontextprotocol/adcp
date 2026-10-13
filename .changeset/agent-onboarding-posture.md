---
"adcontextprotocol": minor
---

Add the optional, experimental `account.agent_onboarding` block on `get_adcp_capabilities` (feature id `account.agent_onboarding`, #8113): a seller's onboarding posture for buyer agents.

**Shape.** A mode (`open`, `application`, `invite_only`) for sandbox and per billing party, keyed by `operator`, `agent`, or `advertiser` and a subset of `supported_billing`. Each mode carries optional requirements and its own optional `url`. The block also has a top-level `url`, `documentation_url`, and `message`.

**Requirement kinds** are extensible, and each states its direction:
- `agent_identity`, `grant`, `billing_entity`, `contract`, and `credit_application` apply when a seller gates a buyer;
- `aao_verified`, `storyboard`, `sandbox`, and `experimental_feature` apply when a buyer gates a seller.

**What `open` means.** It binds identity, not spend, and needs the Web Bot Auth profile.

**Uniformity.** The block is seller-wide, served on the unauthenticated fetch, and absent from error payloads, so it is no onboarding oracle. New schemas: `core/agent-onboarding.json`, `core/agent-onboarding-tier.json`, `core/agent-onboarding-requirement.json`, `enums/agent-onboarding-mode.json`, `enums/agent-onboarding-requirement-kind.json`. Buyer posture (#8114): `core/buyer-onboarding-posture.json` with modes `considers_unsolicited`, `application`, `invite_only` (`enums/buyer-onboarding-mode.json`), published in a buying agent's trust.json at `agents[].profiles.adcp.onboarding` or as a record default at `profiles.adcp.onboarding`.
