import { StepStatus, WorkflowStatus } from './generated/client';
import { prisma } from './index';
import { toolLibrary } from './tools.js';
import { resolveStepReferences } from './stepContext.js';

/**
 * Execute a single workflow step:
 * 1. Fetch the step from the database
 * 2. Look up the tool in the tool library
 * 3. Run the tool with the input parameters
 * 4. Store the output and mark as SUCCESS or FAILED
 */
export async function executeStep(stepId: string): Promise<void> {
  const step = await prisma.workflowStep.findUnique({
    where: { id: stepId },
    include: { workflow: true },
  });

  if (!step) {
    throw new Error(`Step not found: ${stepId}`);
  }

  if (step.status !== StepStatus.PENDING) {
    throw new Error(`Step is not pending: ${stepId}`);
  }

  const tool = toolLibrary[step.toolName];
  if (!tool) {
    await prisma.workflowStep.update({
      where: { id: stepId },
      data: {
        status: StepStatus.FAILED,
        outputData: { error: `Tool not found: ${step.toolName}` },
      },
    });
    throw new Error(`Tool not found: ${step.toolName}`);
  }

  try {
    console.log(`[Executor] Executing step ${step.id} (${step.toolName})`);
    const rawParams = (step.inputParams ?? {}) as Record<string, any>;
    const inputParams = await resolveStepReferences(rawParams, step.workflowId);
    const output = await tool.execute(inputParams);

    await prisma.workflowStep.update({
      where: { id: stepId },
      data: {
        status: StepStatus.SUCCESS,
        outputData: output,
      },
    });

    console.log(`[Executor] Step ${step.id} succeeded`, output);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Executor] Step ${step.id} failed:`, errorMessage);

    await prisma.workflowStep.update({
      where: { id: stepId },
      data: {
        status: StepStatus.FAILED,
        outputData: { error: errorMessage },
      },
    });

    throw error;
  }
}

/**
 * Execute all pending steps in a workflow, in order.
 * This is the main execution loop:
 * 1. Fetch the workflow
 * 2. Loop: fetch next PENDING step by step_order
 * 3. Execute each step
 * 4. Update workflow status to COMPLETED or FAILED
 *
 * Note: In production, this would run in a background worker (BullMQ, Temporal, etc.)
 * to avoid blocking the API thread.
 */
export async function executeWorkflow(workflowId: string): Promise<void> {
  const workflow = await prisma.workflow.findUnique({
    where: { id: workflowId },
    include: { steps: true },
  });

  if (!workflow) {
    throw new Error(`Workflow not found: ${workflowId}`);
  }

  if (workflow.status !== WorkflowStatus.EXECUTING) {
    console.warn(`[Executor] Workflow ${workflowId} is not in EXECUTING state`);
  }

  try {
    // Get all steps sorted by step_order
    const steps = workflow.steps.sort((a, b) => a.stepOrder - b.stepOrder);

    for (const step of steps) {
      if (step.status === StepStatus.PENDING) {
        try {
          await executeStep(step.id);
        } catch (error) {
          // Step already marked as FAILED by executeStep
          // Continue to mark the workflow as failed
          await prisma.workflow.update({
            where: { id: workflowId },
            data: { status: WorkflowStatus.FAILED },
          });
          throw error;
        }
      }
    }

    // All steps completed successfully
    await prisma.workflow.update({
      where: { id: workflowId },
      data: { status: WorkflowStatus.COMPLETED },
    });

    console.log(`[Executor] Workflow ${workflowId} completed successfully`);
  } catch (error) {
    console.error(`[Executor] Workflow ${workflowId} execution failed:`, error);
    throw error;
  }
}

/**
 * Start execution of a workflow asynchronously (fire and forget).
 * In production, this would queue the task to a distributed worker.
 */
export function startWorkflowExecution(workflowId: string): void {
  // Fire and forget: execute in the background
  // In production, this would be: queue.add('execute-workflow', { workflowId })
  executeWorkflow(workflowId).catch((error) => {
    console.error(`[Executor] Background execution failed for workflow ${workflowId}:`, error);
  });
}
