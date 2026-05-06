# Mock Interview Guide: Autonomous Task Architect

This guide contains potential interview questions and comprehensive answers regarding the design, architecture, and trade-offs of the Autonomous Task Architect repository.

## 1. System Architecture & High-Level Design

**Q: Can you describe the high-level architecture of this system?**
**A:** The system is an agentic workflow engine built with Node.js, Express, and PostgreSQL (via Prisma). It takes a plain-English user goal, translates it into a structured sequence of tool executions using an LLM (OpenAI `gpt-4o-mini`), and then asynchronously executes those steps. It features a dual-agent design (Planner and Critic), deterministic plan validation, tool retrieval via vector embeddings (RAG), and step-output chaining. All state is persisted in PostgreSQL to enable observability, human-in-the-loop clarification, and workflow recovery/retry.

**Q: Why persist workflow state in a database rather than executing entirely in memory?**
**A:** Persisting state to PostgreSQL provides several key benefits:
1. **Durability & Resumption:** If the server crashes mid-execution, the system can pick up exactly where it left off because the state (`PENDING`, `SUCCESS`, `FAILED`) and step outputs are safely in the database.
2. **Observability:** Users can query the API to see the progress of their workflow in real-time.
3. **Human-in-the-loop:** If the LLM needs clarification, it pauses the workflow (`NEEDS_CLARIFICATION`). The user can provide an answer asynchronously, and the system resumes planning from that state.
4. **Retry Logic:** If a workflow fails, the system only needs to retry `FAILED` and `PENDING` steps, skipping steps that already succeeded.

## 2. Multi-Agent Design (Planner vs. Critic)

**Q: Why does the system use two separate agents (Planner and Critic) instead of a single ReAct (Reasoning and Acting) loop?**
**A:** Separating the concerns into a Planner and a Critic provides several advantages:
1. **Token Efficiency:** A single ReAct agent needs the entire context, tool definitions, and reasoning history for every step. By separating them, the Planner runs once to generate the sequence, and the Critic runs only to evaluate single step outputs.
2. **Tunability:** You can independently tune the system prompts, temperatures, and even the models used. For instance, you could use a cheaper model for the Critic and a more capable model for the Planner, or vice versa.
3. **Failure Attribution:** It's easier to debug failures. If the plan was bad, it's a Planner issue. If an execution failed but wasn't caught, it's a Critic issue.
4. **Predictability:** The Planner produces a directed plan up front, which can be deterministically validated before execution starts. ReAct loops are more prone to getting stuck in infinite loops.

**Q: How does the Critic agent handle failures or unexpected outputs?**
**A:** After a step is executed, the Critic evaluates the output against the overall goal. If it decides the step failed (either due to a thrown error or returning bad data), it returns a `RECOVER` decision along with a list of new recovery steps. The execution engine then splices these recovery steps directly into the database, shifting the order of remaining `PENDING` steps so the new steps execute next.

## 3. Data Flow & Step Chaining

**Q: How does the system pass data between steps when the exact values aren't known at planning time?**
**A:** The Planner uses a `$ref` syntax. Instead of hallucinating a value, it outputs a reference like `{"$ref": "steps", "index": 0, "path": "customerId"}`. Before the executor runs a step, it uses `stepContext.ts` to recursively resolve these references by looking up the output data of the completed step at the specified index and extracting the value at the given path. This allows for dynamic data flow (e.g., fetching a Stripe ID and passing it to a CRM tool) while keeping the plan itself static.

## 4. Tool Retrieval & Deterministic Validation

**Q: How does the system handle scaling to hundreds of tools?**
**A:** The system uses Retrieval-Augmented Generation (RAG) for tool selection. It embeds the user's goal using OpenAI's `text-embedding-3-large` and performs cosine similarity against pre-embedded tool descriptions. It then provides only the top 5 most relevant tools to the Planner. This keeps the prompt size small, reduces costs, and prevents the LLM from getting confused by irrelevant tools.

**Q: Why is there a deterministic validator, and what does it check?**
**A:** LLMs can hallucinate. The deterministic validator acts as a safety net before execution begins. It checks concrete, unambiguous rules:
1. Does the step use a tool that actually exists in the retrieved set?
2. Are all required parameters (according to the tool's JSON schema) present?
If the validation fails, the errors are fed back to the Planner for up to 3 retries. This ensures the execution engine receives a structurally sound plan.

## 5. Potential Improvements & Trade-offs

**Q: The README mentions "Durable execution queue" as a future improvement. Why is this needed?**
**A:** Currently, `startWorkflowExecution` runs as an asynchronous, fire-and-forget function within the Node.js process. If the server is restarted or crashes while this function is running, the workflow execution stops abruptly. Although the database state is intact, there is no background worker to automatically resume the execution loop. Moving the execution to a durable queue like BullMQ or Temporal would ensure tasks are reliably retried and managed across server restarts or multiple worker instances.

**Q: How would you improve the system's memory or context capabilities?**
**A:** Currently, the Critic only sees the last 5 steps (in plain text) within the same workflow. To improve this:
1. **Cross-workflow Memory:** We could store step outputs in a vector database. The Planner could retrieve successful past executions for similar goals to use as few-shot examples, improving its planning accuracy.
2. **Explicit Dependency Graphs (DAG):** Instead of linear step ordering and simple `$ref` arrays, we could model the plan as a Directed Acyclic Graph (DAG) with explicit `depends_on` relationships. This would allow independent steps to be executed in parallel.

**Q: What would you do to make the OpenAI calls more resilient?**
**A:** Add retry logic with exponential backoff and timeouts. Currently, a transient 429 (Rate Limit) or 503 (Service Unavailable) error from OpenAI will fail the entire workflow. Libraries like `p-retry` or built-in robust wrappers could catch these transient errors and retry the API call.