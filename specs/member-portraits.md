# Member Portraits

## Problem

Team headshots and cast portraits are hardcoded as static files in
`/server/public/images/cast/`. There is no way for members to get or manage
their own illustrated portrait. The Explore page references these files by
name, which doesn't scale.

## Goal

Every paying member can generate an illustrated portrait in the AAO graphic
novel style. Portraits are stored in the database, served dynamically, and
used across the site — Explore page, member directory, profile cards, and
anywhere Addie references a person.

## Design Principles

- **Opt-in, not mandatory.** Members choose to generate a portrait. No one
  gets a surprise illustration of themselves.
- **Photo reference, not photo storage.** The uploaded headshot is used only
  during generation and deleted immediately after. We never persist the
  original photo.
- **One art style, three palettes.** Amber/gold for real humans, blue for
  AAO cast (stories), teal for protocol cast (docs). Members always get
  amber/gold.
- **Database-first.** Portrait metadata lives in the database. The Explore
  page, member directory, and Addie all read from the same source.

## Data Model

### New table: `member_portraits`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `member_profile_id` | UUID | FK → member_profiles.id, unique |
| `image_url` | TEXT | Served path, e.g. `/api/portraits/{id}.png` |
| `prompt_used` | TEXT | Full prompt sent to Gemini |
| `vibe` | TEXT | User-selected setting (e.g. "at my desk", "on stage") |
| `palette` | TEXT | `amber` (default for members) |
| `status` | TEXT | `pending`, `generated`, `approved`, `rejected` |
| `approved_at` | TIMESTAMPTZ | When user accepted the portrait |
| `created_at` | TIMESTAMPTZ | Default now() |
| `updated_at` | TIMESTAMPTZ | Default now() |

Portrait image bytes are stored in a `portrait_data` BYTEA column (images
are ~500KB each — manageable in Postgres at our scale). If we outgrow this,
we move to R2/S3 later.

**Why BYTEA over cloud storage:** We have no cloud storage infrastructure
today. Adding S3/R2 for ~500KB images that change rarely is premature. Postgres
handles this fine for hundreds of members. The `image_url` abstraction means
we can swap storage later without changing consumers.

### Migration: `member_profiles`

Add column:

| Column | Type | Notes |
|---|---|---|
| `portrait_id` | UUID | FK → member_portraits.id, nullable |

This gives every member profile a single active portrait reference.

### Seed data

Migrate existing static portraits for the founding team (Brian, Randy, Matt,
Ben) into `member_portraits` rows. Update their `member_profiles` to point
at the new records. Remove hardcoded image paths from the Explore page.

## Generation Pipeline

### Prompt Assembly

```
Base style (amber palette, graphic novel aesthetic, circular crop)
+ Vibe setting (user-selected background/context)
+ Photo reference (uploaded headshot, used as composition guide)
+ "Do not include any text, words, labels, or logos in the image."
```

**Vibe options** (initial set):

| Vibe | Background description |
|---|---|
| `at-my-desk` | A workstation with monitors showing dashboards |
| `on-stage` | A podium or stage with soft lighting |
| `in-a-studio` | Production equipment, cameras, lighting rigs |
| `boardroom` | Conference room with whiteboard |
| `casual` | Simple, clean background with warm lighting |

Members can also write a custom vibe as free text.

### Server-side Generation

Move the Gemini generation logic from `scripts/generate-images.ts` into a
server module (`server/src/services/portrait-generator.ts`). The CLI script
continues to work for batch generation but calls the same core function.

```
POST /api/me/portrait/generate
Content-Type: multipart/form-data

Fields:
  photo: <headshot file, JPEG/PNG, max 5MB>
  vibe: "at-my-desk" | "on-stage" | ... | custom string

Response: { id, image_url, status: "generated" }
```

Flow:
1. Validate membership (paid tier required)
2. Accept uploaded photo into memory (not disk)
3. Assemble prompt with amber palette + vibe + photo reference
4. Call Gemini `gemini-3.1-flash-image-preview` with photo as reference image
5. Store generated PNG in `member_portraits` (BYTEA)
6. Delete uploaded photo from memory
7. Set status = `generated`, return preview URL
8. Member reviews and either approves or regenerates

### Serving

```
GET /api/portraits/:id.png
```

Reads BYTEA from `member_portraits`, serves with `Content-Type: image/png`
and aggressive caching headers (`Cache-Control: public, max-age=31536000,
immutable`). Cache-bust via new portrait ID on regeneration.

### Regeneration

Members can regenerate up to 3 times per month. Each generation creates a
new `member_portraits` row. When approved, the `member_profiles.portrait_id`
is updated to point at the new one. Old rows are soft-deleted (kept for
audit but not served).

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/me/portrait/generate` | Member (paid) | Upload photo + vibe, get portrait |
| `POST` | `/api/me/portrait/approve` | Member | Accept current generated portrait |
| `POST` | `/api/me/portrait/regenerate` | Member (paid) | New generation (rate-limited) |
| `DELETE` | `/api/me/portrait` | Member | Remove portrait from profile |
| `GET` | `/api/portraits/:id.png` | Public | Serve portrait image |
| `GET` | `/api/me/portrait` | Member | Get current portrait metadata |

### Admin

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/admin/portraits` | Admin | List all portraits |
| `DELETE` | `/api/admin/portraits/:id` | Admin | Remove inappropriate portrait |

## UI

### Profile Page (`/community/profile/edit`)

Individual members edit their profile at `/community/profile/edit` (not
`/member-profile.html`, which is the company profile page). The portrait
section goes here, alongside the existing avatar URL field.

Add a "Your Portrait" section:

1. **No portrait yet:** "Generate your portrait" CTA. Upload area + vibe
   picker dropdown. Generate button.
2. **Generated, not approved:** Preview of the portrait in a circular frame
   with amber ring. "Use this" / "Try again" / "Change vibe" buttons.
   Shows remaining regenerations this month.
3. **Approved:** Portrait displayed with amber ring. "Regenerate" link
   (subtle). Shows where it appears (directory, Explore page if featured).

### Explore Page (`/stories/index.html`)

Replace hardcoded `<img>` sources with dynamic portrait URLs:

```html
<!-- Before -->
<img src="/images/cast/brian-okelley.png" ...>

<!-- After -->
<img src="/api/portraits/{portrait_id}.png" ...>
```

The Explore page should fetch builder data from the API rather than
being fully static. For cast characters (fictional), portraits remain
static files served from `/images/cast/`.

### Member Directory (`/members.html`)

Member cards that have a portrait show the illustrated version. Those
without show the current initial-based placeholder.

## Privacy & Consent

- **Upload consent:** Before uploading, member sees: "Your photo is used
  only to generate this illustration and is deleted immediately. We do
  not store your original photo."
- **No photo persistence:** The uploaded file exists only in server memory
  during the Gemini API call. It is never written to disk or database.
- **Portrait removal:** Members can delete their portrait at any time.
  This removes it from their profile and the directory.
- **Gemini data usage:** Note in terms that Gemini processes the image
  for generation. Link to Google's API data usage policy.

## Phases

### Phase 1: Database + Seed (now)

- Create `member_portraits` table
- Add `portrait_id` to `member_profiles`
- Seed founding team portraits from existing static files
- Update Explore page to read from database for builders section
- Cast portraits remain static (they're fictional)

### Phase 2: Self-service Generation + Onboarding

- Build `portrait-generator.ts` service module
- Add API endpoints for generate/approve/regenerate
- Add portrait section to member profile page
- Rate limiting (3/month)
- **Portrait step in paid signup flow.** After payment confirmation, before
  the "welcome" screen: "See yourself in the community." Upload a headshot,
  pick a vibe, generate. Skip option available but the moment is powerful —
  you just joined and now you're illustrated alongside the cast.
- **Company memberships include team portraits.** Allocation by tier:
  - Individual Professional: 1 portrait
  - Company Standard: 5 portraits
  - Company Premium: 15 portraits
  - ICL: 25 portraits
  Company admin can invite team members to generate their own.

### Phase 3: Addie Integration + Refinement

- **Addie offers portrait generation conversationally.** After membership
  activation, Addie can say: "Want me to create your portrait? Upload a
  headshot and I'll illustrate you in our graphic novel style." This works
  through the existing Addie chat — no separate UI needed for the basic
  flow.
- Custom vibe free text
- Prompt tweaking via Addie ("make it more serious", "add glasses",
  "put me in a server room instead")
- Batch generation for company admins uploading team photos
- Portrait as Addie conversation context — she can reference your portrait
  when talking about the community ("I see you chose the stage vibe — are
  you a speaker?")

## Cost

Gemini image generation: ~$0.02-0.04 per image. At 3 regenerations per
member per month with 200 members: ~$24/month worst case. Negligible.
Company tier allocations add volume but remain well under $100/month
even at full utilization.
