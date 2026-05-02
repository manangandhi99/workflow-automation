import { planWorkflow } from './src/planner.js';

async function testPlanner() {
  try {
    const result = await planWorkflow('Find the new lead in Stripe and send a Slack intro');
    console.log('Planning result:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Planning failed:', error);
  }
}

testPlanner();