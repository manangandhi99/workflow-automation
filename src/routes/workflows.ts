import { Router } from 'express';
import { WorkflowStatus } from '../generated/client';
import { prisma } from '../index';

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
        status: WorkflowStatus.PENDING,
      },
    });

    // TODO: Start planning asynchronously

    res.json({ id: workflow.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
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