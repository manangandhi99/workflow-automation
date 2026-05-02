#!/usr/bin/env tsx
/**
 * Workflow Automation — Demo CLI
 *
 * Covers every feature built across all phases:
 *
 *   1. Happy Path        — planner + validator + execution engine
 *   2. Step Chaining     — $ref passes a prior step's output as input
 *   3. Clarification     — ambiguous goal triggers HITL before planning
 *   4. Critic Recovery   — failing step triggers self-correction loop
 *   5. Observability     — list all runs, inspect steps, retry a failure
 *
 * Prerequisites
 *   • Server running:  npm run dev
 *   • .env present with DATABASE_URL and OPENAI_API_KEY
 *
 * Usage
 *   npm run demo            run all 5 scenarios in order
 *   npm run demo -- 3       run scenario 3 only
 */

import dotenv from 'dotenv';
dotenv.config();

// ─── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.API_URL ?? 'http://localhost:3000';
const POLL_INTERVAL_MS = 800;
const POLL_TIMEOUT_MS = 120_000;
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'NEEDS_CLARIFICATION']);

// ─── Colours ───────────────────────────────────────────────────────────────────

const R = '\x1b[0m';
const b   = (s: string) => `\x1b[1m${s}${R}`;
const dim = (s: string) => `\x1b[2m${s}${R}`;
const gr  = (s: string) => `\x1b[32m${s}${R}`;   // green
const rd  = (s: string) => `\x1b[31m${s}${R}`;   // red
const yl  = (s: string) => `\x1b[33m${s}${R}`;   // yellow
const cy  = (s: string) => `\x1b[36m${s}${R}`;   // cyan
const gry = (s: string) => `\x1b[90m${s}${R}`;   // gray
const bl  = (s: string) => `\x1b[34m${s}${R}`;   // blue

// ─── HTTP helpers ──────────────────────────────────────────────────────────────

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as any).details ?? (data as any).error ?? res.statusText);
  return data;
}

async function get(path: string): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`);
  const data = await res.json();
  if (!res.ok) throw new Error((data as any).error ?? res.statusText);
  return data;
}

// ─── Polling ───────────────────────────────────────────────────────────────────

async function poll(workflowId: string): Promise<any> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frame = 0;

  while (Date.now() < deadline) {
    const wf = await get(`/api/workflows/${workflowId}`);
    if (TERMINAL.has(wf.status)) {
      process.stdout.write('\r\x1b[K');
      return wf;
    }
    process.stdout.write(`\r  ${cy(frames[frame % frames.length])} ${gry(`${wf.status}…`)}`);
    frame++;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('Timed out waiting for workflow to reach a terminal state');
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Display helpers ───────────────────────────────────────────────────────────

function statusBadge(status: string) {
  if (status === 'COMPLETED')          return gr(`✓ ${status}`);
  if (status === 'FAILED')             return rd(`✗ ${status}`);
  if (status === 'NEEDS_CLARIFICATION') return yl(`? ${status}`);
  return yl(`○ ${status}`);
}

function printSteps(steps: any[]) {
  if (!steps?.length) return;
  const sorted = [...steps].sort((a, b) => a.stepOrder - b.stepOrder);
  console.log(`\n  Steps:`);
  for (const step of sorted) {
    const icon        = step.status === 'SUCCESS' ? gr('✓') : step.status === 'FAILED' ? rd('✗') : yl('○');
    const isRecovery  = typeof step.thought === 'string' && step.thought.startsWith('[Recovery]');
    const thought     = isRecovery ? step.thought.replace('[Recovery] ', '') : step.thought;
    const recoveryTag = isRecovery ? yl(' [recovery]') : '';

    console.log(`\n    ${step.stepOrder}. ${icon} ${b(step.toolName)}${recoveryTag}`);
    if (thought)            console.log(`       ${dim('why:')}    ${gry(thought)}`);
    if (step.inputParams)   console.log(`       ${dim('input:')}  ${JSON.stringify(step.inputParams)}`);
    if (step.outputData)    console.log(`       ${dim('output:')} ${JSON.stringify(step.outputData)}`);
  }
}

function section(n: number, title: string, description: string) {
  const line = '─'.repeat(62);
  console.log(`\n${line}`);
  console.log(`  ${b(`SCENARIO ${n}`)}  ${cy(title)}`);
  console.log(`  ${gry(description)}`);
  console.log(line);
}

function arrow(msg: string) {
  console.log(`\n  ${bl('›')} ${msg}`);
}

// ─── Scenario 1 — Happy Path ───────────────────────────────────────────────────
//
//  Tests: workflow creation → RAG tool retrieval → plan validation → execution
//
//  Expected: 2 steps (find_stripe_customer, send_email), both SUCCESS, COMPLETED

async function scenario1() {
  section(1, 'Happy Path', 'Basic two-step workflow: Stripe lookup → send welcome email.');

  const goal = 'Find the Stripe customer for john@example.com and send them a welcome email to john@example.com';
  arrow(`Goal: "${goal}"`);

  arrow('Creating workflow…');
  const { id } = await post('/api/workflows', { goal });
  console.log(`     ${gry(`id: ${id}`)}`);

  arrow('Waiting for completion…');
  const wf = await poll(id);

  console.log(`\n  Status: ${statusBadge(wf.status)}`);
  printSteps(wf.steps);
}

// ─── Scenario 2 — Step Chaining ($ref) ────────────────────────────────────────
//
//  Tests: planner emits $ref for a value only available at runtime →
//         executor resolves $ref against prior step output before calling tool
//
//  Expected: step 2's customerId input is { "$ref": "steps", "index": 0, "path": "customerId" }
//            resolved to "cus_123" at execution time

async function scenario2() {
  section(
    2,
    'Step Chaining — $ref Output Passing',
    'Step 2 needs the customer ID from step 1, which is only known at runtime.',
  );

  const goal =
    'Find the Stripe customer for jane@example.com and then use their customer ID to create a CRM welcome note saying "High-value customer onboarded"';
  arrow(`Goal: "${goal}"`);

  arrow('Creating workflow…');
  const { id } = await post('/api/workflows', { goal });
  console.log(`     ${gry(`id: ${id}`)}`);

  arrow('Waiting for completion…');
  const wf = await poll(id);

  console.log(`\n  Status: ${statusBadge(wf.status)}`);
  printSteps(wf.steps);

  // Check if planner used $ref
  const sorted = [...(wf.steps ?? [])].sort((a: any, b: any) => a.stepOrder - b.stepOrder);
  const usedRef = sorted.some((s: any) =>
    JSON.stringify(s.inputParams ?? {}).includes('"$ref"'),
  );
  console.log(
    usedRef
      ? `\n  ${gr('✓')} $ref found in inputParams — runtime value was passed by reference`
      : `\n  ${yl('!')} LLM inlined the value (no $ref generated this run — valid but static)`,
  );
}

// ─── Scenario 3 — Clarification Flow (HITL) ───────────────────────────────────
//
//  Tests: ambiguous goal → NEEDS_CLARIFICATION status stored → clarify endpoint
//         re-runs planner with the answer and execution context
//
//  Expected: initial response has status NEEDS_CLARIFICATION + clarificationQuestion,
//            then after /clarify the workflow proceeds to COMPLETED

async function scenario3() {
  section(
    3,
    'Clarification Flow — Human-in-the-Loop',
    'An under-specified goal pauses execution and asks the user a question.',
  );

  const goal = 'Send an email to John';
  arrow(`Goal: "${goal}"  ${gry('(deliberately vague)')}`);

  arrow('Creating workflow…');
  const created = await post('/api/workflows', { goal });
  console.log(`     ${gry(`id: ${created.id}`)}`);
  console.log(`     ${gry(`initial status: ${created.status}`)}`);

  if (created.status !== 'NEEDS_CLARIFICATION') {
    console.log(`\n  ${yl('!')} LLM assumed values and planned without asking — showing result`);
    const wf = await poll(created.id);
    console.log(`\n  Status: ${statusBadge(wf.status)}`);
    printSteps(wf.steps);
    return;
  }

  console.log(`\n  ${yl('?')} Clarification needed:`);
  console.log(`     "${created.clarificationQuestion}"`);

  const answer = "John Smith at john.smith@example.com — subject: Q3 product launch recap";
  arrow(`Submitting answer: "${answer}"`);
  await post(`/api/workflows/${created.id}/clarify`, { answer });

  arrow('Waiting for completion…');
  const wf = await poll(created.id);
  console.log(`\n  Status: ${statusBadge(wf.status)}`);
  printSteps(wf.steps);
}

// ─── Scenario 4 — Critic Recovery ─────────────────────────────────────────────
//
//  Tests: step execution throws → Critic LLM evaluates the failure →
//         returns RECOVER with new steps → those steps are spliced in and executed
//
//  The mock find_stripe_customer throws when email contains "fail".
//  Expected: step 1 FAILED, Critic inserts [recovery] step(s), workflow continues

async function scenario4() {
  section(
    4,
    'Critic Recovery — Self-Correction Loop',
    '"fail@example.com" makes the Stripe lookup throw; the Critic generates recovery steps.',
  );

  const goal =
    'Find the Stripe customer for fail@example.com and notify the #alerts Slack channel about the new sign-up';
  arrow(`Goal: "${goal}"`);
  console.log(`     ${gry('(find_stripe_customer throws for any email containing "fail")')}`);

  arrow('Creating workflow…');
  const { id } = await post('/api/workflows', { goal });
  console.log(`     ${gry(`id: ${id}`)}`);

  arrow('Waiting for completion — watch for [recovery] steps…');
  const wf = await poll(id);

  console.log(`\n  Status: ${statusBadge(wf.status)}`);
  printSteps(wf.steps);

  const sorted = [...(wf.steps ?? [])].sort((a: any, b: any) => a.stepOrder - b.stepOrder);
  const recoverySteps = sorted.filter((s: any) =>
    typeof s.thought === 'string' && s.thought.startsWith('[Recovery]'),
  );

  if (recoverySteps.length > 0) {
    console.log(`\n  ${gr('✓')} Critic inserted ${recoverySteps.length} recovery step(s) — self-correction worked`);
  } else if (wf.status === 'FAILED') {
    console.log(`\n  ${rd('✗')} Critic could not recover — workflow marked FAILED`);
    console.log(`     ${gry('(This is the correct fallback when no tool can fix the problem)')}`);
  } else {
    console.log(`\n  ${yl('!')} Critic returned CONTINUE on the failed step (non-critical failure)`);
  }
}

// ─── Scenario 5 — Observability + Retry ───────────────────────────────────────
//
//  Tests: GET /api/workflows lists all runs, GET /api/workflows/:id shows step
//         detail, POST /api/workflows/:id/retry re-runs from the failure point
//
//  Expected: all prior workflows visible; if any are FAILED, retry one

async function scenario5() {
  section(
    5,
    'Observability — List, Inspect & Retry',
    'GET /api/workflows indexes all runs; /retry resets FAILED steps and re-executes.',
  );

  arrow('Fetching all workflows…');
  const workflows: any[] = await get('/api/workflows');

  if (workflows.length === 0) {
    console.log(`\n  ${yl('!')} No workflows found — run scenarios 1–4 first`);
    return;
  }

  console.log(`\n  ${b(`${workflows.length} workflow(s) on record:`)}\n`);
  for (const wf of workflows) {
    const badge = wf.status === 'COMPLETED' ? gr('✓') : wf.status === 'FAILED' ? rd('✗') : yl('?');
    const shortId = `${wf.id.slice(0, 14)}…`;
    const shortGoal = wf.goal.length > 52 ? `${wf.goal.slice(0, 52)}…` : wf.goal.padEnd(53);
    console.log(`    ${badge}  ${gry(shortId)}  ${b(wf.status.padEnd(20))}  ${wf._count.steps} step(s)  ${gry(shortGoal)}`);
  }

  // Drill into the most recent workflow
  const latest = workflows[0];
  arrow(`Inspecting most recent run ${gry(latest.id)}…`);
  const detail = await get(`/api/workflows/${latest.id}`);
  console.log(`\n  Status: ${statusBadge(detail.status)}`);
  printSteps(detail.steps);

  // If any workflow is FAILED, demonstrate retry
  const failed = workflows.find((wf: any) => wf.status === 'FAILED');
  if (failed) {
    arrow(`Found a FAILED workflow ${gry(failed.id)} — retrying…`);
    console.log(`     ${gry('(resets FAILED steps to PENDING, leaves SUCCESS steps untouched)')}`);
    await post(`/api/workflows/${failed.id}/retry`, {});
    const retried = await poll(failed.id);
    console.log(`\n  Status after retry: ${statusBadge(retried.status)}`);
    printSteps(retried.steps);
  } else {
    console.log(`\n  ${gry('No FAILED workflows to retry (run scenario 4 to create one)')}`);
  }
}

// ─── Runner ────────────────────────────────────────────────────────────────────

const SCENARIOS: Array<{ name: string; description: string; fn: () => Promise<void> }> = [
  { name: 'Happy Path',        description: 'Planner → validator → execution engine',         fn: scenario1 },
  { name: 'Step Chaining',     description: '$ref passes runtime output between steps',        fn: scenario2 },
  { name: 'Clarification',     description: 'Ambiguous goal triggers HITL before planning',    fn: scenario3 },
  { name: 'Critic Recovery',   description: 'Failed step triggers Critic self-correction',     fn: scenario4 },
  { name: 'Observability',     description: 'List all runs, inspect steps, retry a failure',   fn: scenario5 },
];

async function checkServer() {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    if (!res.ok) throw new Error();
  } catch {
    console.error(`\n  ${rd('✗')} Cannot reach the server at ${BASE_URL}`);
    console.error(`     Start it first:  ${b('npm run dev')}\n`);
    process.exit(1);
  }
}

async function main() {
  console.log('\n');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log(`  ║   ${b('Workflow Automation  —  Demo CLI')}            ║`);
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log(`\n  API: ${gry(BASE_URL)}`);
  console.log(`\n  ${b('Scenarios:')}`);
  SCENARIOS.forEach(({ name, description }, i) =>
    console.log(`    ${cy(String(i + 1))}. ${b(name.padEnd(22))} ${gry(description)}`),
  );
  console.log(`\n  ${dim('npm run demo           — all scenarios')}`);
  console.log(`  ${dim('npm run demo -- 3      — scenario 3 only')}\n`);

  await checkServer();

  const arg = process.argv[2];
  let indices: number[];

  if (arg !== undefined) {
    const n = parseInt(arg, 10);
    if (isNaN(n) || n < 1 || n > SCENARIOS.length) {
      console.error(`  ${rd('✗')} Invalid scenario: "${arg}" — pick a number 1–${SCENARIOS.length}\n`);
      process.exit(1);
    }
    indices = [n - 1];
  } else {
    indices = SCENARIOS.map((_, i) => i);
  }

  let passed = 0;
  let failed = 0;

  for (const i of indices) {
    try {
      await SCENARIOS[i].fn();
      passed++;
    } catch (err: any) {
      console.log(`\n  ${rd('✗ Error:')} ${err.message}`);
      failed++;
    }
  }

  const line = '─'.repeat(62);
  console.log(`\n${line}`);
  if (failed === 0) {
    console.log(`  ${gr('✓')} ${b(`All ${passed} scenario(s) finished`)}\n`);
  } else {
    console.log(`  ${gr('✓')} ${passed} passed   ${rd('✗')} ${failed} errored\n`);
  }

  process.exit(0);
}

main().catch((err: any) => {
  console.error(rd(`\n  Fatal: ${err.message}\n`));
  process.exit(1);
});
