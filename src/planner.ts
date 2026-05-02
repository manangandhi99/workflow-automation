import OpenAI from 'openai';
import { z } from 'zod';
import { WorkflowPlan, WorkflowStepSchema } from './types.js';
import { retrieveRelevantTools } from './toolIndex.js';
import { validatePlan } from './validator.js';
import { Tool } from './tools.js';

const PlannerResponseSchema = z.object({
  decision: z.enum(['plan', 'clarification']),
  steps: z.array(WorkflowStepSchema).optional(),
  question: z.string().optional(),
  reason: z.string().optional(),
});

export type PlannerResult =
  | { decision: 'plan'; plan: WorkflowPlan }
  | { decision: 'clarification'; question: string };

async function getOpenAIClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function formatToolDescriptions(tools: Tool[]) {
  return tools
    .map(
      (tool) =>
        `- ${tool.name}: ${tool.description}\n  Parameters: ${JSON.stringify(
          tool.parameters.properties
        )}`
    )
    .join('\n');
}

function createSystemPrompt(tools: Tool[]) {
  return `You are an expert workflow planner. Your task is to convert a user's goal into executable workflow steps using only the provided tools.\n\nAvailable tools:\n${formatToolDescriptions(tools)}\n\nRules:\n- Use only the available tools.\n- Each step must use exactly one tool.\n- Steps should be ordered logically.\n- If the goal is incomplete or ambiguous for a required tool input, do NOT create a plan.\n- Instead, request clarification by returning decision:\"clarification\" and a single question.\n- If the plan is complete, return decision:\"plan\" and a list of steps.\n- Output must be JSON and parsable.\n- When a step needs a value that will only be known at runtime (i.e. it comes from a prior step's output), use a $ref instead of a placeholder string:\n  { \"$ref\": \"steps\", \"index\": N, \"path\": \"fieldName\" }\n  where N is the 0-based index of the prior step and fieldName is the key in its output.\n  Example: pass customerId from step 0 into step 1 → { \"customerId\": { \"$ref\": \"steps\", \"index\": 0, \"path\": \"customerId\" } }\n\nEach step in the plan must include:\n- toolName: exact tool name\n- inputParams: object with required tool parameters (use $ref for runtime values)\n- thought: the reasoning for this step\n\nExample output for a valid plan:\n{\n  \"decision\": \"plan\",\n  \"steps\": [\n    {\n      \"toolName\": \"find_stripe_customer\",\n      \"inputParams\": {\"email\": \"user@example.com\"},\n      \"thought\": \"Find the customer first so we can use their Stripe ID later.\"\n    },\n    {\n      \"toolName\": \"create_crm_note\",\n      \"inputParams\": {\"customerId\": {\"$ref\": \"steps\", \"index\": 0, \"path\": \"customerId\"}, \"note\": \"Welcome!\"},\n      \"thought\": \"Use the customer ID from step 0 to create the CRM note.\"\n    }\n  ]\n}\n\nExample output for ambiguity:\n{\n  \"decision\": \"clarification\",\n  \"question\": \"Which John did you mean? John Doe or John Smith?\"\n}`;
}

function createUserPrompt(
  goal: string,
  clarificationAnswer?: string,
  reviewFeedback?: string,
  executionContext?: string
) {
  let prompt = `Goal: ${goal}\n\nPlease produce the workflow plan.`;
  if (executionContext) {
    prompt += `\n\nSteps already completed (use their outputs when referencing prior results):\n${executionContext}`;
  }
  if (clarificationAnswer) {
    prompt += `\n\nUser clarification: ${clarificationAnswer}`;
  }
  if (reviewFeedback) {
    prompt += `\n\nPrevious plan review found issues:\n${reviewFeedback}\nPlease revise the plan.`;
  }
  return prompt;
}

async function runPlannerOnce(
  openai: OpenAI,
  goal: string,
  tools: Tool[],
  clarificationAnswer?: string,
  reviewFeedback?: string,
  executionContext?: string
) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: createSystemPrompt(tools) },
      { role: 'user', content: createUserPrompt(goal, clarificationAnswer, reviewFeedback, executionContext) },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error('No response from OpenAI');
  }

  const parsed = JSON.parse(content);
  const validated = PlannerResponseSchema.parse(parsed);

  if (validated.decision === 'plan') {
    const steps = validated.steps;
    if (!steps || steps.length === 0) {
      throw new Error('Planner returned plan decision without steps');
    }
    return { decision: 'plan' as const, plan: { steps } };
  }

  const question = validated.question;
  if (!question) {
    throw new Error('Planner returned clarification decision without question');
  }
  return { decision: 'clarification' as const, question };
}

export async function planWorkflow(
  goal: string,
  clarificationAnswer?: string,
  executionContext?: string
): Promise<PlannerResult> {
  const openai = await getOpenAIClient();
  const tools = await retrieveRelevantTools(goal, 5);

  let reviewFeedback: string | undefined;
  let lastResult: PlannerResult | null = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await runPlannerOnce(openai, goal, tools, clarificationAnswer, reviewFeedback, executionContext);

    if (result.decision === 'clarification') {
      return result;
    }

    const plan = result.plan;
    const review = validatePlan(goal, plan, tools);

    if (review.status === 'VALID') {
      return { decision: 'plan', plan };
    }

    reviewFeedback = review.errors?.map((error) => `- ${error}`).join('\n');
    lastResult = result;
  }

  if (lastResult && lastResult.decision === 'plan') {
    throw new Error('Planner failed validation after 3 retries.');
  }

  throw new Error('Planner was unable to generate a valid plan.');
}
