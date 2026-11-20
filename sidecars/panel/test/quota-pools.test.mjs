import test from 'node:test';
import assert from 'node:assert/strict';
import { isEquivalentTelemetry } from '../src/store/telemetryStore.js';
import { backendHarness } from './backend-harness.mjs';

const FLASH = 'MODEL_PLACEHOLDER_M318';
const ARGON = 'MODEL_PLACEHOLDER_M417';
const createdAtMs = Date.now() - 20_000;

function makeStep(index, model) {
  return {
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      sourceTrajectoryStepInfo: { stepIndex: index },
      createdAt: new Date(createdAtMs).toISOString(),
      completedAt: new Date(createdAtMs + 5_000).toISOString(),
      modelUsage: {
        model,
        apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
        inputTokens: '1000',
        cacheReadTokens: '4000',
        outputTokens: '500',
      },
    },
  };
}

test('Ultra user: Argon and Flash sharing Gemini Models remain a single Gemini pool', async () => {
  const sharedReset = new Date(Date.now() + 18 * 3600_000).toISOString();
  const fiveHourReset = new Date(Date.now() + 2 * 3600_000).toISOString();
  const h = backendHarness({
    summaries: { conv1: { stepCount: 1 } },
    trajectories: { conv1: { trajectory: { steps: [makeStep(1, ARGON)] } } },
    userStatus: {
      userTier: { id: 'g1-ultra-lite-tier', name: 'Google AI Ultra' },
      planStatus: { planInfo: { planName: 'Pro' } },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: 'Gemini 4 Argon (High)',
            modelId: 'gemini-4-argon-high',
            modelOrAlias: { model: ARGON },
            quotaInfo: { remainingFraction: 0.087, resetTime: sharedReset },
          },
          {
            label: 'Gemini 3.8 Flash (High)',
            modelId: 'gemini-3.8-flash-high',
            modelOrAlias: { model: FLASH },
            quotaInfo: { remainingFraction: 0.087, resetTime: sharedReset },
          },
        ],
      },
    },
    quotaSummary: {
      groups: [
        {
          displayName: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.99, resetTime: fiveHourReset },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.0868, resetTime: sharedReset },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: fiveHourReset },
            { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1, resetTime: sharedReset },
          ],
        },
      ],
    },
  });

  const p = await h.buildTelemetryPayloadInternal('conv1');
  assert.deepEqual(
    Array.from(p.quotas.pools, (pool) => pool.poolKey),
    ['Gemini', 'Claude & GPT']
  );
  assert.equal(p.quotas.activePool.family, 'Gemini');
  assert.equal(p.quotas.activePool.weeklyRemainingPct, 8.7);
  assert.equal(p.quotas.weekly.poolFamily, 'Gemini');
  assert.equal(p.quotas.weekly.title, '每周限额 (Gemini)');
});

test('Pro user Shape 1: dedicated weekly-only Argon group in RetrieveUserQuotaSummary', async () => {
  const geminiWkReset = new Date(Date.now() + 48 * 3600_000).toISOString();
  const argonWkReset = new Date(Date.now() + 72 * 3600_000).toISOString();
  const fiveHourReset = new Date(Date.now() + 3 * 3600_000).toISOString();

  const h = backendHarness({
    summaries: { argonConv: { stepCount: 1 }, flashConv: { stepCount: 1 } },
    trajectories: {
      argonConv: { trajectory: { steps: [makeStep(1, ARGON)] } },
      flashConv: { trajectory: { steps: [makeStep(1, FLASH)] } },
    },
    userStatus: {
      userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
      planStatus: { planInfo: { planName: 'Pro' } },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: 'Gemini 4 Argon (High)',
            modelId: 'gemini-4-argon-high',
            modelOrAlias: { model: ARGON },
            quotaInfo: { remainingFraction: 0.35, resetTime: argonWkReset },
          },
          {
            label: 'Gemini 3.8 Flash (High)',
            modelId: 'gemini-3.8-flash-high',
            modelOrAlias: { model: FLASH },
            quotaInfo: { remainingFraction: 0.9, resetTime: geminiWkReset },
          },
        ],
      },
    },
    quotaSummary: {
      groups: [
        {
          displayName: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.95, resetTime: fiveHourReset },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9, resetTime: geminiWkReset },
          ],
        },
        {
          displayName: 'Gemini 4 Argon',
          description:
            'For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini quota bucket) is available on Ultra plans.',
          buckets: [
            {
              bucketId: 'gemini-argon-wtu-weekly',
              displayName: 'Gemini 4 Argon Weekly Limit',
              description: 'You have used some of your weekly limit, it will fully refresh in 3 days, 22 hours.',
              window: 'weekly',
              remainingFraction: 0.35,
              resetTime: argonWkReset,
            },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: fiveHourReset },
            { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.8, resetTime: geminiWkReset },
          ],
        },
      ],
    },
  });

  const argonPayload = await h.buildTelemetryPayloadInternal('argonConv');
  assert.deepEqual(
    Array.from(argonPayload.quotas.pools, (pool) => pool.poolKey),
    ['Gemini', 'Argon', 'Claude & GPT']
  );

  const argonPool = argonPayload.quotas.pools.find((pool) => pool.poolKey === 'Argon');
  assert.equal(argonPool.poolLabel, 'Gemini 4 Argon');
  assert.equal(argonPool.isAvailable, true);
  assert.equal(argonPool.has5h, false);
  assert.equal(argonPool.hasWeekly, true);
  assert.equal(argonPool.remainingPct, null);
  assert.equal(argonPool.weeklyRemainingPct, 35);
  assert.equal(argonPool.weeklyUsedPct, 65);
  assert.deepEqual(Array.from(argonPool.models), ['Gemini 4 Argon (High)']);

  // Active Argon conversation binds to Argon pool
  assert.equal(argonPayload.quotas.activePool.family, 'Argon');
  assert.equal(argonPayload.quotas.weekly.poolFamily, 'Argon');
  assert.equal(argonPayload.quotas.weekly.title, '每周限额 (Gemini 4 Argon)');
  assert.equal(argonPayload.quotas.weekly.remainingPct, 35);

  // Active Flash conversation binds to Gemini pool
  const flashPayload = await h.buildTelemetryPayloadInternal('flashConv');
  assert.equal(flashPayload.quotas.activePool.family, 'Gemini');
  assert.equal(flashPayload.quotas.weekly.poolFamily, 'Gemini');
  assert.equal(flashPayload.quotas.weekly.title, '每周限额 (Gemini)');
  assert.equal(flashPayload.quotas.weekly.remainingPct, 90);
});

test('Pro user Shape 2: argon-weekly bucket nested inside Gemini Models group splits into Argon pool', async () => {
  const wkReset = new Date(Date.now() + 60 * 3600_000).toISOString();
  const h = backendHarness({
    quotaSummary: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1, resetTime: wkReset },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.88, resetTime: wkReset },
            { bucketId: 'argon-weekly', window: 'weekly', remainingFraction: 0.42, resetTime: wkReset },
          ],
        },
      ],
    },
  });

  const p = await h.buildTelemetryPayloadInternal('none');
  const argonPool = p.quotas.pools.find((pool) => pool.poolKey === 'Argon');
  const geminiPool = p.quotas.pools.find((pool) => pool.poolKey === 'Gemini');
  assert.ok(argonPool);
  assert.equal(argonPool.weeklyRemainingPct, 42);
  assert.equal(argonPool.has5h, false);
  assert.equal(geminiPool.weeklyRemainingPct, 88);
  assert.equal(geminiPool.has5h, true);
});

test('Pro user Shape 3: divergent Argon quotaInfo in GetUserStatus synthesizes Argon pool when absent from summary', async () => {
  const geminiWkReset = new Date(Date.now() + 50 * 3600_000).toISOString();
  const argonWkReset = new Date(Date.now() + 90 * 3600_000).toISOString();
  const fiveHourReset = new Date(Date.now() + 2 * 3600_000).toISOString();

  const h = backendHarness({
    summaries: { argonConv: { stepCount: 1 } },
    trajectories: { argonConv: { trajectory: { steps: [makeStep(1, ARGON)] } } },
    userStatus: {
      userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: 'Gemini 4 Argon (High)',
            modelId: 'gemini-4-argon-high',
            modelOrAlias: { model: ARGON },
            quotaInfo: { remainingFraction: 0.25, resetTime: argonWkReset },
          },
          {
            label: 'Gemini 3.8 Flash (High)',
            modelId: 'gemini-3.8-flash-high',
            modelOrAlias: { model: FLASH },
            quotaInfo: { remainingFraction: 0.85, resetTime: geminiWkReset },
          },
        ],
      },
    },
    quotaSummary: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.95, resetTime: fiveHourReset },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.85, resetTime: geminiWkReset },
          ],
        },
      ],
    },
  });

  const p = await h.buildTelemetryPayloadInternal('argonConv');
  const argonPool = p.quotas.pools.find((pool) => pool.poolKey === 'Argon');
  assert.ok(argonPool, 'synthesizes Argon pool from divergent clientModelConfigs.quotaInfo');
  assert.equal(argonPool.has5h, false);
  assert.equal(argonPool.hasWeekly, true);
  assert.equal(argonPool.weeklyRemainingPct, 25);
  assert.equal(argonPool.weeklyUsedPct, 75);
  assert.equal(p.quotas.activePool.family, 'Argon');
  assert.equal(p.quotas.weekly.remainingPct, 25);
});

test('exhausted 0% bucket omitting remainingFraction in proto3 is reported as 100% used, not unavailable', async () => {
  const argonWkReset = new Date(Date.now() + 30 * 3600_000).toISOString();
  const h = backendHarness({
    quotaSummary: {
      groups: [
        {
          displayName: 'Gemini 4 Argon',
          buckets: [
            // Proto3 omits remainingFraction when it equals 0
            { bucketId: 'argon-weekly', window: 'weekly', resetTime: argonWkReset },
          ],
        },
      ],
    },
  });

  const p = await h.buildTelemetryPayloadInternal('none');
  const argonPool = p.quotas.pools.find((pool) => pool.poolKey === 'Argon');
  assert.ok(argonPool);
  assert.equal(argonPool.isAvailable, true);
  assert.equal(argonPool.weeklyRemainingPct, 0);
  assert.equal(argonPool.weeklyUsedPct, 100);
});

test('telemetryStore isEquivalentTelemetry detects quota changes in non-active pools', () => {
  const compare = isEquivalentTelemetry;

  const ctx = { compare };
  const a = {
    account: { tierName: 'Google AI Pro', planName: 'Pro' },
    quotas: {
      activePool: { family: 'Gemini', usedPct: 10, remainingPct: 90, weeklyUsedPct: 20 },
      weekly: { usedPct: 20, remainingPct: 80 },
      pools: [
        { poolKey: 'Gemini', poolLabel: 'Gemini', usedPct: 10, remainingPct: 90, weeklyUsedPct: 20, weeklyRemainingPct: 80 },
        { poolKey: 'Argon', poolLabel: 'Gemini 4 Argon', usedPct: null, remainingPct: null, weeklyUsedPct: 40, weeklyRemainingPct: 60 },
      ],
    },
  };
  const b = structuredClone(a);
  b.quotas.pools[1].weeklyUsedPct = 55;
  b.quotas.pools[1].weeklyRemainingPct = 45;
  assert.equal(ctx.compare(a, b), false);
  const c = structuredClone(a);
  c.quotas.pools[0].cycleWeekly = { tokens: 120_000, costUsd: 0.35, calls: 4 };
  assert.equal(ctx.compare(a, c), false, 'Pool cycleWeekly change must trigger store update');
  const d = structuredClone(a);
  d.quotas.pools[0].cycle5h = { tokens: 50_000, costUsd: 0.15, calls: 2 };
  assert.equal(ctx.compare(a, d), false, 'Pool cycle5h change must trigger store update');
  assert.equal(ctx.compare(a, structuredClone(a)), true);
});

test('switching accounts within 10s immediately invalidates quotaSummaryCache', async () => {
  const proReset = '2026-11-03T10:24:10Z';
  const ultraReset = '2026-11-05T16:02:44Z';
  const h = backendHarness({
    userStatus: {
      email: 'pro-user@example.com',
      userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
    },
    quotaSummary: {
      groups: [
        {
          displayName: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9990884, resetTime: ultraReset },
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1, resetTime: '2026-10-30T17:21:07Z' },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
          buckets: [
            { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-11-06T03:55:10Z' },
            { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-10-30T17:21:07Z' },
          ],
        },
        {
          displayName: 'Gemini 4 Argon',
          description:
            'For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini quota bucket) is available on Ultra plans.',
          buckets: [
            {
              bucketId: 'gemini-argon-wtu-weekly',
              displayName: 'Gemini 4 Argon Weekly Limit',
              window: 'weekly',
              remainingFraction: 0.6623139,
              resetTime: proReset,
            },
          ],
        },
      ],
    },
  });

  const first = await h.buildTelemetryPayloadInternal('none');
  assert.deepEqual(
    Array.from(first.quotas.pools, (pool) => pool.poolKey),
    ['Gemini', 'Argon', 'Claude & GPT']
  );
  const argonPool = first.quotas.pools.find((pool) => pool.poolKey === 'Argon');
  assert.equal(argonPool.weeklyRemainingPct, 66.2);
  assert.equal(argonPool.weeklyUsedPct, 33.8);

  // Switch account to Ultra immediately (within the 10-second local cache window)
  h.state.userStatus = {
    email: 'ultra-user@example.com',
    userTier: { id: 'g1-ultra-lite-tier', name: 'Google AI Ultra' },
  };
  h.state.quotaSummary = {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.087, resetTime: ultraReset },
          { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.99, resetTime: '2026-10-30T17:21:07Z' },
        ],
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-11-06T03:55:10Z' },
          { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-10-30T17:21:07Z' },
        ],
      },
    ],
  };

  const second = await h.buildTelemetryPayloadInternal('none');
  assert.deepEqual(
    Array.from(second.quotas.pools, (pool) => pool.poolKey),
    ['Gemini', 'Claude & GPT']
  );
  assert.equal(second.quotas.pools[0].weeklyRemainingPct, 8.7);
});

test('late quota results from another account cannot replace the current account cache', async () => {
  const quota = (remainingFraction) => ({ groups: [{
    displayName: 'Gemini Models',
    buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction }],
  }] });
  const pro = { name: 'Same name', userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } };
  let resolvePrevious;
  const h = backendHarness({
    userStatus: { ...pro, email: 'a@example.com' },
    quotaSummary: new Promise((resolve) => { resolvePrevious = resolve; }),
  });
  const previous = h.buildTelemetryPayloadInternal('none');
  while (!h.state.calls.some(({ method }) => method === 'RetrieveUserQuotaSummary')) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  h.state.userStatus = { ...pro, email: 'b@example.com' };
  h.state.quotaSummary = quota(0.24);
  const switched = await h.buildTelemetryPayloadInternal('none');
  assert.equal(switched.account.email, 'b@example.com');
  assert.equal(switched.quotas.pools.find(({ poolKey }) => poolKey === 'Gemini').weeklyRemainingPct, 24);

  resolvePrevious(quota(0.75));
  const stale = await previous;
  assert.equal(stale.quotas.meta.hasOfficialData, false);
  const refreshed = await h.buildTelemetryPayloadInternal('none');
  assert.equal(refreshed.account.email, 'b@example.com');
  assert.equal(refreshed.quotas.pools.find(({ poolKey }) => poolKey === 'Gemini').weeklyRemainingPct, 24);
});

test('Orchestrator quota pool binding follows active phase: Carbon/Argon while planning, Gemini when offloaded to Hydrogen', async () => {
  const ORCH_CARBON = 'MODEL_PLACEHOLDER_M667';
  const ORCH_ARGON = 'MODEL_PLACEHOLDER_M681';
  const ORCH_EXEC_HYDROGEN = 'MODEL_PLACEHOLDER_M669';
  const geminiReset = new Date(Date.now() + 24 * 3600_000).toISOString();
  const argonReset = new Date(Date.now() + 48 * 3600_000).toISOString();
  const carbonReset = new Date(Date.now() + 72 * 3600_000).toISOString();
  const fiveHourReset = new Date(Date.now() + 2 * 3600_000).toISOString();

  const h = backendHarness({
    summaries: {
      orchCarbonPlan: { stepCount: 1 },
      orchArgonPlan: { stepCount: 1 },
      orchHydrogenExec: { stepCount: 2 },
    },
    trajectories: {
      orchCarbonPlan: { trajectory: { steps: [makeStep(1, ORCH_CARBON)] } },
      orchArgonPlan: { trajectory: { steps: [makeStep(1, ORCH_ARGON)] } },
      orchHydrogenExec: {
        trajectory: { steps: [makeStep(1, ORCH_CARBON), makeStep(2, ORCH_EXEC_HYDROGEN)] },
      },
    },
    userStatus: {
      userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: 'Orchestrator (Carbon)',
            modelId: 'gemini-pro-orchestrator',
            modelOrAlias: { model: ORCH_CARBON },
            quotaInfo: { remainingFraction: 0.4, resetTime: carbonReset },
          },
          {
            label: 'Orchestrator (Argon)',
            modelId: 'gemini-pro-orchestrator-argon',
            modelOrAlias: { model: ORCH_ARGON },
            quotaInfo: { remainingFraction: 0.6, resetTime: argonReset },
          },
          {
            label: 'Gemini 3.8 Flash (High)',
            modelId: 'gemini-3.8-flash-high',
            modelOrAlias: { model: FLASH },
            quotaInfo: { remainingFraction: 0.9, resetTime: geminiReset },
          },
        ],
      },
    },
    quotaSummary: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.95, resetTime: fiveHourReset },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9, resetTime: geminiReset },
          ],
        },
        {
          displayName: 'Gemini 4 Argon',
          buckets: [
            { bucketId: 'argon-weekly', window: 'weekly', remainingFraction: 0.6, resetTime: argonReset },
          ],
        },
        {
          displayName: 'Gemini 4 Carbon',
          buckets: [
            { bucketId: 'carbon-weekly', window: 'weekly', remainingFraction: 0.4, resetTime: carbonReset },
          ],
        },
      ],
    },
  });

  const pCarbon = await h.buildTelemetryPayloadInternal('orchCarbonPlan');
  assert.equal(pCarbon.quotas.activePool.family, 'Carbon');
  assert.equal(pCarbon.quotas.weekly.poolFamily, 'Carbon');
  assert.equal(pCarbon.quotas.weekly.remainingPct, 40);

  const pArgon = await h.buildTelemetryPayloadInternal('orchArgonPlan');
  assert.equal(pArgon.quotas.activePool.family, 'Argon');
  assert.equal(pArgon.quotas.weekly.poolFamily, 'Argon');
  assert.equal(pArgon.quotas.weekly.remainingPct, 60);

  const pExec = await h.buildTelemetryPayloadInternal('orchHydrogenExec');
  assert.equal(pExec.quotas.activePool.family, 'Gemini');
  assert.equal(pExec.quotas.weekly.poolFamily, 'Gemini');
  assert.equal(pExec.quotas.weekly.remainingPct, 90);
});

test('per-pool cycle5h and cycleWeekly isolate each pool by its own reset window and sum into quotas.weekly', async () => {
  const now = Date.now();
  const CLAUDE_SONNET = 'MODEL_CLAUDE_4_5_SONNET';
  // Gemini weekly cycle started 1d ago (resets in +6d); 5h cycle started 1h ago (resets in +4h)
  const geminiWkReset = new Date(now + 6 * 24 * 3600_000).toISOString();
  const gemini5hReset = new Date(now + 4 * 3600_000).toISOString();
  // Argon weekly cycle started 5d ago (resets in +2d)
  const argonWkReset = new Date(now + 2 * 24 * 3600_000).toISOString();
  // Claude & GPT weekly cycle started 6d ago (resets in +1d); 5h cycle started 4h ago (resets in +1h)
  const claudeWkReset = new Date(now + 1 * 24 * 3600_000).toISOString();
  const claude5hReset = new Date(now + 1 * 3600_000).toISOString();

  const makeTimedStep = (idx, model, ageMs, provider = 'API_PROVIDER_GOOGLE_GEMINI', tok = 10_000) => {
    const t = now - ageMs;
    return {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: {
        sourceTrajectoryStepInfo: { stepIndex: idx },
        createdAt: new Date(t).toISOString(),
        completedAt: new Date(t + 2_000).toISOString(),
        modelUsage: {
          model,
          apiProvider: provider,
          inputTokens: String(tok),
          cacheReadTokens: '0',
          outputTokens: '1000',
        },
      },
    };
  };

  const h = backendHarness({
    summaries: { multiCycleConv: { stepCount: 6 } },
    trajectories: {
      multiCycleConv: {
        trajectory: {
          steps: [
            // 1. Gemini Flash 30m ago -> inside Gemini 5h (1h ago) & Gemini weekly (1d ago)
            makeTimedStep(1, FLASH, 30 * 60_000, 'API_PROVIDER_GOOGLE_GEMINI', 10_000),
            // 2. Gemini Flash 3h ago -> OUTSIDE Gemini 5h (started 1h ago), INSIDE Gemini weekly (1d ago)
            makeTimedStep(2, FLASH, 3 * 3600_000, 'API_PROVIDER_GOOGLE_GEMINI', 20_000),
            // 3. Gemini Flash 3d ago -> OUTSIDE Gemini weekly (started 1d ago)!
            makeTimedStep(3, FLASH, 3 * 24 * 3600_000, 'API_PROVIDER_GOOGLE_GEMINI', 99_000),
            // 4. Argon 3d ago -> INSIDE Argon weekly (started 5d ago)!
            makeTimedStep(4, ARGON, 3 * 24 * 3600_000, 'API_PROVIDER_GOOGLE_GEMINI', 40_000),
            // 5. Claude 3h ago -> INSIDE Claude 5h (started 4h ago) & Claude weekly (started 6d ago)
            makeTimedStep(5, CLAUDE_SONNET, 3 * 3600_000, 'API_PROVIDER_ANTHROPIC', 30_000),
            // 6. Claude 4d ago -> OUTSIDE Claude 5h, INSIDE Claude weekly (started 6d ago)
            makeTimedStep(6, CLAUDE_SONNET, 4 * 24 * 3600_000, 'API_PROVIDER_ANTHROPIC', 50_000),
          ],
        },
      },
    },
    userStatus: {
      userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: 'Gemini 3.8 Flash (High)',
            modelId: 'gemini-3.8-flash-high',
            modelOrAlias: { model: FLASH },
            quotaInfo: { remainingFraction: 0.85, resetTime: gemini5hReset },
          },
          {
            label: 'Gemini 4 Argon (High)',
            modelId: 'gemini-4-argon-high',
            modelOrAlias: { model: ARGON },
            quotaInfo: { remainingFraction: 0.6, resetTime: argonWkReset },
          },
          {
            label: 'Claude 4.5 Sonnet',
            modelId: 'claude-sonnet-4-5',
            modelOrAlias: { model: CLAUDE_SONNET },
            quotaInfo: { remainingFraction: 0.7, resetTime: claude5hReset },
          },
        ],
      },
    },
    quotaSummary: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.85, resetTime: gemini5hReset },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.8, resetTime: geminiWkReset },
          ],
        },
        {
          displayName: 'Gemini 4 Argon',
          buckets: [
            { bucketId: 'argon-weekly', window: 'weekly', remainingFraction: 0.6, resetTime: argonWkReset },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            { bucketId: '3p-5h', window: '5h', remainingFraction: 0.7, resetTime: claude5hReset },
            { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.5, resetTime: claudeWkReset },
          ],
        },
      ],
    },
  });

  const p = await h.buildTelemetryPayloadInternal('multiCycleConv');
  const byKey = new Map(p.quotas.pools.map((pool) => [pool.poolKey, pool]));

  const geminiPool = byKey.get('Gemini');
  const argonPool = byKey.get('Argon');
  const claudePool = byKey.get('Claude & GPT');

  // Gemini: step 1 (11,000) in 5h; steps 1+2 (32,000) in weekly; step 3 (3d ago) excluded!
  assert.equal(geminiPool.cycle5h.calls, 1);
  assert.equal(geminiPool.cycle5h.tokens, 11_000);
  assert.equal(geminiPool.cycleWeekly.calls, 2);
  assert.equal(geminiPool.cycleWeekly.tokens, 32_000);

  // Argon: step 4 (41,000) in weekly (3d ago < 5d window)
  assert.equal(argonPool.cycleWeekly.calls, 1);
  assert.equal(argonPool.cycleWeekly.tokens, 41_000);

  // Claude & GPT: step 5 (31,000) in 5h; steps 5+6 (82,000) in weekly (4d ago < 6d window, not clipped by Gemini's 1d window!)
  assert.equal(claudePool.cycle5h.calls, 1);
  assert.equal(claudePool.cycle5h.tokens, 31_000);
  assert.equal(claudePool.cycleWeekly.calls, 2);
  assert.equal(claudePool.cycleWeekly.tokens, 82_000);

  // Global quotas.weekly equals the exact sum across all pools' weekly cycles (2 + 1 + 2 = 5 calls; 32k + 41k + 82k = 155k tokens)
  assert.equal(p.quotas.weekly.calls, 5);
  assert.equal(p.quotas.weekly.tokens, 155_000);
  assert.equal(
    p.quotas.weekly.costUsd,
    +(geminiPool.cycleWeekly.costUsd + argonPool.cycleWeekly.costUsd + claudePool.cycleWeekly.costUsd).toFixed(2)
  );

  // Consumption preset 'cycle' and selected range 'cycle' match quotas.weekly across heterogeneous pool reset windows
  assert.equal(p.consumption.presets.cycle.account.calls, 5);
  assert.equal(p.consumption.presets.cycle.account.totalTokens, 155_000);

  const pCycle = await h.buildTelemetryPayloadInternal('multiCycleConv', false, { range: 'cycle' });
  assert.equal(pCycle.consumption.selectedRange.key, 'cycle');
  assert.equal(pCycle.consumption.account.calls, 5);
  assert.equal(pCycle.consumption.account.totalTokens, 155_000);
  const cycleModelsTok = pCycle.modelBreakdown.reduce((sum, m) => sum + m.totalTokens, 0);
  assert.equal(cycleModelsTok, 155_000);
  const cycleSourcesTok = pCycle.consumption.sourcesBreakdown.reduce((sum, s) => sum + s.totalTokens, 0);
  assert.equal(cycleSourcesTok, 155_000);
});
