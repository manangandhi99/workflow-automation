import OpenAI from 'openai';
import { z } from 'zod';
import { WorkflowPlan } from './types.js';
import { Tool } from './tools.js';

const PlanReviewSchema = z.object({
  status: z.enum(['VALID', 'INVALID']),
  errors: z.array(z.string()).optional(),
});

export type PlanReviewResult = z.infer<typeof PlanReviewSchema>;

async function getOpenAIClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

export async function validatePlan(goal: string, plan: WorkflowPlan, availableTools: Tool[]) {
  const openai = await getOpenAIClient();
  const toolList = availableTools
    .map((tool) => `- ${tool.name}: ${tool.description}
  Parameters: ${JSON.stringify(tool.parameters.properties)}`)
    .join('\n');

  const planJson = JSON.stringify(plan, null, 2);
  const prompt = `You are a strict QA system for workflow plans. Review the plan below for the goal and the available tools. If the plan is executable and uses only supported tools and required parameters, return {"status":"VALID"}. If there are problems, return {"status":"INVALID","errors":[...]}.

Goal: ${goal}

Available tools:
${toolList}

Plan:
${planJson}

Review criteria:
- Does every step use a defined tool?
- Does each step include required input parameters?
- Are tool names exact and valid?
- Does the plan order match dependency needs?
- If the plan is missing critical steps, identify them.

Output must be valid JSON with status and optional errors.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are a workflow QA system.' },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Validator did not return content');
  }

  const parsed = JSON.parse(content);
  return PlanReviewSchema.parse(parsed);
}
