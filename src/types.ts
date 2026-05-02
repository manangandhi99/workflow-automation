import { z } from 'zod';

export const WorkflowStepSchema = z.object({
  toolName: z.string(),
  inputParams: z.record(z.string(), z.any()),
  thought: z.string(),
});

export const WorkflowPlanSchema = z.object({
  steps: z.array(WorkflowStepSchema),
});

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type WorkflowPlan = z.infer<typeof WorkflowPlanSchema>;
