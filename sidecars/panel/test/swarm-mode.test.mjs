import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractLiveActivity,
  extractModelSteps,
  isParkedOnSwarmWait,
  parseSwarmWorkerRole,
  summarizeToolCall,
} from '../trajectory-metrics.mjs';
import {
  readLocalSqliteTrajectory,
  readLocalSummarySnapshot,
} from '../backend/cli-sqlite-reader.mjs';
import { backendHarness } from './backend-harness.mjs';
import { createMockDom } from './mock-dom.mjs';
import { i18nStore, setI18nLanguage } from '../src/i18n/index.js';
import {
  formatAgentBadgeText,
  formatAgentLabel,
  formatConversationMeta,
  formatLiveActivityLabel,
  isEquivalentTelemetry,
  resolveHostRouteMatch,
  telemetryStore,
} from '../src/store/telemetryStore.js';
import { uiStore } from '../src/store/uiStore.js';
import { LiveActivityWidget } from '../src/components/widgets/LiveActivityWidget.js';
import { TopSessionHeader } from '../src/components/layout/TopSessionHeader.js';

function encodeVarint(val) {
  let v = BigInt(val);
  if (v < 0n) v = BigInt.asUintN(64, v);
  const out = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

function encodeFieldVarint(fieldNo, val) {
  return Buffer.concat([encodeVarint((fieldNo << 3) | 0), encodeVarint(val)]);
}

function encodeFieldBytes(fieldNo, bufOrStr) {
  const b = Buffer.isBuffer(bufOrStr) ? bufOrStr : Buffer.from(String(bufOrStr), 'utf8');
  return Buffer.concat([encodeVarint((fieldNo << 3) | 2), encodeVarint(b.length), b]);
}

function encodeTimestamp(sec, nanos = 0) {
  return Buffer.concat([encodeFieldVarint(1, sec), ...(nanos ? [encodeFieldVarint(2, nanos)] : [])]);
}

function encodeStepMeta({
  createdSec,
  finishedSec,
  stepIndex,
  originCascadeId = '',
  modelEnumInt = 0,
  inputTokens = 0,
  cacheReadTokens = 0,
  outputTokens = 0,
  toolCallName = '',
  toolCallArgsJson = '',
}) {
  const parts = [encodeFieldBytes(1, encodeTimestamp(createdSec))];
  if (finishedSec) {
    parts.push(encodeFieldBytes(7, encodeTimestamp(finishedSec)));
  }
  if (modelEnumInt || inputTokens || cacheReadTokens || outputTokens) {
    const muParts = [];
    if (modelEnumInt) muParts.push(encodeFieldVarint(1, modelEnumInt));
    if (inputTokens) muParts.push(encodeFieldVarint(2, inputTokens));
    if (outputTokens) muParts.push(encodeFieldVarint(3, outputTokens));
    if (cacheReadTokens) muParts.push(encodeFieldVarint(5, cacheReadTokens));
    muParts.push(encodeFieldVarint(6, 24));
    parts.push(encodeFieldBytes(9, Buffer.concat(muParts)));
  }
  const siParts = [encodeFieldVarint(2, stepIndex)];
  if (originCascadeId) {
    siParts.push(encodeFieldBytes(4, originCascadeId));
  }
  parts.push(encodeFieldBytes(20, Buffer.concat(siParts)));
  if (toolCallName) {
    const tcParts = [encodeFieldBytes(1, 'call-1'), encodeFieldBytes(2, toolCallName)];
    if (toolCallArgsJson) tcParts.push(encodeFieldBytes(3, toolCallArgsJson));
    parts.push(encodeFieldBytes(4, Buffer.concat(tcParts)));
  }
  return Buffer.concat(parts);
}

function encodeSystemMessagePayload(text) {
  return encodeFieldBytes(114, encodeFieldBytes(1, text));
}

function encodeSummaryBlob({
  title = '',
  stepCount = 0,
  lastModSec = 0,
  statusInt = 1,
  trajectoryType = 0,
  killed = false,
  forkParentId = '',
  parentConversationId = '',
  subagentSpec = null,
  agentName = '',
}) {
  const parts = [];
  if (stepCount > 0) parts.push(encodeFieldVarint(2, stepCount));
  if (lastModSec > 0) parts.push(encodeFieldBytes(3, encodeTimestamp(lastModSec)));
  if (statusInt > 0) parts.push(encodeFieldVarint(5, statusInt));
  if (title) {
    parts.push(encodeFieldBytes(15, encodeFieldBytes(1, title)));
  }
  if (parentConversationId || subagentSpec || agentName) {
    const tmParts = [];
    if (agentName) tmParts.push(encodeFieldBytes(4, encodeFieldBytes(1, agentName)));
    if (parentConversationId) tmParts.push(encodeFieldBytes(5, parentConversationId));
    if (subagentSpec) {
      const specParts = [];
      if (subagentSpec.typeName) specParts.push(encodeFieldBytes(1, subagentSpec.typeName));
      if (subagentSpec.role) specParts.push(encodeFieldBytes(2, subagentSpec.role));
      tmParts.push(encodeFieldBytes(8, Buffer.concat(specParts)));
    }
    parts.push(encodeFieldBytes(17, Buffer.concat(tmParts)));
  }
  if (trajectoryType > 0) parts.push(encodeFieldVarint(22, trajectoryType));
  if (killed) parts.push(encodeFieldVarint(23, 1));
  if (forkParentId) parts.push(encodeFieldBytes(24, forkParentId));
  return Buffer.concat(parts);
}

test('Swarm tool call summaries, parked swarm_wait detection, and worker SYSTEM_MESSAGE wakeup Turn Rail', () => {
  assert.deepEqual(parseSwarmWorkerRole({ role: 'Swarm Worker (bridge-actions)' }), {
    isSwarmWorker: true,
    memberName: 'bridge-actions',
    isMonitor: false,
    isNarrator: false,
    isAuxiliary: false,
  });
  assert.deepEqual(
    parseSwarmWorkerRole({ role: 'Swarm Worker (@monitor)', agentScriptName: 'fallback' }),
    {
      isSwarmWorker: true,
      memberName: 'monitor',
      isMonitor: true,
      isNarrator: false,
      isAuxiliary: true,
    }
  );
  assert.deepEqual(
    parseSwarmWorkerRole({ typeName: 'worker', agentScriptName: 'entry-runtime' }),
    {
      isSwarmWorker: true,
      memberName: 'entry-runtime',
      isMonitor: false,
      isNarrator: false,
      isAuxiliary: false,
    }
  );
  assert.equal(parseSwarmWorkerRole({ role: 'Codebase Researcher' }).isSwarmWorker, false);

  const addSingle = summarizeToolCall({
    name: 'swarm',
    argumentsJson: JSON.stringify({
      action: 'add',
      name: 'bridge-actions',
      brief: 'Audit api-actions.mjs and window-bridge.mjs thoroughly.',
    }),
  });
  assert.equal(addSingle.actionKey, 'swarm_add');
  assert.equal(addSingle.detail, '@bridge-actions');

  const addTasks = summarizeToolCall({
    name: 'swarm',
    argumentsJson: JSON.stringify({
      action: 'add',
      name: 'auditor',
      tasks: ['m1', 'm2', 'm3', 'm4'],
      brief: 'Audit assigned module.',
    }),
  });
  assert.equal(addTasks.actionKey, 'swarm_add');
  assert.equal(addTasks.detail, '@auditor-1..4');

  const addCopies = summarizeToolCall({
    name: 'swarm',
    argumentsJson: JSON.stringify({ action: 'add', name: 'reviewer', n: 3 }),
  });
  assert.equal(addCopies.actionKey, 'swarm_add');
  assert.equal(addCopies.detail, '@reviewer-1..3');

  assert.equal(
    summarizeToolCall({
      name: 'swarm',
      argumentsJson: JSON.stringify({ action: 'title', title: '20x Full Repo Audit' }),
    }).actionKey,
    'swarm_title'
  );
  assert.equal(
    summarizeToolCall({
      name: 'swarm',
      argumentsJson: JSON.stringify({ action: 'kill', name: 'verifier-fe' }),
    }).detail,
    '@verifier-fe'
  );
  assert.equal(
    summarizeToolCall({
      name: 'swarm',
      argumentsJson: JSON.stringify({ action: 'model', name: 'monitor', model: 'gemini-3.5-flash' }),
    }).detail,
    '@monitor -> gemini-3.5-flash'
  );
  assert.equal(
    summarizeToolCall({ name: 'swarm', argumentsJson: JSON.stringify({ action: 'status' }) })
      .actionKey,
    'swarm_status'
  );

  const postInfo = summarizeToolCall({
    name: 'post_message',
    argumentsJson: JSON.stringify({ text: '@coordinator Completed audit with 3 findings.' }),
  });
  assert.equal(postInfo.actionKey, 'post_message');
  assert.match(postInfo.detail, /@coordinator Completed audit/);

  const readSeqs = summarizeToolCall({
    name: 'read_board',
    argumentsJson: JSON.stringify({ seqs: [9, 14] }),
  });
  assert.equal(readSeqs.actionKey, 'read_board');
  assert.equal(readSeqs.detail, '#9, #14');

  const waitInfo = summarizeToolCall({
    name: 'swarm_wait',
    argumentsJson: JSON.stringify({ since: 42 }),
  });
  assert.equal(waitInfo.actionKey, 'swarm_wait');
  assert.equal(waitInfo.isSwarmWait, true);
  assert.equal(waitInfo.detail, '#42+');

  const parkedTrajectorySteps = [
    {
      type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
      status: 'CORTEX_STEP_STATUS_DONE',
      systemMessage: { message: '[swarm] new board message #9' },
      metadata: { createdAt: '2026-11-18T10:00:00Z' },
    },
    {
      type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
      status: 'CORTEX_STEP_STATUS_DONE',
      systemMessage: {
        message:
          'You have just started. Your assignment (recorded on the board as #9 for @bridge-actions):\n【只读代码审计任务】请检查 api-actions.mjs 与桥接协议的耦合度。',
      },
      metadata: { createdAt: '2026-11-18T10:00:00Z' },
    },
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      plannerResponse: {
        response: 'Posted findings and sleeping.',
        toolCalls: [{ name: 'swarm_wait', argumentsJson: '{"since":25}' }],
      },
      metadata: {
        createdAt: '2026-11-18T10:00:05Z',
        completedAt: '2026-11-18T10:00:08Z',
        sourceTrajectoryStepInfo: { stepIndex: 2 },
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M429',
          inputTokens: '12000',
          cacheReadTokens: '0',
          outputTokens: '600',
        },
      },
    },
    {
      type: 'CORTEX_STEP_TYPE_GENERIC',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: {
        createdAt: '2026-11-18T10:00:08Z',
        toolCall: { name: 'swarm_wait', argumentsJson: '{"since":25}' },
      },
    },
  ];
  assert.equal(isParkedOnSwarmWait(parkedTrajectorySteps), true);
  const liveParked = extractLiveActivity(
    parkedTrajectorySteps,
    true,
    Date.parse('2026-11-18T10:00:08Z')
  );
  assert.equal(liveParked?.phase, 'waiting');
  assert.equal(liveParked?.actionKey, 'swarm_wait');

  // Once woken up with a new SYSTEM_MESSAGE + active step, worker is no longer parked
  const resumedSteps = [
    ...parkedTrajectorySteps,
    {
      type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
      status: 'CORTEX_STEP_STATUS_DONE',
      systemMessage: {
        message: '[board] the latest message is #30 (you have read up to #25).',
      },
      metadata: { createdAt: '2026-11-18T10:02:00Z' },
    },
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      plannerResponse: { response: 'Re-checked line 88.' },
      metadata: {
        createdAt: '2026-11-18T10:02:01Z',
        completedAt: '2026-11-18T10:02:04Z',
        sourceTrajectoryStepInfo: { stepIndex: 5 },
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M429',
          inputTokens: '2000',
          cacheReadTokens: '12000',
          outputTokens: '400',
        },
      },
    },
    {
      type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
      status: 'CORTEX_STEP_STATUS_DONE',
      systemMessage: { message: '<CONTEXT_SUMMARY>Compacted context</CONTEXT_SUMMARY>' },
      metadata: { createdAt: '2026-11-18T10:02:10Z' },
    },
    {
      type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
      status: 'CORTEX_STEP_STATUS_DONE',
      systemMessage: {
        message: '[monitor] tick: check swarm board (iteration 1)',
      },
      metadata: { createdAt: '2026-11-18T10:05:00Z' },
    },
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_RUNNING',
      metadata: {
        createdAt: '2026-11-18T10:05:01Z',
        sourceTrajectoryStepInfo: { stepIndex: 8 },
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M429',
          inputTokens: '1500',
          cacheReadTokens: '13000',
          outputTokens: '200',
        },
      },
    },
  ];
  assert.equal(isParkedOnSwarmWait(resumedSteps), false);

  const workerModelSteps = extractModelSteps(resumedSteps, []);
  assert.equal(workerModelSteps.length, 3);
  assert.equal(workerModelSteps[0].turnIndex, 1);
  assert.match(workerModelSteps[0].turnPromptClean, /^#9 @bridge-actions · 【只读代码审计任务】/);
  assert.equal(workerModelSteps[1].turnIndex, 2);
  assert.equal(workerModelSteps[1].turnPromptClean, '[board] #25 -> #30');
  assert.equal(workerModelSteps[2].turnIndex, 3);
  assert.equal(workerModelSteps[2].turnPromptClean, '[monitor] tick #1');

  // Coordinator trajectory with human USER_INPUT must NOT split turns on SYSTEM_MESSAGE
  const coordinatorSteps = [
    {
      type: 'CORTEX_STEP_TYPE_USER_INPUT',
      status: 'CORTEX_STEP_STATUS_DONE',
      userInput: { userResponse: 'Run a 20-agent swarm audit' },
      metadata: { createdAt: '2026-11-18T09:59:00Z' },
    },
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: {
        createdAt: '2026-11-18T09:59:05Z',
        completedAt: '2026-11-18T09:59:10Z',
        sourceTrajectoryStepInfo: { stepIndex: 1 },
        modelUsage: { model: 'MODEL_PLACEHOLDER_M429', inputTokens: '5000', outputTokens: '300' },
      },
    },
    {
      type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
      status: 'CORTEX_STEP_STATUS_DONE',
      systemMessage: { message: '[42] verifier-fe: @coordinator All checks passed!' },
      metadata: { createdAt: '2026-11-18T10:10:00Z' },
    },
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: {
        createdAt: '2026-11-18T10:10:02Z',
        completedAt: '2026-11-18T10:10:08Z',
        sourceTrajectoryStepInfo: { stepIndex: 3 },
        modelUsage: { model: 'MODEL_PLACEHOLDER_M429', inputTokens: '6000', outputTokens: '500' },
      },
    },
  ];
  const coordModelSteps = extractModelSteps(coordinatorSteps, []);
  assert.equal(coordModelSteps.length, 2);
  assert.equal(coordModelSteps[0].turnIndex, 1);
  assert.equal(coordModelSteps[0].isTurnStart, true);
  assert.equal(coordModelSteps[0].turnPromptClean, 'Run a 20-agent swarm audit');
  assert.equal(coordModelSteps[1].turnIndex, 1);
  assert.equal(coordModelSteps[1].isTurnStart, false);
});

test('Backend Swarm integration: members.json discovery, chronological worker ordering, swarm_wait downgrade, killed state, swarmTitle fallback, and hostRoute projection', async () => {
  const promoMs = Date.parse('2026-11-18T12:00:00Z');
  const rootCid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const untitledRootCid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const wEntryCid = '11111111-1111-4111-8111-111111111111';
  const wKilledCid = '22222222-2222-4222-8222-222222222222';
  const wMonitorCid = '33333333-3333-4333-8333-333333333333';

  const makeModelStep = (idx, secOffset, inputTokens, outputTokens) => ({
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      createdAt: new Date(promoMs - 60_000 + secOffset * 1000).toISOString(),
      completedAt: new Date(promoMs - 60_000 + (secOffset + 2) * 1000).toISOString(),
      sourceTrajectoryStepInfo: { stepIndex: idx },
      modelUsage: {
        model: 'MODEL_PLACEHOLDER_M429',
        apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
        inputTokens: String(inputTokens),
        cacheReadTokens: '0',
        outputTokens: String(outputTokens),
      },
    },
  });

  const swarmWaitStep = (secOffset) => ({
    type: 'CORTEX_STEP_TYPE_GENERIC',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      createdAt: new Date(promoMs - 60_000 + secOffset * 1000).toISOString(),
      toolCall: { name: 'swarm_wait', argumentsJson: '{"since":10}' },
    },
  });

  const trajectories = {
    [rootCid]: {
      trajectory: {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_USER_INPUT',
            status: 'CORTEX_STEP_STATUS_DONE',
            userInput: { userResponse: 'Audit repository coupling with a swarm' },
            metadata: { createdAt: new Date(promoMs - 60_000).toISOString() },
          },
          makeModelStep(1, 2, 10_000, 1_000),
          swarmWaitStep(5),
        ],
      },
    },
    [wEntryCid]: {
      trajectory: {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
            status: 'CORTEX_STEP_STATUS_DONE',
            systemMessage: {
              message:
                'You have just started. Your assignment (recorded on the board as #1 for @entry-runtime):\nAudit main.mjs entrypoints',
            },
            metadata: { createdAt: new Date(promoMs - 50_000).toISOString() },
          },
          makeModelStep(1, 12, 20_000, 2_000),
          swarmWaitStep(15),
        ],
      },
    },
    [wKilledCid]: {
      trajectory: {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
            status: 'CORTEX_STEP_STATUS_DONE',
            systemMessage: { message: '[2] coordinator: @dead-worker Quick check' },
            metadata: { createdAt: new Date(promoMs - 40_000).toISOString() },
          },
          makeModelStep(1, 22, 5_000, 500),
        ],
      },
    },
    [wMonitorCid]: {
      trajectory: {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
            status: 'CORTEX_STEP_STATUS_DONE',
            systemMessage: {
              message: 'Scheduled notification (s1): [monitor] tick #1: Check board progress.',
            },
            metadata: { createdAt: new Date(promoMs - 30_000).toISOString() },
          },
          makeModelStep(1, 32, 8_000, 400),
          swarmWaitStep(35),
        ],
      },
    },
    [untitledRootCid]: {
      trajectory: {
        steps: [makeModelStep(0, 1, 2_000, 200)],
      },
    },
  };

  // Deliberately serialize members in alphabetical Go-map order AND mark parked workers as RUNNING in summaries
  const swarmMembers = {
    [rootCid]: {
      title: '20x Carbon Architecture Audit',
      members: {
        'dead-worker': {
          conversation_id: wKilledCid,
          role: 'Swarm Worker (dead-worker)',
          killed: true,
        },
        'entry-runtime': {
          conversation_id: wEntryCid,
          role: 'Swarm Worker (entry-runtime)',
          killed: false,
        },
        monitor: {
          conversation_id: wMonitorCid,
          role: 'Swarm Worker (monitor)',
          killed: false,
        },
      },
    },
    [untitledRootCid]: {
      title: 'Fallback Swarm Title Only',
      members: {},
    },
  };

  const summaries = {
    [rootCid]: {
      annotations: { title: 'Greeting and Hello' },
      stepCount: 3,
      createdTime: new Date(promoMs - 60_000).toISOString(),
      lastModifiedTime: new Date(promoMs - 20_000).toISOString(),
      status: 'CASCADE_RUN_STATUS_IDLE',
    },
    [wEntryCid]: {
      stepCount: 3,
      createdTime: new Date(promoMs - 50_000).toISOString(),
      lastModifiedTime: new Date(promoMs - 45_000).toISOString(),
      status: 'CASCADE_RUN_STATUS_RUNNING', // Parked on swarm_wait -> must downgrade!
      trajectoryMetadata: {
        parentConversationId: rootCid,
        subagentSpec: { typeName: 'worker', role: 'Swarm Worker (entry-runtime)' },
        agentScript: { name: 'entry-runtime' },
      },
    },
    [wKilledCid]: {
      stepCount: 2,
      createdTime: new Date(promoMs - 40_000).toISOString(),
      lastModifiedTime: new Date(promoMs - 38_000).toISOString(),
      status: 'CASCADE_RUN_STATUS_IDLE',
      killed: true,
      trajectoryMetadata: {
        parentConversationId: rootCid,
        subagentSpec: { typeName: 'worker', role: 'Swarm Worker (dead-worker)' },
      },
    },
    [wMonitorCid]: {
      stepCount: 3,
      createdTime: new Date(promoMs - 30_000).toISOString(),
      lastModifiedTime: new Date(promoMs - 25_000).toISOString(),
      status: 'CASCADE_RUN_STATUS_RUNNING', // Daemon monitor parked on swarm_wait -> must downgrade!
      trajectoryMetadata: {
        parentConversationId: rootCid,
        subagentSpec: { typeName: 'worker', role: 'Swarm Worker (monitor)' },
      },
    },
    [untitledRootCid]: {
      annotations: { title: '' },
      stepCount: 1,
      createdTime: new Date(promoMs - 120_000).toISOString(),
      lastModifiedTime: new Date(promoMs - 110_000).toISOString(),
      status: 'CASCADE_RUN_STATUS_IDLE',
    },
  };

  const h = backendHarness({
    clock: () => promoMs,
    userStatus: { email: 'swarm@example.com' },
    trajectories,
    summaries,
    swarmMembers,
  });

  // 1. All workers parked or killed -> zero running sessions, full token & cost preservation
  const idlePayload = await h.buildTelemetryPayloadInternal({
    selectedConversationId: rootCid,
    stepDetails: 'display',
  });
  const actIdle = idlePayload.activeConversation;
  assert.equal(actIdle.cascadeId, rootCid);
  assert.equal(actIdle.title, 'Greeting and Hello', 'Existing root title must never be overwritten');
  assert.equal(actIdle.swarmTitle, '20x Carbon Architecture Audit');
  assert.equal(actIdle.subagentCount, 3);
  assert.equal(actIdle.swarmCount, 3);
  assert.equal(actIdle.isRunning, false);
  assert.equal(actIdle.aggregated.isRunning, false, 'Parked swarm_wait workers must not keep session running');
  assert.equal(idlePayload.runningConversations.length, 0);

  // Total tokens across root (11k) + entry (22k) + killed (5.5k) + monitor (8.4k) = 46,900
  assert.equal(actIdle.aggregated.totalTokens, 46_900);
  assert.ok(actIdle.aggregated.sessionCostUsd > 0);

  // Chronological order by createdTimeMs: entry-runtime (#1), dead-worker (#2), monitor (#3)
  const childAgents = [...actIdle.agents].filter((a) => !a.isMain);
  assert.deepEqual(
    childAgents.map((a) => ({
      id: a.agentId,
      kind: a.agentKind,
      ord: a.agentOrdinal,
      badge: a.badgeText,
      role: a.customRole,
      state: a.swarmState,
      aux: Boolean(a.isSwarmAuxiliary),
      running: a.isRunning,
    })),
    [
      {
        id: wEntryCid,
        kind: 'swarm_worker',
        ord: 1,
        badge: '蜂1',
        role: '@entry-runtime',
        state: 'waiting',
        aux: false,
        running: false,
      },
      {
        id: wKilledCid,
        kind: 'swarm_worker',
        ord: 2,
        badge: '蜂2',
        role: '@dead-worker',
        state: 'killed',
        aux: false,
        running: false,
      },
      {
        id: wMonitorCid,
        kind: 'swarm_worker',
        ord: 3,
        badge: '蜂3',
        role: '@monitor',
        state: 'waiting',
        aux: true,
        running: false,
      },
    ]
  );

  // Untitled root falls back to swarm.title
  const untitledEntry = idlePayload.conversations.find((c) => c.cascadeId === untitledRootCid);
  assert.equal(untitledEntry?.title, 'Fallback Swarm Title Only');

  // 2. Host route pointing to a child worker (`/c/<wEntryCid>`) resolves rootCid and projects wakeup Turn Rail fields
  const actionHttp = await h.executeTelemetryAction({
    conversationId: wEntryCid,
    stepDetails: 'display',
  });
  assert.equal(actionHttp.status, 200);
  const actionRes = JSON.parse(actionHttp.body);
  const routedAct = actionRes.activeConversation;
  assert.equal(routedAct.cascadeId, rootCid);
  const entryAgentProj = routedAct.agents.find((a) => a.agentId === wEntryCid);
  const projectedEntryStep = entryAgentProj?.recentSteps?.[0];
  assert.ok(projectedEntryStep);
  assert.equal(projectedEntryStep.agentKind, 'swarm_worker');
  assert.equal(projectedEntryStep.agentOrdinal, 1);
  assert.equal(projectedEntryStep.agentCustomRole, '@entry-runtime');
  assert.equal(projectedEntryStep.turnIndex, 1);
  assert.match(projectedEntryStep.turnPromptClean, /^#1 @entry-runtime · Audit main\.mjs entrypoints/);
  assert.equal(projectedEntryStep.rootTurnPromptClean, 'Audit repository coupling with a swarm');

  // 3. When one worker actively executes a tool (not swarm_wait), session enters waiting_swarm with runningSwarmCount=1
  trajectories[wEntryCid] = {
    trajectory: {
      steps: [
        ...trajectories[wEntryCid].trajectory.steps,
        {
          type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
          status: 'CORTEX_STEP_STATUS_DONE',
          systemMessage: { message: '[12] coordinator: @entry-runtime Inspect bridge-daemon.mjs' },
          metadata: { createdAt: new Date(promoMs - 5_000).toISOString() },
        },
        {
          type: 'CORTEX_STEP_TYPE_VIEW_FILE',
          status: 'CORTEX_STEP_STATUS_RUNNING',
          viewFile: { absolutePathUri: 'file:///repo/sidecars/panel/bridge-daemon.mjs' },
          metadata: { createdAt: new Date(promoMs - 2_000).toISOString() },
        },
      ],
    },
  };
  summaries[wEntryCid] = {
    ...summaries[wEntryCid],
    stepCount: 5,
    lastModifiedTime: new Date(promoMs - 2_000).toISOString(),
    status: 'CASCADE_RUN_STATUS_RUNNING',
  };

  const activePayload = await h.buildTelemetryPayloadInternal({
    selectedConversationId: rootCid,
    forceRefresh: true,
    stepDetails: 'summary',
  });
  assert.equal(activePayload.activeConversation.aggregated.isRunning, true);
  assert.equal(activePayload.runningConversations.length, 1);
  const runCard = activePayload.runningConversations[0];
  assert.equal(runCard.swarmCount, 3);
  assert.equal(runCard.runningSubagentCount, 1);
  assert.equal(runCard.runningSwarmCount, 1);
  assert.equal(runCard.mainActivity?.actionKey, 'waiting_swarm');
  const subEntry = runCard.subagents.find((s) => s.cascadeId === wEntryCid);
  const subKilled = runCard.subagents.find((s) => s.cascadeId === wKilledCid);
  const subMonitor = runCard.subagents.find((s) => s.cascadeId === wMonitorCid);
  assert.equal(subEntry?.isRunning, true);
  assert.equal(subEntry?.swarmState, 'working');
  assert.equal(subKilled?.swarmState, 'killed');
  assert.equal(subKilled?.liveActivity?.actionKey, 'swarm_killed');
  assert.equal(subMonitor?.isRunning, false);
  assert.equal(subMonitor?.swarmState, 'waiting');
  assert.equal(subMonitor?.liveActivity?.actionKey, 'swarm_waiting');
});

test('SQLite wire reader: forked Swarm Worker excluded from sideQuestionParents and step_type=101 SYSTEM_MESSAGE decoded selectively on child DBs', (t) => {
  const sqliteMod =
    typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null;
  if (!sqliteMod?.DatabaseSync) {
    t.skip('node:sqlite DatabaseSync unavailable');
    return;
  }
  const { DatabaseSync } = sqliteMod;
  const tempRoot = mkdtempSync(join(tmpdir(), 'agy-swarm-sqlite-'));
  t.after(() => {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup failure on Windows file lock
    }
  });

  const convDir = join(tempRoot, 'conversations');
  mkdirSync(convDir, { recursive: true });

  const rootCid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const forkedWorkerCid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const realSideCid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const baseSec = Math.floor(Date.parse('2026-11-18T08:00:00Z') / 1000);

  const sumDb = new DatabaseSync(join(tempRoot, 'conversation_summaries.db'));
  sumDb.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT,
      preview TEXT,
      status TEXT,
      source TEXT,
      parent_conversation_id TEXT,
      nesting_depth INTEGER,
      agent_name TEXT,
      not_fully_idle INTEGER,
      killed INTEGER,
      step_count INTEGER,
      last_modified_time TEXT,
      app_data_dir TEXT,
      raw_summary BLOB
    );
    CREATE TABLE conversation_parents (
      conversation_id TEXT,
      parent_id TEXT
    );
  `);

  const insSum = sumDb.prepare(`
    INSERT INTO conversation_summaries (
      conversation_id, title, status, parent_conversation_id, agent_name,
      not_fully_idle, killed, step_count, last_modified_time, app_data_dir, raw_summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insSum.run(
    rootCid,
    'Root Swarm Session',
    'CASCADE_RUN_STATUS_IDLE',
    '',
    '',
    0,
    0,
    4,
    new Date(baseSec * 1000).toISOString(),
    'antigravity',
    encodeSummaryBlob({ title: 'Root Swarm Session', stepCount: 4, lastModSec: baseSec, statusInt: 1 })
  );
  insSum.run(
    forkedWorkerCid,
    '',
    'CASCADE_RUN_STATUS_IDLE',
    rootCid,
    'forked-auditor',
    0,
    0,
    3,
    new Date((baseSec + 10) * 1000).toISOString(),
    'antigravity',
    encodeSummaryBlob({
      stepCount: 3,
      lastModSec: baseSec + 10,
      statusInt: 1,
      trajectoryType: 4, // Forked worker trajectory type != 22
      forkParentId: rootCid,
      parentConversationId: rootCid,
      agentName: 'forked-auditor',
      subagentSpec: { typeName: 'worker', role: 'Swarm Worker (forked-auditor)' },
    })
  );
  insSum.run(
    realSideCid,
    'Side Question About Coupling',
    'CASCADE_RUN_STATUS_IDLE',
    rootCid,
    '',
    0,
    0,
    2,
    new Date((baseSec + 20) * 1000).toISOString(),
    'antigravity',
    encodeSummaryBlob({
      title: 'Side Question About Coupling',
      stepCount: 2,
      lastModSec: baseSec + 20,
      statusInt: 1,
      trajectoryType: 22, // Real Side Question
      forkParentId: rootCid,
    })
  );

  const insParent = sumDb.prepare(
    'INSERT INTO conversation_parents (conversation_id, parent_id) VALUES (?, ?)'
  );
  insParent.run(forkedWorkerCid, rootCid);
  insParent.run(realSideCid, rootCid);
  sumDb.close();

  const snap = readLocalSummarySnapshot([tempRoot], { forceRefresh: true });
  assert.equal(snap.available, true);
  assert.ok(snap.sideQuestionParents[realSideCid], 'Real trajectoryType=22 side question must be retained');
  assert.equal(
    snap.sideQuestionParents[forkedWorkerCid],
    undefined,
    'Forked Swarm Worker in conversation_parents must NOT be misclassified into sideQuestionParents'
  );

  // Build child worker DB vs root DB with identical step_type=101 SYSTEM_MESSAGE payload
  function createTrajectoryDb(filePath, { cascadeId, parentConversationId = '', subagentRole = '' }) {
    const db = new DatabaseSync(filePath);
    db.exec(`
      CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
      CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
    `);
    db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?, ?)').run(cascadeId, cascadeId, 0, 1);
    if (parentConversationId || subagentRole) {
      const tmParts = [];
      if (parentConversationId) tmParts.push(encodeFieldBytes(5, parentConversationId));
      if (subagentRole) {
        tmParts.push(
          encodeFieldBytes(
            8,
            Buffer.concat([encodeFieldBytes(1, 'worker'), encodeFieldBytes(2, subagentRole)])
          )
        );
      }
      db.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run(
        'main',
        Buffer.concat(tmParts)
      );
    }
    const insStep = db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)');
    insStep.run(
      0,
      101, // CORTEX_STEP_TYPE_SYSTEM_MESSAGE
      2, // DONE
      encodeStepMeta({ createdSec: baseSec + 1, stepIndex: 0, originCascadeId: cascadeId }),
      encodeSystemMessagePayload('[9] coordinator: @forked-auditor Inspect sqlite-client.mjs')
    );
    insStep.run(
      1,
      15, // CORTEX_STEP_TYPE_PLANNER_RESPONSE
      2,
      encodeStepMeta({
        createdSec: baseSec + 3,
        finishedSec: baseSec + 5,
        stepIndex: 1,
        originCascadeId: cascadeId,
        modelEnumInt: 429,
        inputTokens: 4000,
        outputTokens: 200,
      }),
      Buffer.alloc(0)
    );
    insStep.run(
      2,
      132, // CORTEX_STEP_TYPE_GENERIC (swarm_wait)
      2,
      encodeStepMeta({
        createdSec: baseSec + 5,
        stepIndex: 2,
        originCascadeId: cascadeId,
        toolCallName: 'swarm_wait',
        toolCallArgsJson: '{"since":9}',
      }),
      Buffer.alloc(0)
    );
    db.close();
  }

  const workerDbPath = join(convDir, `${forkedWorkerCid}.db`);
  const rootDbPath = join(convDir, `${rootCid}.db`);
  createTrajectoryDb(workerDbPath, {
    cascadeId: forkedWorkerCid,
    parentConversationId: rootCid,
    subagentRole: 'Swarm Worker (forked-auditor)',
  });
  createTrajectoryDb(rootDbPath, { cascadeId: rootCid });

  const workerRead = readLocalSqliteTrajectory(workerDbPath, {
    cascadeId: forkedWorkerCid,
    isRunning: false,
  });
  assert.ok(workerRead);
  assert.equal(workerRead.steps[0].type, 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE');
  assert.equal(
    workerRead.steps[0].systemMessage?.message,
    '[9] coordinator: @forked-auditor Inspect sqlite-client.mjs'
  );
  assert.equal(isParkedOnSwarmWait(workerRead.steps), true);

  const rootRead = readLocalSqliteTrajectory(rootDbPath, {
    cascadeId: rootCid,
    isRunning: false,
  });
  assert.ok(rootRead);
  assert.equal(rootRead.steps[0].type, 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE');
  assert.equal(
    rootRead.steps[0].systemMessage,
    undefined,
    'Main root conversations must skip decoding step_type=101 payloads for zero extra I/O'
  );
});

test('Frontend Swarm formatters, bilingual i18n, LiveActivityWidget priority sorting + scroll cap, and TopSessionHeader child-route auto-focus', async (t) => {
  const prevLocale = i18nStore.getState().locale;
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevTelState = { ...telemetryStore.getState() };
  const prevUiState = { ...uiStore.getState() };

  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    location: { pathname: '/' },
    addEventListener() {},
    removeEventListener() {},
  };

  const cleanupFns = [];
  t.after(() => {
    for (const fn of cleanupFns.reverse()) {
      try {
        fn();
      } catch {
        // ignore widget teardown errors
      }
    }
    setI18nLanguage(prevLocale);
    telemetryStore.setState(prevTelState);
    uiStore.setState(prevUiState);
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  // 1. Bilingual badges, labels, auxiliary role hints, and conversation meta
  setI18nLanguage('zh-CN');
  assert.equal(
    formatAgentBadgeText({ agentKind: 'swarm_worker', agentOrdinal: 9 }),
    '蜂9'
  );
  assert.equal(
    formatAgentLabel({
      agentKind: 'swarm_worker',
      agentOrdinal: 9,
      customRole: 'Swarm Worker (bridge-actions)',
    }),
    '蜂群 #9 · @bridge-actions'
  );
  assert.equal(
    formatAgentLabel({ agentKind: 'swarm_worker', agentOrdinal: 20, customRole: '@monitor' }),
    '蜂群 #20 · @monitor (巡检)'
  );
  assert.equal(
    formatAgentLabel({ agentKind: 'swarm_worker', agentOrdinal: 21, customRole: '@narrator' }),
    '蜂群 #21 · @narrator (旁白)'
  );
  assert.equal(
    formatConversationMeta({ stepCount: 10, subagentCount: 20, swarmCount: 20, totalStepCount: 250 }),
    '主10 · 20蜂 (共250步)'
  );
  assert.equal(
    formatConversationMeta({ stepCount: 10, subagentCount: 7, swarmCount: 5, totalStepCount: 80 }),
    '主10 · 5蜂 · 2子 (共80步)'
  );
  assert.equal(formatLiveActivityLabel({ actionKey: 'waiting_swarm' }), '等待工蜂');
  assert.equal(formatLiveActivityLabel({ actionKey: 'swarm_waiting' }), '待命中');
  assert.equal(formatLiveActivityLabel({ actionKey: 'swarm_killed' }), '已终止');

  setI18nLanguage('en-US');
  assert.equal(
    formatAgentBadgeText({ agentKind: 'swarm_worker', agentOrdinal: 9 }),
    'W9'
  );
  assert.equal(
    formatAgentLabel({
      agentKind: 'swarm_worker',
      agentOrdinal: 9,
      customRole: 'Swarm Worker (bridge-actions)',
    }),
    'Swarm #9 · @bridge-actions'
  );
  assert.equal(
    formatAgentLabel({ agentKind: 'swarm_worker', agentOrdinal: 20, customRole: '@monitor' }),
    'Swarm #20 · @monitor (Monitor)'
  );
  assert.equal(
    formatConversationMeta({ stepCount: 10, subagentCount: 20, swarmCount: 20, totalStepCount: 250 }),
    'Main 10 · 20 swarm (250 steps)'
  );
  assert.equal(
    formatConversationMeta({ stepCount: 10, subagentCount: 7, swarmCount: 5, totalStepCount: 80 }),
    'Main 10 · 5 swarm · 2 sub (80 steps)'
  );

  setI18nLanguage('zh-CN');

  // 2. Verify CSS bounded scroll rule on `.live-sub-list`
  const builtStyles = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(builtStyles, /\.live-sub-list\s*\{[^}]*max-height:\s*196px/);
  assert.match(builtStyles, /\.live-sub-list\s*\{[^}]*overflow-y:\s*auto/);

  // 3. LiveActivityWidget: running -> waiting -> killed priority sorting & child route isHere badge
  const rootId = 'root-swarm-1111';
  const w1 = 'worker-killed-1';
  const w2 = 'worker-waiting-2';
  const w3 = 'worker-running-3';
  const w4 = 'worker-waiting-4';

  const liveWidget = LiveActivityWidget({
    interactive: true,
    defaultExpandRunningSubs: true,
    showSessionExtras: true,
  });
  cleanupFns.push(() => liveWidget.destroy());
  document.body.appendChild(liveWidget.el);

  liveWidget.refs.update({
    hostRouteConversationId: w2,
    items: [
      {
        cascadeId: rootId,
        title: 'Greeting and Hello',
        swarmTitle: '20x Carbon Audit',
        isMainRunning: false,
        isRunning: true,
        subagentCount: 4,
        swarmCount: 4,
        runningSubagentCount: 1,
        runningSwarmCount: 1,
        mainActivity: {
          phase: 'waiting',
          actionKey: 'waiting_swarm',
          detail: '蜂3 (@verifier-be)',
          startedAtMs: Date.now() - 3_000,
          signature: 'wait:swarm:1',
        },
        subagents: [
          {
            cascadeId: w1,
            index: 1,
            agentKind: 'swarm_worker',
            agentOrdinal: 1,
            customRole: '@dead-node',
            swarmState: 'killed',
            isRunning: false,
            stepCount: 2,
            liveActivity: { phase: 'done', actionKey: 'swarm_killed', signature: 'k1' },
          },
          {
            cascadeId: w2,
            index: 2,
            agentKind: 'swarm_worker',
            agentOrdinal: 2,
            customRole: '@bridge-actions',
            swarmState: 'waiting',
            isRunning: false,
            stepCount: 6,
            liveActivity: { phase: 'waiting', actionKey: 'swarm_waiting', signature: 'w2' },
          },
          {
            cascadeId: w3,
            index: 3,
            agentKind: 'swarm_worker',
            agentOrdinal: 3,
            customRole: '@verifier-be',
            swarmState: 'working',
            isRunning: true,
            stepCount: 9,
            liveActivity: {
              phase: 'tool',
              actionKey: 'read_file',
              detail: 'api-actions.mjs',
              startedAtMs: Date.now() - 2_000,
              signature: 'r3',
            },
          },
          {
            cascadeId: w4,
            index: 4,
            agentKind: 'swarm_worker',
            agentOrdinal: 4,
            customRole: '@monitor',
            swarmState: 'waiting',
            isRunning: false,
            stepCount: 8,
            liveActivity: { phase: 'waiting', actionKey: 'swarm_waiting', signature: 'w4' },
          },
        ],
      },
    ],
  });
  liveWidget.refs.pauseTicker();

  const toggleBtn = liveWidget.el.querySelector('.live-sub-toggle');
  assert.equal(toggleBtn?.textContent, '蜂群 1/4');
  assert.ok(
    toggleBtn?.querySelector('.live-sub-toggle-chevron'),
    'Swarm toggle button renders pure vector SVG chevron icon'
  );
  const hereTag = liveWidget.el.querySelector('.wm-session-tag.is-here');
  assert.ok(hereTag && !hereTag.hasAttribute('hidden'), 'Child worker host route must light up is-here tag');

  const renderedRows = liveWidget.el.querySelectorAll('.live-sub-row');
  assert.equal(renderedRows.length, 4);
  assert.deepEqual(
    renderedRows.map((r) => r.querySelector('.agent-badge')?.textContent),
    ['蜂3', '蜂2', '蜂4', '蜂1'],
    'Rows must sort as running -> waiting -> killed while keeping original ordinals'
  );
  assert.equal(renderedRows[1].querySelector('.live-sub-summary')?.textContent, '待命中 (6 步)');
  assert.equal(renderedRows[3].querySelector('.live-sub-summary')?.textContent, '已终止 (2 步)');

  // 4. TopSessionHeader: child route resolution, header title, and one-shot auto-focus
  const mockTelemetry = {
    settings: { language: 'zh-CN' },
    activeConversation: {
      cascadeId: rootId,
      title: 'Greeting and Hello',
      swarmTitle: '20x Carbon Audit',
      stepCount: 10,
      subagentCount: 4,
      swarmCount: 4,
      totalStepsAllAgents: 32,
      hasSubagents: true,
      isRunning: false,
      aggregated: { isRunning: false },
      agents: [
        { agentId: rootId, isMain: true, agentKind: 'main', stepCount: 10 },
        {
          agentId: w2,
          cascadeId: w2,
          isMain: false,
          index: 2,
          agentKind: 'swarm_worker',
          agentOrdinal: 2,
          customRole: '@bridge-actions',
          swarmState: 'waiting',
          stepCount: 6,
        },
      ],
    },
    conversations: [
      {
        cascadeId: rootId,
        title: 'Greeting and Hello',
        swarmTitle: '20x Carbon Audit',
        stepCount: 10,
        subagentCount: 4,
        swarmCount: 4,
        totalStepCount: 32,
        memberCascadeIds: [w1, w2, w3, w4],
      },
    ],
  };

  assert.equal(
    isEquivalentTelemetry(mockTelemetry, {
      ...mockTelemetry,
      activeConversation: {
        ...mockTelemetry.activeConversation,
        agents: [
          mockTelemetry.activeConversation.agents[0],
          { ...mockTelemetry.activeConversation.agents[1], swarmState: 'killed' },
        ],
      },
    }),
    false,
    'isEquivalentTelemetry must detect swarmState transitions'
  );

  const routeInfo = resolveHostRouteMatch(mockTelemetry, w2);
  assert.equal(routeInfo?.isChildRoute, true);
  assert.equal(routeInfo?.rootConv?.cascadeId, rootId);
  assert.equal(routeInfo?.childAgent?.agentId, w2);

  uiStore.setState(
    { monitorVisible: true, selectedAgentScope: 'all', ctxInspectorAgentId: 'auto' },
    { sync: true }
  );
  telemetryStore.setState(
    {
      selectedConversationId: '',
      hostRouteConversationId: w2,
      syncState: 'idle',
      telemetry: mockTelemetry,
    },
    { sync: true }
  );

  const topHeader = TopSessionHeader({});
  cleanupFns.push(() => topHeader.destroy());
  document.body.appendChild(topHeader.el);

  // Initial mount on `/c/<w2>` auto-focuses scope & inspector to `w2` and labels header option cleanly
  await Promise.resolve();
  assert.equal(uiStore.getState().selectedAgentScope, w2);
  assert.equal(uiStore.getState().ctxInspectorAgentId, w2);
  const triggerText = topHeader.el.querySelector('.select-trigger')?.textContent || '';
  assert.match(triggerText, /当前窗口 \(Greeting and Hello · 蜂2\)/);

  // User manually switches scope back to `all` while still on `/c/<w2>` -> next poll must NOT override!
  uiStore.setState({ selectedAgentScope: 'all', ctxInspectorAgentId: 'auto' }, { sync: true });
  telemetryStore.setState({
    telemetry: {
      ...mockTelemetry,
      activeConversation: { ...mockTelemetry.activeConversation, totalStepsAllAgents: 33 },
    },
  });
  await Promise.resolve();
  assert.equal(uiStore.getState().selectedAgentScope, 'all');
  assert.equal(uiStore.getState().ctxInspectorAgentId, 'auto');

  // Navigating host window back to root `/c/<rootId>` resets auto-focus state cleanly
  uiStore.setState({ selectedAgentScope: w2, ctxInspectorAgentId: w2 }, { sync: true });
  telemetryStore.setState({ hostRouteConversationId: rootId });
  await Promise.resolve();
  assert.equal(uiStore.getState().selectedAgentScope, 'all');
  assert.equal(uiStore.getState().ctxInspectorAgentId, 'auto');
});
