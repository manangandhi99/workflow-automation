import { WorkflowPlan } from './types.js';
import { Tool } from './tools.js';

export interface PlanReviewResult {
  status: 'VALID' | 'INVALID';
  errors?: string[];
}

/**
 * Deterministic plan validator (the "Validator Agent" in the multi-agent pipeline).
 *
 * Checks only concrete, unambiguous errors:
 *   1. A step uses a toolName that doesn't exist in the retrieved tool set.
 *   2. A step is missing a parameter marked as "required" by that tool's schema.
 *      Note: a { "$ref": ... } object satisfies any required param — it's a
 *      runtime reference to a prior step's output, not a missing value.
 *
 * Everything else (parameter values, ordering style, unused tools) is left to
 * the executor and critic.
 * 
 * Note: A combination of LLM-based planner + deterministic validator to be experimented with if more time, but for now this is a simple rule-based validator that runs synchronously after the planner returns a plan and before execution begins.
 */
export function validatePlan(
  _goal: string,
  plan: WorkflowPlan,
  availableTools: Tool[]
): PlanReviewResult {
  const toolMap = new Map(availableTools.map((t) => [t.name, t]));
  const errors: string[] = [];

  plan.steps.forEach((step, i) => {
    const stepNum = i + 1;
    const tool = toolMap.get(step.toolName);

    if (!tool) {
      errors.push(`Step ${stepNum}: unknown tool "${step.toolName}"`);
      return;
    }

    const required: string[] = Array.isArray(tool.parameters.required)
      ? tool.parameters.required
      : [];

    for (const param of required) {
      if (step.inputParams[param] === undefined) {
        errors.push(
          `Step ${stepNum}: missing required parameter "${param}" for tool "${step.toolName}"`
        );
      }
    }
  });

  return errors.length === 0 ? { status: 'VALID' } : { status: 'INVALID', errors };
}
