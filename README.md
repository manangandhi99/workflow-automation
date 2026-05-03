# Autonomous Task Architect

An agentic workflow engine that transforms natural language goals into autonomous, observable task execution. Users submit a plain-English goal; the system plans steps using an LLM, executes them via mocked integrations, self-corrects on failure, and persists full execution history in PostgreSQL.

## Features

| Feature | Key Files |
|---|---|
| Natural language workflow creation via LLM | [src/planner.ts](src/planner.ts) |
| Vector-based tool retrieval (RAG) | [src/toolIndex.ts](src/toolIndex.ts) |
| Deterministic plan validation | [src/validator.ts](src/validator.ts) |
| Human-in-the-loop clarification | [src/routes/workflows.ts](src/routes/workflows.ts), [src/planner.ts](src/planner.ts) |
| Async sequential execution engine | [src/executor.ts](src/executor.ts) |
| Step output chaining (`$ref`) | [src/stepContext.ts](src/stepContext.ts) |
| LLM critic with in-place recovery | [src/critic.ts](src/critic.ts), [src/executor.ts](src/executor.ts) |
| Mock tool library (Stripe, Slack, Email, CRM) | [src/tools.ts](src/tools.ts) |
| Full workflow & step persistence | [prisma/schema.prisma](prisma/schema.prisma) |
| REST API: create, list, inspect, retry | [src/routes/workflows.ts](src/routes/workflows.ts) |
| Demo CLI with 5 end-to-end scenarios | [scripts/demo.ts](scripts/demo.ts) |

## Tech Stack

- **Backend**: TypeScript, Express.js
- **Database**: PostgreSQL with Prisma ORM
- **AI**: OpenAI API (`gpt-4o-mini`, `text-embedding-3-large`)
- **Validation**: Zod

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Set up the database**
   - Create a PostgreSQL database (Neon.tech, Supabase, or local Postgres).
   - Copy `.env.example` to `.env` and fill in `DATABASE_URL` and `OPENAI_API_KEY`.
   - Run migrations:
     ```bash
     npm run db:migrate
     ```

3. **Run the development server**
   ```bash
   npm run dev
   ```

   The server starts on `http://localhost:3000`.

4. **Run the demo CLI**
   ```bash
   npm run demo          # all 5 scenarios
   npm run demo -- 3     # single scenario (1–5)
   ```

## Demo Scenarios

The [scripts/demo.ts](scripts/demo.ts) CLI drives five end-to-end scenarios against the live server:

| # | Scenario | What it demonstrates |
|---|---|---|
| 1 | Happy path | Basic plan → execute → COMPLETED |
| 2 | Step chaining | `$ref` passes `customerId` from step 0 → step 1 |
| 3 | Clarification | Ambiguous goal → NEEDS_CLARIFICATION → `/clarify` → COMPLETED |
| 4 | Critic recovery | Intentional tool failure → critic inserts recovery steps → COMPLETED |
| 5 | Observability + retry | List all workflows, inspect details, retry a FAILED workflow |

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/workflows` | Create a workflow from a plain-English goal |
| `POST` | `/api/workflows/:id/clarify` | Submit an answer to a clarification question |
| `GET` | `/api/workflows` | List all workflows (with step counts) |
| `GET` | `/api/workflows/:id` | Full workflow details including all steps |
| `POST` | `/api/workflows/:id/retry` | Retry a FAILED workflow from the last failed step |
| `GET` | `/health` | Health check |

### Example: create a workflow

```bash
curl -X POST http://localhost:3000/api/workflows \
  -H "Content-Type: application/json" \
  -d '{"goal": "Find the Stripe customer for alice@example.com and send them a welcome email"}'
```

Response (status: EXECUTING or COMPLETED after async execution):
```json
{
  "id": "clx...",
  "status": "EXECUTING",
  "steps": 2
}
```

## Project Structure

```
src/
├── index.ts             # Express server, Prisma client init
├── types.ts             # Zod schemas: WorkflowStep, WorkflowPlan
├── tools.ts             # Mock tool library (Stripe, Slack, Email, CRM)
├── toolIndex.ts         # Vector embeddings + cosine similarity tool retrieval
├── planner.ts           # LLM planner agent (gpt-4o-mini)
├── validator.ts         # Deterministic plan validator
├── executor.ts          # Async execution engine + recovery loop
├── critic.ts            # LLM critic agent (evaluate step + generate recovery)
├── stepContext.ts       # $ref resolution + execution context builder
└── routes/
    └── workflows.ts     # REST API route handlers

prisma/
├── schema.prisma        # Workflow + WorkflowStep models, status enums
└── migrations/          # Migration history

scripts/
└── demo.ts              # 5-scenario end-to-end CLI demo
```

## Design Choices & Trade-offs

### 1. Workflow Creation

**Natural language → structured plan via LLM + deterministic validator**

The planner ([src/planner.ts](src/planner.ts)) calls `gpt-4o-mini` to produce a JSON plan from the user's goal. Rather than trusting the LLM output blindly, a separate deterministic validator ([src/validator.ts](src/validator.ts)) checks that every step references a real tool and supplies all required parameters. If validation fails, the error list is fed back to the planner for up to three retries before raising an error.

Before calling the planner, [src/toolIndex.ts](src/toolIndex.ts) uses OpenAI's `text-embedding-3-large` to embed the goal and retrieve the top-5 most relevant tools via cosine similarity. This reduces prompt size and steers the planner away from irrelevant tools — the key scaling mechanism for adding new step types.

**Clarification (human-in-the-loop)**

When the planner cannot produce a valid plan because the goal is ambiguous (e.g., no email address provided), it returns a clarification question instead. The workflow enters `NEEDS_CLARIFICATION` status and the API surfaces the question. Once the user answers via `POST /api/workflows/:id/clarify`, re-planning includes both the answer and a summary of any steps already completed, so the plan picks up where it left off rather than starting over.

**Adding new step types**

To add a new tool, implement the `Tool` interface in [src/tools.ts](src/tools.ts) and add it to `toolLibrary`. The vector index in [src/toolIndex.ts](src/toolIndex.ts) picks it up automatically on the next startup. No changes to the planner, validator, executor, or critic are needed — they all operate on the tool interface generically.

**Adding new triggers**

Currently workflows are triggered by an explicit API call. The natural extension is to store a `triggerType` and `triggerValue` on the `Workflow` model and add listener adapters (webhook handler, cron job, Kafka consumer) that call `POST /api/workflows` on the appropriate event. The planner prompt already instructs the LLM to infer a trigger type from the goal; surfacing that in the API response is a straightforward schema addition.

---

### 2. Execution Engine

**Sequential, async, database-driven**

`executeWorkflow` ([src/executor.ts](src/executor.ts)) runs as a background async task — the route handler fires it without `await` and returns immediately. Each iteration fetches the next `PENDING` step from the database, executes it, and persists the output. This means the execution state is always in PostgreSQL, not in memory: if the server crashes mid-workflow, a restart (or a queue worker) can resume from the last completed step.

**Step output chaining via `$ref`**

Steps can depend on prior step outputs without the planner knowing the actual values at plan time. The planner emits a reference like `{ "$ref": "steps", "index": 0, "path": "customerId" }` in `inputParams`. At execution time, [src/stepContext.ts](src/stepContext.ts) resolves these references by fetching the referenced step's `outputData` from the database and substituting the value before calling the tool. This enables true data flow between steps — e.g., passing a `customerId` retrieved from Stripe directly into a CRM note creation call.

**Recovery (in-place step splicing)**

When a step fails or the critic judges its output as incorrect, recovery steps are inserted *after* the failed step by shifting all remaining `PENDING` steps' `stepOrder` values upward and inserting new steps in the gap ([src/executor.ts:insertRecoverySteps](src/executor.ts)). The main loop then picks them up naturally without any special branching. Recovery is capped at 5 attempts per workflow to prevent infinite loops.

**Production path**

In production, replace the in-process `startWorkflowExecution` call with a job enqueue (BullMQ, Temporal, or a similar queue). The executor logic is already stateless with respect to the Node process — it reads all state from the database — so it can run in a separate worker pool with no changes.

**Retry**

`POST /api/workflows/:id/retry` resets only `FAILED` steps to `PENDING` (leaving `SUCCESS` steps untouched) and re-launches the execution loop. This means a retry resumes from the exact point of failure without re-running steps that already succeeded.

---

### 3. Agent Design

**Separated planner and critic**

Rather than a single monolithic ReAct loop, planning and evaluation are handled by two specialized agents with distinct system prompts:

- **Planner** ([src/planner.ts](src/planner.ts)): Converts a goal into a structured, ordered step plan. Runs once at workflow creation (or re-planning after clarification).
- **Critic** ([src/critic.ts](src/critic.ts)): Evaluates each step's output *after* execution and decides whether the workflow should continue or recover. The critic receives the goal, the step's input/output, whether the tool threw an error, and the last five successful step summaries for context.

Separating them reduces token usage per call, makes each agent's behavior independently tunable, and makes failure attribution straightforward (planner hallucination vs. execution failure vs. bad critic recovery).

**Scaling triggers and memory**

The critic currently receives the last five completed steps as a plain-text summary ([src/stepContext.ts:getRecentStepContext](src/stepContext.ts)). For longer workflows or cross-workflow memory, this window can be extended or replaced with a vector store retrieval — the interface is the same (a string passed into the critic prompt). Similarly, the tool retrieval in [src/toolIndex.ts](src/toolIndex.ts) uses the same embedding + cosine similarity pattern and can be backed by Pinecone or pgvector at scale.

**Handling unknown step types**

When the planner emits a `toolName` that doesn't exist in the library, the deterministic validator ([src/validator.ts](src/validator.ts)) catches it immediately and feeds the error back to the planner. The planner is prompted to only use tools from the provided list, so repeated validation failures surface a genuine gap in the tool library rather than a hallucination. The correct response is to add a mock implementation of the missing tool — the interface is minimal (a `name`, `description`, `parameters` schema, and an `execute` function).

## If I Had More Time

**Durable execution queue.** `startWorkflowExecution` fires a plain async function in the same Node process — if the server crashes mid-run, the execution is silently lost even though the database state is intact. The job can be enqueued and then run to be more durable.

**Add Tests.** There are none. Unit tests for deterministic logic + integration tests for full workflow + execution testing (the scenarios somewhat serve this purpose for now).

**Persisted vector index.** `toolIndex.ts` re-embeds every tool on each server startup and holds vectors in memory. This can be stored in something like pinecone instead.

**LLM resilience.** OpenAI calls in `planner.ts` and `critic.ts` have no retry logic — a transient 429 or 503 fails the entire workflow. Adding exponential-backoff retries and a per-call timeout would close this gap. Timeouts should be added to the individual calls too.

**Cross-workflow memory.** Agent memory is scoped to the last five steps of a single workflow. Storing step outputs in a vector store keyed by goal/tool would let the planner dynamically retrieve relevant prior executions as few-shot context, improving plan quality on recurring goal types without any additional user input.

**Streaming step updates.** The API is purely pull-based — callers must poll `GET /api/workflows/:id` to learn when steps complete.

**Explicit dependency graph (DAG).** Instead of the the limited linear support for variables, we can better graph out the dependencies (with explicit `depends_on` arrays — treating the LLM as a compiler that generates a directed acyclic graph). This bridges the gap for parallelism and more complex tooling.

**Extended thinking for the critic.** Use more powerful models especially for the critic step + use the model thoughts to better steer the planner. Currently, the mini model is used for demo purposes.
