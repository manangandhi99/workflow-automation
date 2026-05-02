import { prisma } from './index';

/**
 * Reference object format:
 * {
 *   "$ref": "steps",
 *   "index": 0,      // relative to the start of the workflow (0-indexed)
 *   "path": "customerId"  // path to the field in the step's outputData
 * }
 */
export interface StepRef {
  $ref: string;
  index: number;
  path: string;
}

/**
 * Check if an object is a step reference
 */
export function isStepRef(obj: any): obj is StepRef {
  return (
    obj &&
    typeof obj === 'object' &&
    obj.$ref === 'steps' &&
    typeof obj.index === 'number' &&
    typeof obj.path === 'string'
  );
}

/**
 * Recursively resolve all step references in an object
 */
export async function resolveStepReferences(
  obj: any,
  workflowId: string
): Promise<any> {
  if (isStepRef(obj)) {
    // Fetch the step at the given index
    const steps = await prisma.workflowStep.findMany({
      where: { workflowId },
      orderBy: { stepOrder: 'asc' },
    });

    const step = steps[obj.index];
    if (!step) {
      throw new Error(`Step reference index out of bounds: ${obj.index}`);
    }

    // Navigate the path in the output
    const output = step.outputData as Record<string, any>;
    const value = navigatePath(output, obj.path);
    if (value === undefined) {
      throw new Error(`Path not found in step output: ${obj.path}`);
    }

    return value;
  }

  if (Array.isArray(obj)) {
    return Promise.all(obj.map((item) => resolveStepReferences(item, workflowId)));
  }

  if (obj && typeof obj === 'object') {
    const resolved: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      resolved[key] = await resolveStepReferences(value, workflowId);
    }
    return resolved;
  }

  return obj;
}

/**
 * Navigate a dot-separated path in an object
 * e.g., "data.customerId" -> obj.data.customerId
 */
function navigatePath(obj: any, path: string): any {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

/**
 * Fetch the last N completed steps from a workflow with their outputs
 * Used to pass execution context to the planner
 */
export async function getRecentStepContext(workflowId: string, limit = 5) {
  const steps = await prisma.workflowStep.findMany({
    where: {
      workflowId,
    },
    orderBy: { stepOrder: 'asc' },
  });

  // Get only steps that are completed and have output
  const completed = steps
    .filter((s) => s.status === 'SUCCESS' && s.outputData)
    .slice(-limit); // Last N steps

  if (completed.length === 0) {
    return null;
  }

  // Format as a readable summary for the planner
  const summary = completed
    .map(
      (s, idx) =>
        `Step ${s.stepOrder} (${s.toolName}): ${JSON.stringify(s.outputData)}`
    )
    .join('\n');

  return summary;
}
