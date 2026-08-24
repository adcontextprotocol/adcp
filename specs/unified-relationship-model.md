# Unified relationship model

## What we're building

Replace Addie's goal-based outreach system with a relationship-based engagement model. Instead of picking a goal and firing a message, Addie maintains a single ongoing relationship with each person across every surface (Slack DM, email, web chat, video). The person's experience should feel like talking to one community manager who remembers the context they have permitted Addie to use, not receiving automated campaigns.

The current system treats each interaction as "pick goal, send template, track outcome." The new system treats each person as an ongoing relationship where Addie decides what to say next based on the relationship history permitted in the current context -- what she said, what they said back, where they are in their journey, and what's happening in the community right now.

## What a "relationship" is

A relationship is the complete record of Addie's engagement with one person. It is not a campaign, a funnel, or a sequence. It's a single row per person that tracks:

- **Who they are** (identity across surfaces)
- **Where they are in their journey** (stage, not goal status)
- **What Addie knows about them** (insights, preferences, interests, with source provenance)
- **What Addie has said to them** (conversation history, fenced by surface and organization context)
- **What they've said back** (responses, sentiment, topics, fenced by their original consent context)
- **When Addie should reach out next** (timing, not a fixed cadence)

### How it differs from the current model

| Current (goal-based) | New (relationship-based) |
|---|---|
| Pick a goal per person | Understand the person, then decide what to say |
| Each outreach is a discrete event | Each message continues an ongoing conversation |
| Goal history tracks: attempted, succeeded, declined | Relationship tracks: the full arc of engagement |
| New Slack thread per interaction (within 7 days) | One DM thread, forever |
| Web chat has no shared context | Web chat loads privacy-fenced relationship context |
| Planner doesn't know what Addie actually said | Every message and response is part of the relationship record |
| Template-based messages with placeholder substitution | Every proactive message composed by Sonnet with full context |

## Person identity and state ownership

The relationship record is an engagement facet of a person. It is not the
person's login, employer membership, billing account, or authorization
principal. Keeping those concepts separate is what lets a person change email
or employer without either losing their own state or retaining access they no
longer have.

### Canonical concepts

| Concept | Meaning | Authorization effect |
|---|---|---|
| `identity` | Durable internal person identifier across verified credentials | None by itself |
| credential binding | A WorkOS user, verified email, Slack identity, or other external identifier linked to the person | Authentication only; never unions organization grants |
| `person_relationships` | Addie's engagement state for the person | None |
| identity profile | Person-managed community profile and preferences | Controls display/communication choices, not access |
| organization membership | Current membership, role, and seat in one organization | Grants only that organization's scoped capabilities |
| billing account | Organization or persistent personal payer/record boundary | None by itself |
| subscription entitlement | Capability grant with an explicit organization or personal-workspace subject | Grants only its declared subject, scope, and capability set |
| affiliation | Current or historical employment/consulting profile fact | None; never substitutes for organization membership |

`identities.id` is the canonical person identifier. The existing
`identity_workos_users` table binds one or more WorkOS credentials to it. Over
time, `person_relationships` becomes a one-to-one engagement facet keyed by
`identity_id`; it must not remain a second, competing person authority.

Identity rows are durable across credential and employer changes, but
"durable" does not mean immortal. Credential deletion, identity erasure,
legal-retention records, and anonymization have distinct lifecycle rules below.

### Ownership and provenance matrix

| Data family | Canonical owner | Provenance retained | Link behavior | Unlink/split behavior |
|---|---|---|---|---|
| WorkOS users, verified emails, Slack IDs, authentication history | Credential or identifier binding | Provider, verification method/time, binding actor, original external ID | Add a binding after proof of control; emergency recovery follows the restricted workflow below | Move only the selected binding; never infer another binding from matching attributes |
| Community profile: slug, headline, bio, avatar, expertise, interests, social links, directory/contact preferences, country/timezone | `identity_id` | Per-field editor, source, edit time, and merge resolution | Resolve conflicts explicitly; never last-write-wins across two populated profiles | Assign the profile to one identity or resolve fields explicitly; do not silently clone it |
| Community points and person-level badges | `identity_id` aggregate over append-only source events | Source credential/channel, reference, action, and award time | Recompute/deduplicate from source events | Partition attributable events; require explicit resolution for unattributable events |
| Engagement score and person journey stage | `identity_id`, derived | Inputs and computation version | Recompute after link | Recompute after split; do not copy a cached total/stage to both sides |
| Certifications and assessments | Originating credential/attempt, aggregated in a person view | Full assessment, issuer, and credential provenance | Union for an authorized person view; do not rewrite issuance history | Follow proven source ownership; disputed records require review |
| Organization memberships, roles, seats, invitations, and organization authority | Organization membership/account | Organization, grantor, seat source, effective dates | **Never merged or unioned by identity linkage** | Remain with their original membership; revoke through the organization authority |
| Billing customers, invoices, refunds, and tax records | Organization or persistent personal billing account | Original payer/account and immutable billing references | Never reassign from an email/identity match alone | Remain with the billing account, subject to billing correction procedures |
| Subscription entitlements | Explicit organization or personal-workspace subject | Billing account, subscription, subject, scope, capability set, and effective dates | Never change subject from identity/email similarity | End or transfer only through the subscription authority; never follow an affiliation |
| Conversations, insights, consent, and contact preferences | Originating relationship/thread/surface scope | Surface, organization context, participants, consent purpose/time | May resolve to the same identity but remain fenced until policy permits use | Remain source-scoped; unlink removes future cross-identity visibility |
| Audit and security events | Immutable event | Authenticated credential, resolved identity at the time, organization context, actor, reason | Append a link event; never rewrite historical actors | Append an unlink/split event; preserve the historical resolution |

An organization membership retains an immutable membership ID and original
authorization principal/binding in addition to its organization, role, seat,
grantor, provider membership reference, and effective dates. Attaching an
identity binding never changes those fields. Authorizing a second credential
requires an explicit organization-issued grant; identity linkage is not that
grant.

"Champion" has two meanings that must not share one portable flag:

- A person-level community journey or reputation status may follow the person.
- Organization-specific champion, contact, administrator, or representative
  authority stays with that organization and ends when its grant ends.

Reputation source events use a globally unambiguous idempotency tuple:
`(source_system, source_tenant, source_event_id)`. Each event also retains
`origin_binding_id`, action, value, reference type, award time, ingestion time,
and attribution status. Null/unnamespaced references are not sufficient for
deduplication. Identity totals, badges, scores, and stages are versioned
projections over those immutable events, with computation version, update
actor, and last successful reconciliation time.

Certification attempts and issuance records likewise retain immutable origin
binding, issuer, source attempt, and external credential IDs. A person view may
union authorized records, but identity merge never deletes or rewrites the
underlying attempt/issuance provenance.

### Link, merge, unlink, and split rules

**Linking credentials** requires proof of control of both sides. Email
similarity, name similarity, employer, domain, Stripe email, or model confidence
may suggest a candidate but can never execute a link.

Emergency recovery is limited to a platform identity-security role (never an
organization administrator), step-up authentication, independent approval,
recorded evidence, subject notification, and delayed activation. It does not
create a working authentication binding until the subject confirms control.

A credential attachment records the authenticated actor, evidence, reason,
target identity, and new binding; it changes no application-owned rows. A
whole-identity merge operation:

1. records the authenticated actor, evidence, reason, and both pre-link identities;
2. binds credentials to one identity without copying organization grants;
3. resolves conflicting person-owned profile values explicitly;
4. deduplicates derived reputation from source events rather than adding cached totals; and
5. bumps the persisted authorization/session epoch in the transaction before
   invalidating affected authentication and context caches.

An unlink/split operation:

1. creates or selects the destination identity before moving a credential;
2. previews profile, reputation, credentials, organization memberships,
   conversations, certifications, and billing records without silently
   reassigning provenance-bound records;
3. assigns non-partitionable person-owned values explicitly;
4. recomputes derived state from attributable source events; and
5. appends an immutable before/after audit event and bumps the persisted
   authorization/session epoch in the same transaction.

Best-effort cache eviction is defense in depth; it is not the revocation
primitive. Every session/token/context cache checks the persisted epoch so a
stale cache cannot retain pre-link or pre-split authority.

The system must not claim that a merge is reversible if it has already erased
the provenance required to partition state again. Credential attachment,
whole-identity merge, and credential transfer/split are distinct operations:

- **Credential attachment** may bind a state-empty credential after proof of
  control. It does not consolidate application rows.
- **Whole-identity merge** requires a preview and immutable per-entity
  disposition records. It preserves both identity IDs in lineage and does not
  rewrite provenance-bound authorities merely to simplify reads.
- **Credential transfer/split** moves a binding using recorded assignments and
  recomputes projections. It is not equivalent to creating an empty singleton
  identity after destructive consolidation.

Until the operation ledger and source attribution needed for a round-trip are
live, existing-account consolidation must remain disabled. Operator access
does not make a destructive merge reversible and is not an exception. It must
not be used by self-service recovery.

The identity-operation ledger is append-only/tamper-evident and records at
least: operation ID, operation kind, authenticated actor credential and
effective identity, source/destination identity IDs, affected binding IDs,
evidence type and hash (not raw secrets), reason, approval IDs, request ID,
per-entity before/after references or dispositions, consent basis, and
timestamp. Database privileges or equivalent storage controls prohibit update
and delete. A summary containing only per-table row counts is not sufficient
to support audit or reversal.

### Deletion and anonymization

- Deleting one credential removes that authentication path. The identity and
  person-owned state survive when another verified credential remains.
- Deleting an identity removes or anonymizes person-owned profile and
  relationship state according to the retention policy.
- Organization memberships and permissions are revoked through their
  organization authority; identity deletion is not a substitute for
  offboarding.
- Billing, certification, security, and audit records retained for legal or
  integrity reasons keep the minimum necessary pseudonymous linkage and their
  original provenance.
- Public profile and former-employer data must be removed or anonymized when
  required even if internal anti-fraud/audit records are retained.

Identity lifecycle is explicit rather than inferred from missing rows:

- `provisional` identities may own sourced contact/relationship state but have
  no authentication authority and no primary authentication binding;
- `active` identities have a verified primary authentication binding, may
  accept additional verified bindings, and own person projections;
- `merged` identities retain immutable lineage to `merged_into_identity_id` and
  cannot authenticate directly; and
- `erased` identities retain only the minimum pseudonymous lineage required by
  legal, security, certification, and audit policy, with `erased_at`, reason,
  and legal-hold state recorded.

Erasure propagates to relationship/profile state, scoped consent, search,
caches, derived projections, summaries, embeddings/vector indexes, prompt or
model telemetry containing user content, and downstream processors. Each data
class declares its purpose, retention/expiry policy, erasure mechanism, and
legal-hold exception. Backups expire under a documented schedule and cannot be
restored into active service without replaying erasure tombstones. Identity
lineage needed by retained audit or security records is pseudonymized rather
than hard-deleted.

### Request authorization context

Every authenticated request that consumes person state resolves an explicit
context tuple:

```text
(authenticated credential, identity_id, surface, selected organization?)
```

The credential proves the login. `identity_id` selects person-owned state. It
is an internal correlation key and must not be serialized to clients or exposed
as a cross-surface identifier. The optional selected organization selects
exactly one organization authorization context.

Organization authorization is resolved only from an active grant for
`(authenticated credential, selected organization)`. `identity_id`, the
identity's primary credential, other linked credentials, affiliations, and
personal subscriptions are never organization-grant inputs. If no organization
is selected, only global and person-level capabilities are available. Using a
different linked credential for an organization requires an explicit
organization-approved membership or credential-use grant.

Personal-subscription capabilities are evaluated independently, and every
resolved capability retains a machine-readable source:

```typescript
type CapabilityGrant = { capability: string } & (
  | { source: 'global'; subject: { kind: 'global' } }
  | {
      source: 'personal_subscription';
      subject: { kind: 'personal_workspace'; personalWorkspaceId: string };
      subscriptionId: string;
    }
  | {
      source: 'organization_seat';
      subject: { kind: 'organization'; organizationId: string };
      organizationGrantId: string;
    }
);
```

Authorization requires the grant subject to equal the resource/action subject.
Code must not build a privilege union from every organization linked to the
identity, and must never authorize using a capability-name-only search across
the grant array.

## Relationship lifecycle

People don't move through "goals." They move through a journey. The stages are not states to be managed -- they're observations about where someone is, used to inform how Addie engages.

### Stages

```
prospect -> welcomed -> exploring -> participating -> contributing -> leading
```

**prospect** -- We know they exist but haven't talked to them yet. They joined Slack, or we have their email from prospect triage. No Addie interaction has happened.

**welcomed** -- Addie has introduced herself. The welcome message has been sent (Slack DM or email). This is the "Hi, welcome to AgenticAdvertising.org" moment. It only happens once.

**exploring** -- They've responded to Addie at least once, or they've taken an action (linked account, visited the site, joined a channel). Addie is learning about them -- what they care about, what their company does, what brought them here.

**participating** -- They're engaged. They're in working groups, attending events, using the platform. Addie shifts from introducing features to being helpful -- sharing relevant updates, connecting them with people, surfacing opportunities.

**contributing** -- They're creating value. Leading sessions, sharing content, helping other members. Addie's role is support and recognition.

**leading** -- Committee leaders, council members, community champions. Addie is a tool for them, not a guide.

Stages advance automatically based on observed behavior (account linking,
message count, group membership, event attendance). They are monotonic during
normal engagement, but a versioned correction, identity split, or removal of
misattributed source events may lower a derived stage. Such a recomputation
records its reason and input/computation version. The stage informs Addie's
tone and content, not whether she contacts someone.

### Stage transitions

Stage transitions are derived from existing data. No manual promotion needed.

```
prospect -> welcomed:      Addie sends first message
welcomed -> exploring:     Person responds OR links account OR joins a channel
exploring -> participating: In 1+ working groups AND engagement_score > 20
participating -> contributing: 30d message count > 20 OR leading a session
contributing -> leading:    is_committee_leader OR council_count > 0
```

## Unified conversation history

### The core idea

Every message between Addie and a person can resolve to the same identity and relationship, but resolution is not permission to disclose or reuse every message on every surface. Each thread and message retains its surface, organization context, participants, and consent provenance. The privacy fence determines which subset is available for a given request.

When the fence permits cross-surface continuity, Addie may use an appropriately attributed summary of a prior conversation. When it does not, she behaves as though that source-scoped history is unavailable. She must never surprise someone with employer-confidential, billing, or private-conversation context merely because two credentials were linked.

### How it works technically

The existing `addie_threads` and `addie_thread_messages` tables already store conversations across channels (Slack, web, a2a, email). The missing piece is linking them to a single person.

Today, threads are linked to a `user_id` (Slack user ID or WorkOS user ID) and a `user_type`. But there's no concept of "all threads belonging to one person across all identities." A Slack user and a WorkOS user might be the same person with two separate thread histories.

The canonical `identity_id` is the glue. Credential/identifier bindings resolve the authenticated surface identity to it. `person_relationships` stores Addie's engagement facet for that identity. Context loading starts from `identity_id`, then applies the request's surface, selected-organization, and consent fence before reading messages or insights.

### Target seam: identity bindings and `person_relationships`

The original migration stored one Slack ID, one WorkOS ID, and one email
directly on `person_relationships`. Those singular columns are transitional;
they cannot represent multiple verified credentials or reversible provenance.
The target relationship facet is one-to-one with the canonical identity:

```sql
CREATE TABLE person_relationships (
  identity_id UUID PRIMARY KEY REFERENCES identities(id),

  -- Display
  display_name VARCHAR(255),       -- transitional; target lives in identity profile

  -- Journey stage
  stage VARCHAR(50) NOT NULL DEFAULT 'prospect'
    CHECK (stage IN ('prospect', 'welcomed', 'exploring', 'participating', 'contributing', 'leading')),
  stage_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Engagement state
  last_addie_message_at TIMESTAMPTZ,     -- when Addie last spoke to them
  last_person_message_at TIMESTAMPTZ,    -- when they last spoke to Addie
  last_interaction_channel VARCHAR(50),   -- which surface was last used

  -- Relationship quality
  sentiment_trend VARCHAR(20) DEFAULT 'neutral'
    CHECK (sentiment_trend IN ('positive', 'neutral', 'negative', 'disengaging')),
  interaction_count INTEGER NOT NULL DEFAULT 0,
  globally_suppressed BOOLEAN NOT NULL DEFAULT FALSE,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_person_relationships_stage ON person_relationships(stage);
```

External identifiers live in constrained binding tables, beginning with the
existing `identity_workos_users`. Slack and email bindings require the same
properties: provider-scoped uniqueness, verification/provenance metadata,
binding status, and an append-only link/unlink audit trail. A billing customer
is not an identity binding; it belongs to its billing account.

The target binding shape is equivalent to:

```sql
CREATE TABLE identity_bindings (
  id UUID PRIMARY KEY,
  identity_id UUID NOT NULL REFERENCES identities(id),
  provider VARCHAR(50) NOT NULL,
  provider_tenant_key VARCHAR(255) NOT NULL, -- canonical tenant or 'global'
  normalized_external_subject VARCHAR(255) NOT NULL,
  binding_kind VARCHAR(40) NOT NULL CHECK (
    binding_kind IN ('authentication', 'delivery',
                     'authentication_and_delivery')
  ),
  status VARCHAR(30) NOT NULL CHECK (
    status IN ('pending_verification', 'active', 'ended', 'disputed')
  ),
  verified_at TIMESTAMPTZ,
  verification_method VARCHAR(50),
  bound_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  UNIQUE (id, identity_id),
  CHECK (
    status <> 'active'
    OR (verified_at IS NOT NULL AND verification_method IS NOT NULL)
  )
);

CREATE UNIQUE INDEX identity_bindings_one_current_claim
  ON identity_bindings(provider, provider_tenant_key,
                       normalized_external_subject)
  WHERE status IN ('pending_verification', 'active');
```

The current-claim uniqueness constraint is partial so ended history does not
block a later verified claim and concurrent pending claims cannot race.
Tenant-scoped providers such as
Slack require a real tenant key; callers cannot omit it. Binding history is
append-only: ending or transferring a binding records a new operation and does
not overwrite its original `created_at`/verification evidence.

Every authentication-enabled active identity has exactly one verified, active
primary authentication binding whose kind includes authentication. A
provisional identity has none
and cannot authorize a request; promotion to `active` requires a verified
authentication binding and primary selection.

The current partial index on `identity_workos_users.is_primary` enforces only
"at most one," not "exactly one." The target uses a non-null
`identities.primary_binding_id` for authentication-enabled identities plus a
deferred same-identity integrity check, or an equivalent deferred
constraint/trigger that makes zero primaries uncommittable for that lifecycle
state.

Email outreach chooses from verified email bindings plus communication consent
and preference. It does not store an unqualified "primary email" on the
relationship row.

Delivery and consent state is scoped to the destination, not stored once per
person:

```sql
CREATE TABLE relationship_delivery_state (
  identity_id UUID NOT NULL,
  binding_id UUID NOT NULL,
  provider_tenant_key VARCHAR(255) NOT NULL,
  surface VARCHAR(50) NOT NULL,
  scope_kind VARCHAR(20) NOT NULL CHECK (
    scope_kind IN ('personal', 'organization')
  ),
  scope_id VARCHAR(255) NOT NULL, -- literal 'personal' or organization ID
  consent_purpose VARCHAR(100) NOT NULL,
  consent_basis VARCHAR(50) NOT NULL,
  consent_version VARCHAR(50) NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  suppressed_at TIMESTAMPTZ,
  preference_rank INTEGER,
  next_contact_after TIMESTAMPTZ,
  thread_channel_id VARCHAR(255),
  thread_root_id VARCHAR(255),
  FOREIGN KEY (binding_id, identity_id)
    REFERENCES identity_bindings(id, identity_id),
  CHECK (
    (scope_kind = 'personal' AND scope_id = 'personal')
    OR (scope_kind = 'organization' AND scope_id <> 'personal')
  ),
  PRIMARY KEY (identity_id, binding_id, provider_tenant_key,
               surface, scope_kind, scope_id, consent_purpose)
);
```

An organization-scoped delivery row is valid only while `scope_id` matches the
explicit organization in the resolved authorization context for that binding.
The composite foreign key prevents a delivery row from pairing one identity
with another identity's binding.

Slack has one continuing DM thread per active Slack binding/installation, not
one thread per identity globally. A relationship-level
`globally_suppressed=true` is an additional global stop; purpose-, channel-, or
address-specific opt-outs live on delivery/consent records and must not be
promoted to a global suppression accidentally.

`globally_suppressed` is a cached projection over append-only suppression
records, not an unaudited toggle. The source record retains actor, effective
time, reason, scope, evidence, and later revocation; contact eligibility uses
the active source record and can rebuild the projection.

### Linking threads to relationships

Converge thread ownership on `identity_id`:

```sql
ALTER TABLE addie_threads
  ADD COLUMN identity_id UUID REFERENCES identities(id),
  ADD COLUMN origin_binding_id UUID REFERENCES identity_bindings(id),
  ADD COLUMN surface_tenant_key VARCHAR(255),
  ADD COLUMN organization_id VARCHAR(255),
  ADD COLUMN consent_purpose VARCHAR(100),
  ADD COLUMN consent_basis VARCHAR(50),
  ADD COLUMN consent_version VARCHAR(50),
  ADD COLUMN visibility_classification VARCHAR(50);

CREATE INDEX idx_addie_threads_identity ON addie_threads(identity_id)
  WHERE identity_id IS NOT NULL;
```

Thread participants are represented explicitly where a thread can contain more
than the person and Addie. `origin_binding_id`, surface tenant, organization,
consent, participants, and visibility are immutable provenance: identity merge
may change the projection owner but never overwrites the origin fields.

When creating or looking up a thread, resolve the identity first and record the
source binding, surface tenant, organization context, participants, consent,
and visibility classification. Subsequent context loading uses `identity_id`
plus the privacy fence; `identity_id` alone is not a cross-surface disclosure
grant. A thread without typed provenance is quarantined from cross-surface
context until reconciled.

Cross-surface and cross-organization reuse is default-deny and represented by
an explicit, revocable grant:

```sql
CREATE TABLE relationship_context_grants (
  id UUID PRIMARY KEY,
  identity_id UUID NOT NULL REFERENCES identities(id),
  source_binding_id UUID REFERENCES identity_bindings(id),
  source_surface VARCHAR(50) NOT NULL,
  source_tenant_key VARCHAR(255) NOT NULL,
  source_organization_id VARCHAR(255),
  destination_surface VARCHAR(50) NOT NULL,
  destination_tenant_key VARCHAR(255) NOT NULL,
  destination_organization_id VARCHAR(255),
  grant_type VARCHAR(50) NOT NULL,
  purpose VARCHAR(100) NOT NULL,
  subject_authorized_by_binding_id UUID REFERENCES identity_bindings(id),
  subject_authorized_by_policy VARCHAR(100),
  source_organization_grant_id VARCHAR(255),
  approved_data_classes VARCHAR(100)[] NOT NULL,
  consent_basis VARCHAR(50) NOT NULL,
  consent_version VARCHAR(50) NOT NULL,
  evidence_hash VARCHAR(255) NOT NULL,
  operation_id UUID NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by VARCHAR(255),
  revocation_reason VARCHAR(255),
  CHECK (
    num_nonnulls(subject_authorized_by_binding_id,
                 subject_authorized_by_policy) = 1
  ),
  CHECK (
    source_organization_id IS NULL
    OR source_organization_grant_id IS NOT NULL
  ),
  CHECK (cardinality(approved_data_classes) > 0)
);
```

Identity equality alone never authorizes reuse. Raw content, derived summaries,
insights, embeddings, and scores inherit the most restrictive fence of their
sources. Revocation immediately excludes raw and derived context from future
retrieval and queues affected projections/embeddings for deletion or
recomputation. Organization-confidential content has no implicit path into a
different organization's or personal context. Retrieval rejects expired or
revoked grants. Grants never follow a canonical identity or split
automatically: the operation records an explicit binding-level disposition,
and ambiguous grants fail closed pending new authorization. A person's consent
cannot export organization-confidential material by itself: cross-organization
reuse also requires an active source-organization authority grant covering the
approved data classes. These grants remain disabled until the privacy-fence
decision in #6491 defines both authorities and their revocation semantics.

## Context loading

When Addie talks to someone on any surface, she first resolves the request
authorization tuple and privacy fence, then loads only the allowed context:

### 1. Relationship record (fast, single row)
```
person_relationships WHERE identity_id = :identity_id
```
Gives: stage, last interaction, sentiment trend, global suppression, and
interaction count. Destination preference, consent, and cooldown come only
from the selected delivery-state record.

### 2. Recent conversation summary (bounded)
```
addie_thread_messages
  JOIN addie_threads ON identity_id = :identity_id
  WHERE privacy_fence_allows(thread, :request_context)
  ORDER BY created_at DESC
  LIMIT 30
```
The last ~30 messages from permitted sources. Not the full history -- just
enough for Addie to maintain allowed conversational continuity. Every summary
keeps source/surface attribution; raw content from an unrelated organization
or unacknowledged linked identity is excluded.

For the Slack DM surface specifically, Addie also has the native Slack thread history (users can scroll up). The database history supplements this only with cross-surface context permitted for Slack.

### 3. Person profile (existing data, assembled)
- Insights from `member_user_insights`
- Capability grants from `getMemberCapabilities()`, each with its global,
  personal-subscription, or selected-organization source
- Selected-organization info only from the explicit request context
- Goal history from `user_goal_history` (legacy, read-only during migration)

### 4. Community context (what's happening now)
- Upcoming events relevant to their location or groups
- Recent activity in their working groups
- New members from similar companies
- Announcements or deadlines

This is not loaded per-message. It's loaded when Addie is deciding whether and how to proactively reach out (see next section).

### Context loading function

```typescript
interface RelationshipContext {
  relationship: PersonRelationship;
  recentMessages: ThreadMessage[];      // last 30 permitted by the fence
  profile: {
    insights: Insight[];
    capabilities: CapabilityGrant[];
    selectedOrganization?: OrganizationInfo;
  };
  community?: {                         // only for proactive outreach decisions
    upcomingEvents: Event[];
    groupActivity: GroupUpdate[];
    relevantAnnouncements: string[];
  };
}

type AuthorizedRelationshipContext = {
  actor:
    | { kind: 'person'; authenticatedCredentialId: string }
    | { kind: 'system'; jobName: string };
  identityId: string;                 // derived server-side, never request data
  authorizationVersion: number;
  purpose: string;
  destinationBindingId?: string;
  surface: 'slack' | 'web' | 'email' | 'a2a';
  selectedOrganization?: {
    id: string;
    authorization:
      | { kind: 'person_membership'; membershipId: string }
      | { kind: 'system_grant'; grantId: string };
  };
};

async function resolveAuthorizedRelationshipContext(input: {
  authenticatedPrincipal: AuthenticatedPrincipal | SystemPrincipal;
  requestedOrganizationId?: string;
  purpose: string;
  destinationBindingId?: string;
  surface: 'slack' | 'web' | 'email' | 'a2a';
}): Promise<AuthorizedRelationshipContext>

async function loadRelationshipContext(
  context: AuthorizedRelationshipContext,
  options?: { includeCommunity?: boolean }
): Promise<RelationshipContext>
```

`identityId` is never accepted from request parameters, tool arguments, or
other client data. The resolver derives it from the authenticated active
binding. A requested organization is validated against an active, unrevoked
membership for that authenticated principal; unauthorized selection returns
403 and never falls back to a primary, first, or arbitrary organization. Every
organization query and tool authorization consumes the same resolved
membership context and independently rechecks it before mutation.

The context formatter renders facts with source labels. Response policy lives
in Addie's rules, not in hydrated person data. New fields must be added to both
the hydration path and prompt formatting so the two data planes do not drift.

Source labels are not an instruction boundary. Fixed, code-deployed policy and
trusted authorization facts are the only relationship data allowed in a
system-role block. Historical messages, profile text, insights, summaries,
community content, and external tool data are untrusted content and remain in
user-role/tool-role data structures with explicit delimiters and size limits;
they are never interpolated into system instructions. Channel, recipient,
organization, and tool authorization are fixed and rechecked by code, not
selected from model output.

Regression tests cover stored closing delimiters, embedded instructions/tool
requests, cross-surface injection, and attempts to make Org A content trigger
tools or disclosure in Org B.

Proactive jobs have no person-authenticated credential. They must name their
system actor, purpose, and destination binding; organization-scoped context is
unavailable unless the job has an explicit authorized organization scope. An
absent or ambiguous organization context fails closed rather than selecting a
"primary" organization implicitly.

## Proactive engagement model

### What replaces the goal/planner system

The current system: Scheduler runs -> picks candidates -> OutboundPlanner picks a goal -> sends a template.

The new system: Scheduler runs -> picks candidates -> loads privacy-fenced relationship context -> Sonnet composes a message appropriate for this person at this moment.

The key shift: **goals become suggestions, not the organizing primitive.** Addie still knows about available actions (link account, join working group, complete profile, attend event). But she doesn't "pick a goal and execute it." She looks at the permitted relationship context and decides what to say, which might touch on one of these topics, or might just be a genuine check-in.

### The engagement planner

Replace `OutboundPlanner` with a simpler decision flow:

**Step 1: Should Addie reach out to this person right now?**

Rule-based check (fast, no LLM):
- `globally_suppressed = true` -> no
- No active, verified, consented destination for this purpose/context -> no
- Destination is purpose/channel/address suppressed -> no
- `next_contact_after > NOW()` -> no
- Stage is `prospect`, no welcome was sent, and an active destination has
  purpose/channel-specific consent -> eligible for welcome
- `last_addie_message_at` within cooldown period for their stage -> no
- Not business hours in their timezone -> no

Cooldown periods by stage:
- `prospect`: 0 (welcome immediately when discovered)
- `welcomed`: 3 days (give them time to respond before following up)
- `exploring`: 7 days
- `participating`: 14 days (they're engaged, don't nag)
- `contributing`/`leading`: 30 days (only reach out when there's something specific)

**Step 2: What should Addie say?**

This is where the LLM comes in. Pass Sonnet the privacy-fenced relationship context and ask it to compose an appropriate message.

The prompt includes:
- The person's relationship record (stage, history, sentiment)
- Their last ~10 messages with Addie permitted in the current surface/organization context
- Their capabilities (what they have and haven't done)
- Available actions they could take (the old "goals" reframed as options)
- Community context (upcoming events, group activity)
- Tone guidance based on stage

Sonnet decides what to say. It might:
- Welcome a new person and ask what brought them here
- Follow up on something they mentioned last time
- Suggest a working group relevant to their interests
- Share an upcoming event in their city
- Congratulate them on completing their profile
- Simply check in because it's been a while

The message is composed in full by Sonnet. No templates. Every message is personal.

**Step 3: Which channel?**

Select only from active, verified delivery bindings whose consent purpose,
surface tenant, organization context, and suppression state allow this message.
Within that set, use the binding's scoped preference rank. If no eligible
destination exists, skip and record the reason; never fall back to an
unverified address or a binding from another organization context.

**Step 4: Send and record**

Send the message on the chosen channel. Record it as a thread message linked to
the `identity_id` with its binding, surface, consent, and organization
provenance. Update `last_addie_message_at` on the relationship and
`next_contact_after` on the selected delivery-state record based on stage
cooldown.

### What happens to goals?

Goals don't disappear overnight. During migration, the existing goal system continues to function. Goals become a reference list of "things Addie can suggest" rather than the driving force of outreach. The `outreach_goals` table stays but is consumed differently:

- Goals inform the Sonnet prompt: "Here are actions this person could take: [list of eligible goals]"
- Goal history is still tracked for purpose-limited support visibility
- The goal-based admin UI keeps working

Over time, goals can be simplified into a checklist of capabilities (which `MemberCapabilities` already is).

## Single thread model

### Slack: one DM thread per binding/installation

When Addie first messages one Slack binding/installation, she opens a DM and
sends a message. That message's `thread_ts` becomes the continuing thread for
that destination. A second Slack workspace or installation has separate thread
coordinates and consent state. The person can respond at any time, and the
conversation continues within that source context.

Technical details:
- `relationship_delivery_state.thread_channel_id` and `thread_root_id` store coordinates for the binding/installation
- On first outreach: open DM channel, send message, save both IDs
- On subsequent outreach: send as reply using saved `thread_ts`
- If the Slack API rejects the `thread_ts` (channel deleted, etc.), start a new thread and update the record

This means a person's DM with Addie reads like one long conversation over time. Early messages are the welcome. Later messages are about working groups, events, profile help. The context is always there when you scroll up.

**What about when people message Addie first?** If someone opens a DM with Addie (or uses the Slack assistant), check for an existing relationship + thread. If found, continue in the same thread. If not, create the relationship and start the thread.

### Email: thread-like continuity

Email doesn't have persistent threads, but we can create the feeling of continuity:
- Same sender address (`addie@updates.agenticadvertising.org`)
- Subject lines that reference previous conversations ("Following up on..." or just a fresh topic)
- Email body may reference a prior discussion only when the privacy fence permits that source on email
- Reply-to chaining when possible (use `In-Reply-To` and `References` headers with previous `Message-ID`)

Email consent, cooldown, preference, and message coordinates live on the
selected destination's delivery-state record. Only aggregate
`last_addie_message_at` is person-level across channels.

### Web chat: load the relationship

When someone opens web chat, resolve their authenticated credential to an
identity (or treat the session as anonymous). If they have a relationship
record, load the last N messages permitted for the web and selected-organization
context. Addie picks up only from that allowed context.

For anonymous users (not logged in), there's no relationship to load. That's
fine -- web chat works as a standalone Q&A, same as today. If they later
identify themselves, attaching anonymous history requires an explicit account
action and applicable consent; it is not an automatic fuzzy merge.

## Cross-surface identity

### How we resolve and link a person across surfaces

Resolution and linking are different operations:

- **Resolution** looks up one already-bound external identifier and returns its
  `identity_id`. It does not mutate bindings.
- **Linking** joins two credentials/identifiers only after proof of control.
  The restricted emergency recovery workflow above may prepare a pending
  binding, but the subject must confirm it before activation. The operation
  records evidence and applies the ownership rules above.
- **Suggestion** may surface a possible duplicate to an administrator. It may
  use name, domain, or email similarity, but it never mutates identity state.

Surface-specific rules:

1. **Slack user discovered** -- Create a provisional singleton identity plus a
   sourced Slack delivery binding when none exists. It cannot authenticate
   until a verified authentication binding is activated. Email or
   employer-domain similarity may suggest a link but cannot execute one.
2. **Slack account linking** -- The authenticated web credential and Slack
   identity must both participate in the verified linking flow.
3. **Email prospect created** -- Create a provisional singleton
   identity/relationship with sourced contact information and no authentication
   authority. Later signup does not auto-link solely because the email or
   domain matches.
4. **Web session authenticated** -- Resolve the WorkOS user through
   `identity_workos_users`. A new WorkOS user receives a singleton identity.
5. **Existing accounts linked** -- Require control of both credentials. A
   guarded operator workflow may supervise, review evidence, resolve
   dispositions, or prepare a pending merge, but cannot waive subject
   confirmation or activate a binding.

### Resolution function

```typescript
async function resolveIdentity(input: {
  provider: 'workos' | 'slack' | 'verified_email';
  providerTenantKey: string; // real tenant for Slack; canonical 'global' otherwise
  externalId: string;
}): Promise<{ identityId: string; bindingId: string }>
```

This function:
1. normalizes only according to the provider's identifier rules;
2. finds a verified, active, uniquely constrained binding;
3. returns the bound identity without adding other identifiers; or
4. creates a provisional singleton identity and pending or sourced delivery
   binding only when the caller is an authorized provisioning path.

This return value is correlation, not authentication. An authentication
resolver additionally validates the provider session and requires an active
binding whose kind includes authentication; a pending or delivery-only binding
can never establish a principal.

The separate `linkIdentities`/`splitIdentity` operations require their own
authorization, evidence, preview, audit, and cache invalidation. Generic
request resolution must never perform a merge as a side effect.

## Migration path

This is a big change. It needs to happen incrementally, with the existing system continuing to work at each step.

### Current implementation status

The original relationship migration and the later credential-identity
foundation landed in different sequences:

- `person_relationships` exists with transitional singular Slack/WorkOS/email
  columns.
- `identities` and `identity_workos_users` exist and auth resolves a linked
  non-primary WorkOS credential through the identity's primary credential.
- Admin bind, link, unlink, and primary-promotion flows exist.
- Most person-owned application state still uses the primary
  `workos_user_id`; the auth ID swap is a compatibility layer, not the target
  ownership model.
- The current `mergeUsers` path rewrites/deduplicates organization and
  working-group memberships, learner/certification state, points, badges,
  threads, events, and other rows onto the primary WorkOS user. Primary
  promotion and existing-account linking invoke that destructive path.
- Current unlink creates an empty singleton identity; it cannot reconstruct
  state that merge moved or deleted. The OAuth alias path may also create
  upstream WorkOS memberships before local consolidation and leave them behind
  if the local operation fails.

Those last three behaviors are explicitly non-conformant with the target
ownership and reversibility contract. They are rollout blockers, not evidence
that authorization isolation or split support already exists. Credential
binding must be separated from state consolidation; destructive consolidate,
promote, and automatic alias paths remain disabled until their replacements
preserve authority and provenance. Any upstream
WorkOS mutation has a compensating rollback when the local transaction fails.

The next migration sequence is therefore:

1. approve this ownership/provenance contract and the cross-surface privacy fence;
2. isolate organization authorization to the authenticated credential plus an
   explicit active membership, removing canonical-user grant union;
3. land the minimum immutable identity-operation ledger, source-attribution
   substrate, and authorization/session epoch; disable any consolidation that
   cannot preserve partition provenance;
4. add safe self-service attachment of a new, state-empty recovery credential;
   already-bound account consolidation remains disabled until the new
   ledger-backed, provenance-preserving merge path is available;
5. migrate community profile state, then reputation events/aggregates, to
   `identity_id` while retaining origin bindings;
6. complete split preview/operator UX and round-trip restoration before
   removing compatibility fields; and
7. move MemberContext and relationship/thread reads onto the fenced identity model.

### Migration safety contract

Each dataset follows the same expand-and-contract sequence:

1. **Expand** -- add nullable identity/origin keys and provenance tables without
   changing read behavior; add foreign keys as `NOT VALID` where needed.
2. **Transactional dual-write** -- write legacy and target forms in one
   transaction or through a durable outbox with operation IDs. Declare target
   read precedence and rollback behavior.
3. **Snapshot plus delta backfill** -- record a high-water mark, backfill in
   bounded batches, replay concurrent deltas, and quarantine ambiguous rows
   rather than guessing.
4. **Shadow read/reconciliation** -- compare legacy and target results with
   lag/backlog/error alerts and per-operation audit correlation.
5. **Constrained cutover** -- enable target reads only after all dataset gates
   pass; retain a tested rollback to legacy reads.
6. **Validate and retire** -- validate foreign keys, stop legacy writes, then
   remove compatibility fields only after the observation window.

Minimum cutover gates:

- zero active external subjects bound to multiple identities;
- zero authentication-enabled active identities with zero or multiple verified
  primary authentication bindings; provisional identities have zero;
- 100% agreement between legacy/target keys on new dual-writes;
- zero unquarantined rows missing `identity_id` or required origin binding;
- unchanged membership row IDs, roles, seats, grantors, effective dates, and
  provider membership provenance across identity-operation tests;
- exact source-event counts and point sums before/after, with shadow-derived
  totals equal;
- unchanged certification attempt/issuance counts by immutable origin;
- zero cross-surface context reads from rows lacking typed fence provenance;
- successful merge/split canaries that restore assignments and aggregates; and
- reconciliation lag/backlog within the declared SLO with no unresolved
  operation errors.

The non-normative legacy rollout narrative below describes the earlier
relationship-driven outreach plan. It is context, not an assertion that every
step landed and not executable instructions for the identity migration.
Where they refer to the transitional `person_relationships.id`, new work uses
the canonical `identity_id` seam defined above.

### Stage 1: Create the relationship table and backfill

**Goal**: Every Slack user and email prospect gets a `person_relationships` row.

1. Create the `person_relationships` table (migration)
2. Backfill from `slack_user_mappings`: one row per Slack user, copying `slack_user_id`, `workos_user_id`, `display_name`
3. Backfill from `organizations` where `prospect_owner = 'addie'` and `prospect_contact_email IS NOT NULL`: one row per email prospect
4. Calculate initial `stage` from existing data:
   - Has `user_goal_history` with status `sent`? -> `welcomed`
   - Has `workos_user_id` linked? -> `exploring`
   - In working groups? -> `participating`
   - Committee leader? -> `leading`
   - Otherwise -> `prospect`
5. Link existing `addie_threads` and `person_events` to `identity_id` where
   evidence permits, retaining the transitional `person_relationships.id` and
   immutable source provenance until reconciliation/cutover completes

The old system still runs. Goals still fire. The relationship table is read-only at this stage.

**Reuse**: All existing tables stay. `person_relationships` is additive.

### Stage 2: Continuing thread model for Slack DMs

**Goal**: Stop creating new threads per outreach. One continuing thread per Slack binding/installation.

1. Modify `resolveThreadAndSendMessage` to check the destination-scoped `relationship_delivery_state.thread_root_id` first
2. If a permanent thread exists, always reply there (remove the 7-day window logic)
3. If no permanent thread exists for that binding/installation, send a new message and save the `thread_ts` to its delivery-state record
4. When someone DMs Addie, resolve their binding and use only that destination's continuing thread

**Reuse**: `openDmChannel` and `sendDmMessage` stay. Only the thread resolution logic changes.

### Stage 3: Relationship context in conversations

**Goal**: When Addie talks to someone (reactive or proactive), she loads the relationship context permitted for that request.

1. Implement `loadRelationshipContext()`
2. Pass privacy-fenced relationship context (stage, permitted recent messages,
   capabilities) as untrusted structured user/tool data; keep fixed policy and
   trusted authorization facts in the system prompt
3. Web chat loads relationship context for authenticated users
4. Proactive outreach loads relationship context before composing messages

**Reuse**: `getMemberCapabilities()`, insights queries, thread message queries all stay. We're composing them into a unified context object.

### Stage 4: Relationship-driven proactive outreach

**Goal**: Replace goal-based planning with relationship-based engagement.

1. Implement the engagement planner (should-contact + compose-message flow)
2. Replace `initiateOutreachWithPlanner` with new `engageWithPerson` function
3. Proactive messages go through Sonnet with privacy-fenced relationship context
4. Record proactive messages as thread messages linked to `identity_id` with source provenance
5. Keep recording goal history in parallel for purpose-limited support visibility (dual-write)

**Reuse**: Business hours check, rate limiting, email sending, Slack DM sending all stay. Only the decision logic changes.

### Stage 5: Deprecate goal-driven outreach

**Goal**: Remove the old planner once the relationship model is proven.

1. Stop dual-writing to `user_goal_history`
2. Convert the admin outreach dashboard to show relationship-based data
3. Remove `OutboundPlanner` class
4. Archive `outreach_goals` and `goal_outcomes` tables (don't delete -- useful for analysis)

**Reuse**: The admin UI layout and routes can be adapted. The rehearsal system can be rebuilt on top of relationships if needed.

## What we can reuse vs rebuild

### Keep as-is
- `isBusinessHours()` and timezone logic
- `openDmChannel()` and `sendDmMessage()` (low-level Slack API wrappers)
- Email sending infrastructure (`sendProspectEmail`, Resend integration)
- Rate limiting and kill switches

### Modify
- `addie_threads` and `addie_thread_messages` -- add typed immutable binding,
  tenant, organization, consent, participant, and visibility provenance
- `getMemberCapabilities()` -- return subject-discriminated, source-attributed
  grants for the resolved authorization context
- `InsightsDatabase` -- retain source fences on raw and derived insights
- `canContactUser()` -- evaluate destination-, purpose-, tenant-, scope-, and
  consent-specific delivery state
- `resolveThreadAndSendMessage()` -- use permanent thread from relationship
- `buildPlannerContext()` -- becomes `loadRelationshipContext()`
- `runOutreachScheduler()` -- queries relationships instead of raw slack_user_mappings
- Thread service `getUserRecentThread()` -- replaced by relationship-based lookup

The fenced replacements above are cutover prerequisites, not optional cleanup.

### Rebuild
- `OutboundPlanner` -- replaced by relationship-aware engagement planner
- Goal selection logic -- replaced by Sonnet composing messages from context
- Template-based message building -- replaced by LLM composition

### Archive (keep data, stop writing)
- `outreach_goals` table (goals become suggestions in the prompt, not database-driven)
- `goal_outcomes` table
- `user_goal_history` table (eventually -- dual-write during migration)
- `rehearsal_sessions` table

## Success criteria

- [ ] Every Slack user and email prospect has a `person_relationships` row
- [ ] Addie maintains one DM thread per active Slack binding/installation (no cross-workspace thread reuse)
- [ ] When someone messages Addie on web chat, she can use an attributed Slack summary only when the privacy fence permits it
- [ ] Proactive messages may reference permitted prior context when relevant
- [ ] Welcome messages only happen once per person, ever
- [ ] Stage transitions happen automatically based on behavior
- [ ] Outreach frequency scales with engagement (active people get less proactive contact, not more)
- [ ] Every proactive message is composed by Sonnet, not a template
- [ ] An authorized support/privacy administrator can see only timeline data allowed for the stated support purpose; cross-organization or otherwise fenced content requires an elevated role, recorded reason, and audited break-glass access

## What this does NOT include

- **Video chat integration.** The relationship model supports it (video is a channel type), but we're not building the video surface now.
- **Multi-person threads.** Relationships are 1:1 (Addie to person). Group conversations stay separate.
- **Automated A/B testing of messages.** Sonnet composes each message individually. If we want to test approaches, we adjust the prompt, not run experiments.
- **Real-time presence awareness.** We don't check if someone is online before messaging. Business hours are sufficient.
- **CRM-style pipeline management.** Relationships are not deals. There's no "close" action. The journey is open-ended.
