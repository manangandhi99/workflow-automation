import { StepStatus, WorkflowStatus } from './generated/client';
import { prisma } from './index';
import { toolLibrary } from './tools.js';
import { resolveStepReferences, getRecentStepContext } from './stepContext.js';
import { evaluateStepWithCritic } from './critic.js';
import { retrieveRelevantTools } from './toolIndex.js';
import { WorkflowStep } from './types.js';

const MAX_RECOVERY_ATTEMPTS = 5;
const STEP_CONTEXT_LIMIT = parseInt(process.env.STEP_CONTEXT_LIMIT ?? '5', 10);

/**
 * Execute a single workflow step:
 * 1. Fetch the step from the database
 * 2. Resolve any $ref references in inputParams against prior step outputs
 * 3. Look up the tool in the tool library
 * 4. Run the tool, store output, mark SUCCESS or FAILED
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
 * Shift all remaining PENDING steps above afterOrder up by steps.length,
 * then insert the recovery steps in the gap.
 *
 * Example: original orders [1, 2, 3], afterOrder=1, 2 recovery steps →
 *   original step 2 → order 4, original step 3 → order 5
 *   recovery steps inserted at orders 2, 3
 */
async function insertRecoverySteps(
  workflowId: string,
  afterOrder: number,
  steps: WorkflowStep[]
): Promise<void> {
  await prisma.workflowStep.updateMany({
    where: { workflowId, status: StepStatus.PENDING, stepOrder: { gt: afterOrder } },
    data: { stepOrder: { increment: steps.length } },
  });

  await prisma.workflowStep.createMany({
    data: steps.map((step, i) => ({
      workflowId,
      stepOrder: afterOrder + i + 1,
      toolName: step.toolName,
      inputParams: step.inputParams as any,
      thought: `[Recovery] ${step.thought}`,
    })),
  });

  console.log(`[Executor] Inserted ${steps.length} recovery step(s) after order ${afterOrder}`);
}

/**
 * Main execution loop with critic-driven self-correction.
 *
 * Loop design: re-fetches the next PENDING step each iteration so that
 * recovery steps inserted mid-run are picked up automatically.
 *
 * After every step (success or fail) the Critic LLM evaluates the output.
 * If it returns RECOVER, new steps are spliced in before any remaining
 * original steps. Recovery attempts are capped at MAX_RECOVERY_ATTEMPTS
 * to prevent infinite loops.
 *
 * Production note: this loop would live in a background worker (BullMQ,
 * Temporal) so it doesn't block the API thread. Here it runs as a
 * fire-and-forget async call.
 */
export async function executeWorkflow(workflowId: string): Promise<void> {
  const workflow = await prisma.workflow.findUnique({ where: { id: workflowId } });
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);

  if (workflow.status !== WorkflowStatus.EXECUTING) {
    console.warn(`[Executor] Workflow ${workflowId} is not in EXECUTING state`);
  }

  // Retrieve relevant tools once — reused by critic on every step
  const relevantTools = await retrieveRelevantTools(workflow.goal, 5);

  let recoveryCount = 0;

  try {
    while (true) {
      // Dynamically fetch next pending step each iteration so recovery
      // steps inserted by the critic are picked up in order
      const nextStep = await prisma.workflowStep.findFirst({
        where: { workflowId, status: StepStatus.PENDING },
        orderBy: { stepOrder: 'asc' },
      });

      if (!nextStep) break;

      let stepFailed = false;
      try {
        await executeStep(nextStep.id);
      } catch {
        stepFailed = true;
      }

      // Fetch the updated step so the critic sees the stored output
      const completedStep = await prisma.workflowStep.findUnique({
        where: { id: nextStep.id },
      });

      // Re-resolve $ref params so the critic sees concrete values, not ref objects
      const resolvedParams = await resolveStepReferences(
        (nextStep.inputParams ?? {}) as Record<string, any>,
        workflowId
      );

      if (recoveryCount < MAX_RECOVERY_ATTEMPTS) {
        const recentContext = await getRecentStepContext(workflowId, STEP_CONTEXT_LIMIT);

        const criticResult = await evaluateStepWithCritic({
          goal: workflow.goal,
          toolName: nextStep.toolName,
          inputParams: resolvedParams,
          outputData: completedStep?.outputData,
          thought: nextStep.thought ?? '',
          stepFailed,
          recentContext,
          availableTools: relevantTools,
        });

        console.log(`[Critic] ${criticResult.decision}: ${criticResult.reason}`);

        if (criticResult.decision === 'RECOVER' && criticResult.recoverySteps?.length) {
          recoveryCount++;
          await insertRecoverySteps(workflowId, nextStep.stepOrder, criticResult.recoverySteps);
          continue;
        }
      }

      // If the step failed and the critic didn't generate a recovery, give up
      if (stepFailed) {
        await prisma.workflow.update({
          where: { id: workflowId },
          data: { status: WorkflowStatus.FAILED },
        });
        throw new Error(`Step ${nextStep.id} (${nextStep.toolName}) failed with no recovery`);
      }
    }

    await prisma.workflow.update({
      where: { id: workflowId },
      data: { status: WorkflowStatus.COMPLETED },
    });

    console.log(`[Executor] Workflow ${workflowId} completed successfully`);
  } catch (error) {
    console.error(`[Executor] Workflow ${workflowId} failed:`, error);
    // Ensure status is FAILED even if the update above was skipped
    await prisma.workflow
      .update({ where: { id: workflowId }, data: { status: WorkflowStatus.FAILED } })
      .catch(() => {});
    throw error;
  }
}

/**
 * Start execution of a workflow asynchronously (fire and forget).
 * In production this would be: queue.add('execute-workflow', { workflowId })
 */
export function startWorkflowExecution(workflowId: string): void {
  executeWorkflow(workflowId).catch((error) => {
    console.error(`[Executor] Background execution failed for workflow ${workflowId}:`, error);
  });
}
