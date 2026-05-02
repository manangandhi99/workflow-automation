import OpenAI from 'openai';
import { z } from 'zod';
import { WorkflowStepSchema } from './types.js';
import { Tool } from './tools.js';

const CriticResponseSchema = z.object({
  decision: z.enum(['CONTINUE', 'RECOVER']),
  reason: z.string(),
  recoverySteps: z.array(WorkflowStepSchema).optional(),
});

export type CriticResult = z.infer<typeof CriticResponseSchema>;

async function getOpenAIClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function formatToolList(tools: Tool[]) {
  return tools
    .map(
      (t) => `- ${t.name}: ${t.description}\n  Parameters: ${JSON.stringify(t.parameters.properties)}`
    )
    .join('\n');
}

/**
 * Evaluate a completed (or failed) step against the overall workflow goal.
 *
 * Returns CONTINUE if the step moved the workflow forward, or RECOVER with
 * new steps to insert when the output was wrong, incomplete, or the tool threw.
 */
export async function evaluateStepWithCritic(params: {
  goal: string;
  toolName: string;
  inputParams: Record<string, any>;
  outputData: any;
  thought: string;
  stepFailed: boolean;
  recentContext: string | null;
  availableTools: Tool[];
}): Promise<CriticResult> {
  const openai = await getOpenAIClient();

  const userPrompt = `Goal: ${params.goal}

Available tools for recovery:
${formatToolList(params.availableTools)}
${params.recentContext ? `\nRecent execution context:\n${params.recentContext}` : ''}

Step evaluated:
- Tool: ${params.toolName}
- Input: ${JSON.stringify(params.inputParams)}
- Reasoning: ${params.thought}
- Status: ${params.stepFailed ? 'FAILED' : 'SUCCEEDED'}
- Output: ${JSON.stringify(params.outputData)}

Did this step move the workflow toward its goal?
- If yes: return { "decision": "CONTINUE", "reason": "..." }
- If no (failed, bad data, or missing action): return { "decision": "RECOVER", "reason": "...", "recoverySteps": [...] }

Each recovery step must use only the listed tools and must include: toolName, inputParams, thought.
Output valid JSON only.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'You are a workflow execution critic. Evaluate step results and decide whether to continue or recover. Output JSON only.',
      },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error('Critic returned no content');

  const parsed = JSON.parse(content);
  return CriticResponseSchema.parse(parsed);
}
