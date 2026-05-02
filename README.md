# Autonomous Task Architect

An agentic workflow engine that transforms natural language goals into autonomous task execution using LLMs for planning, execution, and self-correction.

## Features

- **Natural Language Goals**: Users provide goals in plain English, e.g., "Find the new lead in Stripe and send a Slack intro."
- **Autonomous Execution**: The system plans steps, executes them via mocked integrations, and handles failures dynamically.
- **Database-Driven State**: Persistent workflows and steps in PostgreSQL for reliability and observability.
- **Tool Library**: Extensible interface for integrations (Stripe, Slack, Email, etc.).
- **LLM-Powered Planning & Critique**: Uses OpenAI for initial planning and self-evaluation.

## Tech Stack

- **Backend**: TypeScript, Express.js
- **Database**: PostgreSQL with Prisma ORM
- **AI**: OpenAI API
- **Validation**: Zod

## Setup

1. **Clone the repository**
   ```bash
   git clone <repo-url>
   cd workflow-automation
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up the database**
   - Create a PostgreSQL database (use Neon.tech, Supabase, or local Postgres).
   - Update `DATABASE_URL` in `.env` with your connection string.
   - Run migrations:
     ```bash
     npm run db:migrate
     ```

4. **Configure environment variables**
   - Add your OpenAI API key to `.env`:
     ```
     OPENAI_API_KEY=your-api-key-here
     ```

5. **Run the development server**
   ```bash
   npm run dev
   ```

The server will start on `http://localhost:3000`.

## API Endpoints

- `POST /api/workflows` - Create a new workflow with a goal.
- `GET /api/workflows/:id` - Get workflow status and steps.

## Project Structure

```
src/
├── index.ts          # Main Express server
├── routes/
│   └── workflows.ts  # Workflow API routes
└── tools.ts          # Tool library with mocked integrations
prisma/
├── schema.prisma     # Database schema
└── migrations/       # Database migrations
```

## Design Choices & Tradeoffs

- **State-Driven vs. In-Memory**: Chose to persist every step in PostgreSQL rather than keeping the agent loop entirely in memory. This allows resuming workflows after crashes and provides an audit trail for observability.

- **Separation of Planner and Critic**: Instead of one massive ReAct prompt, separated planning and evaluation. This reduces token usage, allows specialized system prompts, and makes debugging hallucinations easier.

- **Execution Engine**: Currently runs asynchronously in the Node process. In production, move to a distributed task queue like Temporal or BullMQ for timeouts, retries, and concurrency.

- **Security**: Tool definitions explicitly define what the LLM can touch. Parameters are validated against schemas (Zod) before execution to prevent prompt injection.

## Roadmap

- Phase 2: Integrate OpenAI for planning
- Phase 3: Implement execution loop
- Phase 4: Add Critic for failure handling and Pinecone memory