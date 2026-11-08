---
id: DR-0038
title: A task response is one success schema or one error schema, and the envelope layer defines errors once
class: breaking
status: proposed
date: 2026-11-08
decided_by: pending WG ratification
refs: ["Issue #8811", "PR #8565", "DR-0036", "DR-0009", "DR-0019"]
dissent: none recorded
---

## Decision

A task response is either the task's success schema or its error schema, and
the envelope `status` selects which: `failed` selects the error schema, and the
error schema accepts no other body. The error contract lives once, in the
shared envelope layer. The protocol envelope defines the task-level error list,
`errors[]` at the response root, once
(`core/protocol-envelope.json#/definitions/TaskErrors`), and
`core/task-error.json` states the failure rule once: a failed response carries
at least one entry in `errors[]`. Every task's error schema composes
`core/task-error.json`. A task that distinguishes kinds of error branches on
them inside its error schema, in a `<task>-failed.json` that composes the
shared schema and adds only what is specific to its errors; it doesn't declare
`errors` again, and a task with nothing to add has no failed body of its own.
This is the rule the envelope already states on `adcp_error`: a fatal task
failure SHOULD populate both `adcp_error` and the payload's `errors[]`. A
response with `status: failed` is that fatal failure, so its schema requires
`errors[]`.

**When it applies.** Experimental task responses follow the rule from 3.3,
under the experimental contract: the schema build composes the shared error
schema into their failed branch. Stable task responses follow it from 4.0,
because requiring `errors` on a failed response, and refusing the success body
under `status: failed`, narrows what they accept now, and a minor release
changes a schema only by addition (DR-0036). Until 4.0 a stable task response
accepts exactly what it accepts today. A stable failed body that already
requires the same `errors` composes the shared schema now, because that
changes no verdict. In 4.0 the envelope declares `errors` among its properties
by reference to the same definition, and the per-task copies of it go.

## Rationale

A per-task copy of the error contract drifts. Failed bodies differ in whether
they require `errors`, whether the list may be empty, and where the errors sit,
and a task without a failed body accepts `status: failed` with its success
body. A client then can't find a failure in one place, and a seller can't tell
from the schema what a failed response must carry. One definition of the list
and one failure rule in the envelope layer give every task the same answer, and
a task states only what is specific to its errors.

The envelope's SHOULD already makes `errors[]` the canonical, normative
representation of a fatal failure. Tying `status: failed` to it makes the
schema say what the envelope says.

The split by stability follows from the versioning rules. Experimental
surfaces may change between minor releases with notice; stable ones change only
by addition within a major.

## Implications

- A failed response carries its errors at the response root, never inside a
  success field such as `result`.
- A status whose body is built on the shared error schema is an error response
  too, and the same rule covers it.
- A new task needs no failed body unless it adds kinds of error or fields that
  a failure carries.
- Per-item error lists inside a body (`creatives[].errors`, for example) are a
  different field. This record doesn't cover them.
- A stable failed body whose `errors` differs from the shared definition (an
  empty list allowed, or `errors` not required) keeps its definition until 4.0.
- The 4.0 change is the `failed_task_errors_required_in_4_0` check in the
  AdCP 4.0 compatibility registry.
- This record doesn't change when `adcp_error` is sent.
