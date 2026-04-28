-- Add A2B: Testing Your First Agent — hands-on lab supplement to A2.
-- A2B sits between A2 (sort_order=2) and A3. We bump A3's sort_order from 3→4
-- and assign A2B sort_order=3 so track-A ordering is preserved.

UPDATE certification_modules SET sort_order = 4 WHERE id = 'A3';

INSERT INTO certification_modules (
  id, track_id, title, description, format, duration_minutes,
  sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria
) VALUES (
  'A2B',
  'A',
  'Testing your first agent call',
  'Hands-on lab: initialize an MCP session against the AdCP test agent, call get_products with a brief, place a media buy with create_media_buy, attach creatives with sync_creatives, and resolve common errors — auth failures, schema mismatches, and async polling.',
  'interactive',
  20,
  3,
  true,
  '{A2}',
  '{
    "objectives": [
      "Initialize a stateful MCP session and capture the mcp-session-id header",
      "Call get_products with buying_mode brief and read proposals from the response",
      "Call create_media_buy and distinguish the three possible response shapes",
      "Attach creatives with sync_creatives using dry_run validation first",
      "Poll get_media_buys to track lifecycle state and valid_actions",
      "Diagnose and resolve auth failures, schema mismatches, and async polling delays"
    ],
    "key_concepts": [
      {
        "topic": "MCP session lifecycle",
        "explanation": "Every sequence starts with an initialize call. The response provides an mcp-session-id header that routes subsequent calls to the same session context on the server. Without it, each call is stateless and context is lost between steps.",
        "teaching_notes": "Have the learner capture the session ID themselves and show that omitting it causes an error. This builds the habit of treating the session as stateful infrastructure."
      },
      {
        "topic": "get_products and proposals",
        "explanation": "buying_mode: brief lets the seller curate product recommendations from a plain-English campaign description. The response includes products[] (inventory items) and proposals[] (pre-packaged allocation plans with proposal_id). The proposal_id is the shortcut to create_media_buy — it lets the buyer skip manual package construction.",
        "teaching_notes": "Point out that proposals[] are seller-curated, not invented by the buyer. The seller has already applied brand safety, frequency caps, and pricing. This is the concierge model vs. the wholesale model."
      },
      {
        "topic": "create_media_buy response shapes",
        "explanation": "create_media_buy has three mutually exclusive responses: (1) synchronous success with media_buy_id and status (pending_creatives, pending_start, or active); (2) async submission with status: submitted and a task_id to poll; (3) rejection with errors[] and no media_buy_id. Learners must handle all three — the test agent will return each depending on the scenario.",
        "teaching_notes": "The most common learner confusion is expecting media_buy_id in the submitted shape. Walk through the submitted response body explicitly and show the task_id polling loop."
      },
      {
        "topic": "idempotency_key discipline",
        "explanation": "Every mutating call (create_media_buy, sync_creatives) requires a unique idempotency_key. If a call fails mid-flight and you retry with the same key, the seller returns the existing result instead of creating a duplicate. If you retry after fixing a schema error, use a new key — reusing the old key returns the original error response.",
        "teaching_notes": "The pattern UUID-per-request is correct. Show the failure mode: retrying a schema-error response with the same key returns the same error even after fixing the payload."
      },
      {
        "topic": "Async polling with tasks/get",
        "explanation": "When create_media_buy returns status: submitted, the buy is queued for processing (IO signing, governance review, or batch scheduling). Poll tasks/get with the task_id every 2-5 seconds. When task.status is completed, read media_buy_id off the artifact. If task.status is failed, read task.message for the rejection reason.",
        "teaching_notes": "This is the most common place learners get stuck. They call create_media_buy, see submitted, and assume the buy failed. Explicitly running the polling loop and watching status move from submitted → working → completed builds the muscle memory."
      }
    ],
    "discussion_prompts": [
      "Why does create_media_buy use an idempotency_key but get_products does not?",
      "You call create_media_buy and get back status: submitted with a task_id. Ten seconds later tasks/get still shows working. What do you do and when do you escalate?",
      "A sync_creatives call returns creatives[0].status: pending_review. The media buy is still in pending_creatives state. Is this expected? What is the seller doing?",
      "You retry a failed create_media_buy with the same idempotency_key after fixing the schema error. What response will you get and why?"
    ],
    "demo_scenarios": [
      {
        "description": "Initialize a session and discover products with a brief",
        "tools": ["initialize", "get_products"],
        "expected_outcome": "Session established with mcp-session-id. Product catalog returned with at least one proposal and proposal_id visible in the response."
      },
      {
        "description": "Place a media buy using a proposal and observe the response shape",
        "tools": ["create_media_buy"],
        "expected_outcome": "Response contains media_buy_id with status pending_creatives, or status submitted with task_id if async path is taken."
      },
      {
        "description": "Validate creatives with dry_run, then apply sync_creatives",
        "tools": ["sync_creatives"],
        "expected_outcome": "dry_run response shows what would be created. Apply call returns creatives with status approved or pending_review."
      },
      {
        "description": "Poll get_media_buys to observe lifecycle state transitions",
        "tools": ["get_media_buys"],
        "expected_outcome": "Buy status progresses from pending_creatives to pending_start. valid_actions shows available transitions."
      }
    ]
  }',
  '[
    {
      "id": "a2b_ex1",
      "title": "Session initialization and product discovery",
      "description": "Initialize an MCP session against the test agent and call get_products with a brief. Examine the proposals array and identify the proposal_id you will use in the next exercise.",
      "sandbox_actions": [
        {
          "tool": "initialize",
          "guidance": "Call initialize against the test agent. Confirm you receive an mcp-session-id in the response headers and include it in all subsequent calls."
        },
        {
          "tool": "get_products",
          "guidance": "Call get_products with buying_mode: brief and a campaign description. Find proposals[0].proposal_id in the response."
        }
      ],
      "success_criteria": [
        "Successfully initializes a session and captures the mcp-session-id",
        "Calls get_products with buying_mode: brief and a non-empty brief string",
        "Correctly identifies proposal_id in the response"
      ]
    },
    {
      "id": "a2b_ex2",
      "title": "Place a media buy and handle response shapes",
      "description": "Call create_media_buy using the proposal_id from Exercise 1. Identify which response shape you received and describe what you would do next for each of the three possible shapes.",
      "sandbox_actions": [
        {
          "tool": "create_media_buy",
          "guidance": "Call create_media_buy with idempotency_key, account, proposal_id, and total_budget. Examine the response: does it have media_buy_id (synchronous), task_id (async), or errors[] (rejection)?"
        }
      ],
      "success_criteria": [
        "Calls create_media_buy with a valid idempotency_key, account, and proposal_id",
        "Correctly identifies which of the three response shapes was returned",
        "Describes the correct next step for each response shape"
      ]
    },
    {
      "id": "a2b_ex3",
      "title": "Attach creatives and poll buy status",
      "description": "Validate a creative with sync_creatives dry_run, then apply it. Poll get_media_buys to confirm the buy moved out of pending_creatives state.",
      "sandbox_actions": [
        {
          "tool": "sync_creatives",
          "guidance": "Call sync_creatives with dry_run: true first. Confirm no errors, then re-call with dry_run removed to apply the creative."
        },
        {
          "tool": "get_media_buys",
          "guidance": "Call get_media_buys with the media_buy_id. Check status and valid_actions."
        }
      ],
      "success_criteria": [
        "Uses dry_run: true before applying sync_creatives",
        "Successfully applies creatives and reads the creatives[].status field",
        "Polls get_media_buys and correctly interprets the status and valid_actions fields"
      ]
    },
    {
      "id": "a2b_ex4",
      "title": "Diagnose and resolve common errors",
      "description": "Given three error scenarios — auth failure, schema mismatch, and async timeout — describe the exact diagnostic step and resolution for each.",
      "sandbox_actions": [],
      "success_criteria": [
        "Correctly identifies invalid_token vs invalid_request auth errors and the fix for each",
        "Reads errors[0].field and errors[0].code to diagnose schema mismatches and explains why a new idempotency_key is required on retry",
        "Describes the correct polling interval and escalation path for a stalled async task"
      ]
    }
  ]',
  '{
    "dimensions": [
      {
        "name": "conceptual_understanding",
        "weight": 10,
        "description": "Understands the MCP session lifecycle and why statefulness matters",
        "scoring_guide": {
          "high": "Accurately describes initialize, mcp-session-id, and why omitting the header breaks subsequent calls",
          "medium": "Understands sessions are stateful but cannot explain the header mechanism",
          "low": "Treats each call as independent; cannot explain what the session ID does"
        }
      },
      {
        "name": "practical_knowledge",
        "weight": 40,
        "description": "Can execute the full five-call sequence with correct task names, request shapes, and field values",
        "scoring_guide": {
          "high": "Correctly names all five tasks, uses buying_mode and idempotency_key correctly, and reads response fields accurately",
          "medium": "Completes most steps correctly; minor errors in field names or response interpretation",
          "low": "Cannot construct valid requests or misreads response shapes"
        }
      },
      {
        "name": "problem_solving",
        "weight": 30,
        "description": "Can reason about what happens when each step fails or returns an unexpected response",
        "scoring_guide": {
          "high": "Correctly traces all three create_media_buy response shapes and knows the next action for each",
          "medium": "Handles the synchronous success path but struggles with submitted or errors[] shapes",
          "low": "Cannot distinguish response shapes or reason about failure modes"
        }
      },
      {
        "name": "error_recovery",
        "weight": 20,
        "description": "Can diagnose and resolve auth failures, schema mismatches, and async polling delays",
        "scoring_guide": {
          "high": "Correctly identifies invalid_token vs invalid_request, reads errors[0].field/code, and knows to use a new idempotency_key on schema-error retry",
          "medium": "Identifies error types but misses the idempotency_key retry rule or the polling escalation path",
          "low": "Cannot distinguish error types or describe the correct resolution for any of the three"
        }
      }
    ],
    "passing_threshold": 70
  }'
)
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  format = EXCLUDED.format,
  duration_minutes = EXCLUDED.duration_minutes,
  sort_order = EXCLUDED.sort_order,
  is_free = EXCLUDED.is_free,
  prerequisites = EXCLUDED.prerequisites,
  lesson_plan = EXCLUDED.lesson_plan,
  exercise_definitions = EXCLUDED.exercise_definitions,
  assessment_criteria = EXCLUDED.assessment_criteria;
