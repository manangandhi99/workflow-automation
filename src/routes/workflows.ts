import { Router } from 'express';
import { WorkflowStatus } from '../generated/client';
import { prisma } from '../index';
import { planWorkflow } from '../planner.js';
import { startWorkflowExecution } from '../executor.js';
import { getRecentStepContext } from '../stepContext.js';

const STEP_CONTEXT_LIMIT = parseInt(process.env.STEP_CONTEXT_LIMIT ?? '5', 10);

const router = Router();

// POST /api/workflows - Create a new workflow
router.post('/', async (req, res) => {
  try {
    const { goal } = req.body;
    if (!goal) {
      return res.status(400).json({ error: 'Goal is required' });
    }

    const workflow = await prisma.workflow.create({
      data: {
        goal,
        status: WorkflowStatus.PLANNING,
      },
    });

    try {
      const result = await planWorkflow(goal);

      if (result.decision === 'clarification') {
        await prisma.workflow.update({
          where: { id: workflow.id },
          data: {
            status: WorkflowStatus.NEEDS_CLARIFICATION,
            clarificationQuestion: result.question,
          },
        });

        return res.json({
          id: workflow.id,
          status: WorkflowStatus.NEEDS_CLARIFICATION,
          clarificationQuestion: result.question,
        });
      }

      const plan = result.plan;
      await prisma.workflowStep.createMany({
        data: plan.steps.map((step, index) => ({
          workflowId: workflow.id,
          stepOrder: index + 1,
          toolName: step.toolName,
          inputParams: step.inputParams as any,
          thought: step.thought,
        })),
      });

      await prisma.workflow.update({
        where: { id: workflow.id },
        data: { status: WorkflowStatus.EXECUTING },
      });

      // Start execution asynchronously
      startWorkflowExecution(workflow.id);

      res.json({
        id: workflow.id,
        message: 'Workflow created and planned successfully',
        steps: plan.steps.length,
      });
    } catch (planningError) {
      await prisma.workflow.update({
        where: { id: workflow.id },
        data: { status: WorkflowStatus.FAILED },
      });
      throw planningError;
    }
  } catch (error) {
    console.error('Workflow creation failed:', error);
    res.status(500).json({
      error: 'Failed to create workflow',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/workflows/:id/clarify - Submit clarification answer
router.post('/:id/clarify', async (req, res) => {
  try {
    const { id } = req.params;
    const { answer } = req.body;

    if (!answer) {
      return res.status(400).json({ error: 'Clarification answer is required' });
    }

    const workflow = await prisma.workflow.findUnique({
      where: { id },
    });

    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }

    const executionContext = await getRecentStepContext(id, STEP_CONTEXT_LIMIT);
    const result = await planWorkflow(workflow.goal, answer, executionContext ?? undefined);

    if (result.decision === 'clarification') {
      await prisma.workflow.update({
        where: { id },
        data: {
          clarificationQuestion: result.question,
          clarificationAnswer: answer,
          status: WorkflowStatus.NEEDS_CLARIFICATION,
        },
      });

      return res.json({
        id,
        status: WorkflowStatus.NEEDS_CLARIFICATION,
        clarificationQuestion: result.question,
      });
    }

    const plan = result.plan;
    await prisma.workflowStep.createMany({
      data: plan.steps.map((step, index) => ({
        workflowId: id,
        stepOrder: index + 1,
        toolName: step.toolName,
        inputParams: step.inputParams as any,
        thought: step.thought,
      })),
    });

    await prisma.workflow.update({
      where: { id },
      data: {
        status: WorkflowStatus.EXECUTING,
        clarificationAnswer: answer,
      },
    });

    // Start execution asynchronously
    startWorkflowExecution(id);

    res.json({
      id,
      message: 'Workflow clarified and planned successfully',
      steps: plan.steps.length,
    });
  } catch (error) {
    console.error('Clarification failed:', error);
    res.status(500).json({
      error: 'Failed to process clarification',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/workflows/:id - Get workflow status and steps
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const workflow = await prisma.workflow.findUnique({
      where: { id },
      include: { steps: true },
    });

    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }

    res.json(workflow);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
