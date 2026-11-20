import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLocalSqliteTrajectory } from '../backend/cli-sqlite-reader.mjs';
import { backendHarness } from './backend-harness.mjs';
import { i18nStore } from '../src/i18n/index.js';
import {
  formatAgentBadgeText,
  formatAgentLabel,
  resolveScopedConversation,
} from '../src/store/telemetryStore.js';

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
  thinkingTokens = 0,
  responseTokens = 0,
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
    muParts.push(encodeFieldVarint(6, 24)); // API_PROVIDER_GOOGLE_GEMINI
    if (thinkingTokens) muParts.push(encodeFieldVarint(9, thinkingTokens));
    if (responseTokens) muParts.push(encodeFieldVarint(10, responseTokens));
    parts.push(encodeFieldBytes(9, Buffer.concat(muParts)));
  }
  const siParts = [encodeFieldVarint(2, stepIndex)];
  if (originCascadeId) {
    siParts.push(encodeFieldBytes(4, originCascadeId));
  }
  parts.push(encodeFieldBytes(20, Buffer.concat(siParts)));
  return Buffer.concat(parts);
}

function encodeUserInputPayload(text) {
  return encodeFieldBytes(19, encodeFieldBytes(2, text));
}

function encodePlannerResponsePayload(text) {
  return encodeFieldBytes(20, encodeFieldBytes(1, text));
}

function encodeGenMeta({
  stepIndex,
  cascadeId,
  responseModel,
  modelDisplayName,
  estimatedTokensUsed = 0,
  maxContextTokens = 256000,
  userMsgTokens = 0,
}) {
  const groups = [];
  if (userMsgTokens > 0) {
    const child = Buffer.concat([
      encodeFieldBytes(1, '0: USER_INPUT'),
      encodeFieldVarint(3, userMsgTokens),
    ]);
    const topGroup = Buffer.concat([
      encodeFieldBytes(1, 'Chat Messages'),
      encodeFieldVarint(2, 7), // TOKEN_TYPE_CHAT_MESSAGES
      encodeFieldVarint(4, userMsgTokens),
      encodeFieldBytes(5, child),
    ]);
    groups.push(encodeFieldBytes(1, topGroup));
  }
  const cwParts = [];
  if (estimatedTokensUsed > 0) cwParts.push(encodeFieldVarint(1, estimatedTokensUsed));
  if (groups.length > 0) cwParts.push(encodeFieldBytes(3, Buffer.concat(groups)));
  if (maxContextTokens > 0) cwParts.push(encodeFieldVarint(4, maxContextTokens));

  const mapCascade = Buffer.concat([
    encodeFieldBytes(1, 'cascade_id'),
    encodeFieldBytes(2, cascadeId),
  ]);
  const chatParts = [
    encodeFieldBytes(9, encodeFieldBytes(10, Buffer.concat(cwParts))),
    encodeFieldBytes(11, encodeTimestamp(1, 0)), // 1s TTFT
    encodeFieldBytes(19, responseModel),
    encodeFieldBytes(20, mapCascade),
    encodeFieldBytes(21, modelDisplayName),
  ];
  return Buffer.concat([
    encodeFieldVarint(2, stepIndex),
    encodeFieldBytes(1, Buffer.concat(chatParts)),
  ]);
}

function encodeSummaryBlob({
  title = '',
  stepCount = 0,
  lastModSec = 0,
  statusInt = 1,
  trajectoryType = 0,
  forkParentId = '',
  sideQuestionIds = [],
  sideQuestionTitles = {},
  parentConversationId = '',
  subagentSpec = null,
}) {
  const parts = [];
  if (stepCount > 0) parts.push(encodeFieldVarint(2, stepCount));
  if (lastModSec > 0) parts.push(encodeFieldBytes(3, encodeTimestamp(lastModSec)));
  if (statusInt > 0) parts.push(encodeFieldVarint(5, statusInt));

  const annParts = [];
  if (title) annParts.push(encodeFieldBytes(1, title));
  for (const sqId of sideQuestionIds) {
    annParts.push(encodeFieldBytes(17, sqId));
  }
  for (const [k, v] of Object.entries(sideQuestionTitles)) {
    annParts.push(
      encodeFieldBytes(18, Buffer.concat([encodeFieldBytes(1, k), encodeFieldBytes(2, v)]))
    );
  }
  if (annParts.length > 0) parts.push(encodeFieldBytes(15, Buffer.concat(annParts)));

  if (parentConversationId || subagentSpec) {
    const tmParts = [];
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
  if (forkParentId) parts.push(encodeFieldBytes(24, forkParentId));
  return Buffer.concat(parts);
}

test('Hybrid SQLite+WAL mode skips trajectory RPCs for local DBs, falls back to RPC when DB is absent, deduplicates cloned Side Question steps, protects mainline context, and renders zh/en badges', async (t) => {
  const sqliteMod =
    typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null;
  if (!sqliteMod?.DatabaseSync) {
    t.skip('node:sqlite DatabaseSync unavailable');
    return;
  }
  const { DatabaseSync } = sqliteMod;
  const tempRoot = mkdtempSync(join(tmpdir(), 'agy-hybrid-sqlite-'));

  const mainCid = '11111111-1111-4111-8111-111111111111';
  const subCid = '22222222-2222-4222-8222-222222222222';
  const sideCid = '33333333-3333-4333-8333-333333333333';
  const emptySideCid = '44444444-4444-4444-8444-444444444444';
  const rpcOnlyCid = '55555555-5555-4555-8555-555555555555';

  // Use promo-period timestamp: 2026-11-18T00:00:00Z = 1794960000
  const baseSec = Math.floor(Date.parse('2026-11-18T00:00:00Z') / 1000);
  const rpcCalls = [];

  const mockLsServer = http.createServer((req, res) => {
    let rawBody = '';
    req.on('data', (chunk) => {
      rawBody += chunk;
    });
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const body = rawBody ? JSON.parse(rawBody) : {};
      rpcCalls.push({ method, cascadeId: body.cascadeId || '' });

      res.setHeader('Content-Type', 'application/json');
      if (method === 'GetUserStatus') {
        res.end(JSON.stringify({ userStatus: { email: 'dev@example.com' } }));
        return;
      }
      if (method === 'RetrieveUserQuotaSummary') {
        res.end(JSON.stringify({ response: { groups: [] } }));
        return;
      }
      if (method === 'GetAvailableModels') {
        res.end(JSON.stringify({ response: { models: {} } }));
        return;
      }
      if (method === 'GetCascadeTrajectory' && body.cascadeId === rpcOnlyCid) {
        res.end(
          JSON.stringify({
            numTotalSteps: 2,
            trajectory: {
              steps: [
                {
                  // Cloned step from mainCid over RPC — must ALSO be stripped by filterClonedTrajectorySteps!
                  type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                  status: 'CORTEX_STEP_STATUS_DONE',
                  metadata: {
                    createdAt: new Date((baseSec + 50) * 1000).toISOString(),
                    finishedGeneratingAt: new Date((baseSec + 54) * 1000).toISOString(),
                    sourceTrajectoryStepInfo: { stepIndex: 0, cascadeId: mainCid },
                    modelUsage: {
                      model: 'MODEL_PLACEHOLDER_M429',
                      apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                      inputTokens: '5000000',
                      cacheReadTokens: '0',
                      outputTokens: '0',
                    },
                  },
                },
                {
                  type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                  status: 'CORTEX_STEP_STATUS_DONE',
                  metadata: {
                    createdAt: new Date((baseSec + 100) * 1000).toISOString(),
                    finishedGeneratingAt: new Date((baseSec + 102) * 1000).toISOString(),
                    sourceTrajectoryStepInfo: { stepIndex: 1, cascadeId: rpcOnlyCid },
                    modelUsage: {
                      model: 'MODEL_PLACEHOLDER_M320', // gemini-3.8-flash-low: $0.30/M input
                      apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                      inputTokens: '1000000',
                      cacheReadTokens: '0',
                      outputTokens: '0',
                    },
                  },
                },
              ],
            },
          })
        );
        return;
      }
      res.statusCode = 500;
      res.end(JSON.stringify({ error: `unexpected RPC ${method}` }));
    });
  });

  await new Promise((resolve) => mockLsServer.listen(0, '127.0.0.1', resolve));
  const lsPort = mockLsServer.address().port;

  try {
    const agyDir = join(tempRoot, 'antigravity');
    const convDir = join(agyDir, 'conversations');
    mkdirSync(convDir, { recursive: true });

    // 1. Build conversation_summaries.db in WAL mode
    const sumDbPath = join(agyDir, 'conversation_summaries.db');
    const sumDb = new DatabaseSync(sumDbPath);
    sumDb.exec(`
      PRAGMA journal_mode = WAL;
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
        conversation_id, title, status, parent_conversation_id, step_count, last_modified_time, app_data_dir, raw_summary
      ) VALUES (?, ?, ?, ?, ?, ?, 'antigravity', ?)
    `);

    insSum.run(
      mainCid,
      'Main Architecture Task',
      'CASCADE_RUN_STATUS_IDLE',
      '',
      2,
      '2026-11-18T00:01:35Z',
      encodeSummaryBlob({
        title: 'Main Architecture Task',
        stepCount: 2,
        lastModSec: baseSec + 95,
        sideQuestionIds: [sideCid, emptySideCid],
        sideQuestionTitles: { [sideCid]: '为什么用 WAL 模式？' },
      })
    );
    insSum.run(
      subCid,
      'SQLite Researcher',
      'CASCADE_RUN_STATUS_IDLE',
      mainCid,
      2,
      '2026-11-18T00:01:10Z',
      encodeSummaryBlob({
        title: 'SQLite Researcher',
        stepCount: 2,
        lastModSec: baseSec + 70,
        parentConversationId: mainCid,
        subagentSpec: { typeName: 'research', role: 'SQLite Researcher' },
      })
    );
    insSum.run(
      sideCid,
      '',
      'CASCADE_RUN_STATUS_IDLE',
      '',
      4,
      '2026-11-18T00:02:00Z',
      encodeSummaryBlob({
        stepCount: 4,
        lastModSec: baseSec + 120,
        trajectoryType: 22,
        forkParentId: mainCid,
      })
    );
    insSum.run(
      emptySideCid,
      '',
      'CASCADE_RUN_STATUS_IDLE',
      '',
      2,
      '2026-11-18T00:01:30Z',
      encodeSummaryBlob({
        stepCount: 2,
        lastModSec: baseSec + 90,
        trajectoryType: 22,
        forkParentId: mainCid,
      })
    );
    // rpcOnlyCid is present in summaries, but has NO local .db file -> must fall back to GetCascadeTrajectory RPC!
    insSum.run(
      rpcOnlyCid,
      'Remote WSL Session',
      'CASCADE_RUN_STATUS_IDLE',
      '',
      1,
      '2026-11-18T00:00:30Z',
      encodeSummaryBlob({
        title: 'Remote WSL Session',
        stepCount: 1,
        lastModSec: baseSec + 30,
      })
    );
    sumDb.prepare('INSERT INTO conversation_parents (conversation_id, parent_id) VALUES (?, ?)').run(sideCid, mainCid);
    sumDb.close();

    const initConvDb = (cid, trajectoryType = 1) => {
      const db = new DatabaseSync(join(convDir, `${cid}.db`));
      db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
        CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
        CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      `);
      db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?, 1)').run(cid, cid, trajectoryType);
      return db;
    };

    // 2. Main conversation DB: 1 USER_INPUT ("设计混合 SQLite 读取") + 1 Carbon High response ($12.10, context 120k/256k)
    const mainDb = initConvDb(mainCid, 1);
    mainDb
      .prepare('INSERT INTO steps VALUES (0, 14, 3, ?, ?)')
      .run(
        encodeStepMeta({ createdSec: baseSec + 1, stepIndex: 0, originCascadeId: mainCid }),
        encodeUserInputPayload('设计混合 SQLite 读取')
      );
    mainDb
      .prepare('INSERT INTO steps VALUES (1, 15, 3, ?, ?)')
      .run(
        encodeStepMeta({
          createdSec: baseSec + 50,
          finishedSec: baseSec + 54,
          stepIndex: 1,
          originCascadeId: mainCid,
          modelEnumInt: 1429, // MODEL_PLACEHOLDER_M429 -> Carbon High ($2 + $0.1 + $10 = $12.10)
          inputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          outputTokens: 1_000_000,
          thinkingTokens: 400_000,
          responseTokens: 600_000,
        }),
        encodePlannerResponsePayload('这是混合架构方案。')
      );
    mainDb
      .prepare('INSERT INTO gen_metadata VALUES (0, ?)')
      .run(
        encodeGenMeta({
          stepIndex: 1,
          cascadeId: mainCid,
          responseModel: 'gemini-4-carbon-high',
          modelDisplayName: 'Gemini 4 Carbon (High)',
          estimatedTokensUsed: 120_000,
          maxContextTokens: 256_000,
          userMsgTokens: 120_000,
        })
      );
    mainDb.close();

    // 3. Regular subagent DB: 1 Flash 3.8 Low step ($0.30)
    const subDb = initConvDb(subCid, 1);
    subDb
      .prepare('INSERT INTO steps VALUES (0, 14, 3, ?, ?)')
      .run(
        encodeStepMeta({ createdSec: baseSec + 10, stepIndex: 0, originCascadeId: subCid }),
        encodeUserInputPayload('调研 SQLite WAL')
      );
    subDb
      .prepare('INSERT INTO steps VALUES (1, 15, 3, ?, ?)')
      .run(
        encodeStepMeta({
          createdSec: baseSec + 11,
          finishedSec: baseSec + 13,
          stepIndex: 1,
          originCascadeId: subCid,
          modelEnumInt: 1320, // MODEL_PLACEHOLDER_M320 -> $0.30/1M input
          inputTokens: 1_000_000,
        }),
        encodePlannerResponsePayload('WAL 调研完毕')
      );
    subDb.close();

    // 4. Side Question DB (trajectory_type = 22):
    // Contains 2 CLONED parent steps from mainCid ($12.10) + 1 own USER_INPUT + 1 own Flash 3.8 High step ($0.75)
    // Context watermark in Side Question is tiny (15k) and later than mainCid — must NOT overwrite mainCid's context!
    const sideDb = initConvDb(sideCid, 22);
    sideDb
      .prepare('INSERT INTO steps VALUES (0, 14, 3, ?, ?)')
      .run(
        encodeStepMeta({ createdSec: baseSec + 1, stepIndex: 0, originCascadeId: mainCid }),
        encodeUserInputPayload('设计混合 SQLite 读取')
      );
    sideDb
      .prepare('INSERT INTO steps VALUES (1, 15, 3, ?, ?)')
      .run(
        encodeStepMeta({
          createdSec: baseSec + 50,
          finishedSec: baseSec + 54,
          stepIndex: 1,
          originCascadeId: mainCid, // CLONED FROM PARENT! Must be filtered out!
          modelEnumInt: 1429,
          inputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          outputTokens: 1_000_000,
        }),
        encodePlannerResponsePayload('克隆的父回复')
      );
    sideDb
      .prepare('INSERT INTO steps VALUES (2, 14, 3, ?, ?)')
      .run(
        encodeStepMeta({ createdSec: baseSec + 80, stepIndex: 2, originCascadeId: sideCid }),
        encodeUserInputPayload('顺便问下为什么用 WAL？')
      );
    sideDb
      .prepare('INSERT INTO steps VALUES (3, 15, 3, ?, ?)')
      .run(
        encodeStepMeta({
          createdSec: baseSec + 81,
          finishedSec: baseSec + 83,
          stepIndex: 3,
          originCascadeId: sideCid,
          modelEnumInt: 1318, // MODEL_PLACEHOLDER_M318 -> $0.75/1M input
          inputTokens: 1_000_000,
        }),
        encodePlannerResponsePayload('因为只读不阻塞 checkpoint。')
      );
    sideDb
      .prepare('INSERT INTO gen_metadata VALUES (0, ?)')
      .run(
        encodeGenMeta({
          stepIndex: 1,
          cascadeId: mainCid, // Cloned gen_metadata from parent!
          responseModel: 'gemini-4-carbon-high',
          modelDisplayName: 'Gemini 4 Carbon (High)',
          estimatedTokensUsed: 120_000,
          maxContextTokens: 256_000,
          userMsgTokens: 120_000,
        })
      );
    sideDb
      .prepare('INSERT INTO gen_metadata VALUES (1, ?)')
      .run(
        encodeGenMeta({
          stepIndex: 3,
          cascadeId: sideCid,
          responseModel: 'gemini-3.8-flash-high',
          modelDisplayName: 'Gemini 3.8 Flash (High)',
          estimatedTokensUsed: 15_000,
          maxContextTokens: 256_000,
          userMsgTokens: 15_000,
        })
      );
    sideDb.close();

    // 5. Empty Side Question DB: only cloned parent steps, 0 own steps -> must be hidden!
    const emptySideDb = initConvDb(emptySideCid, 22);
    emptySideDb
      .prepare('INSERT INTO steps VALUES (0, 15, 3, ?, ?)')
      .run(
        encodeStepMeta({
          createdSec: baseSec + 2,
          finishedSec: baseSec + 6,
          stepIndex: 1,
          originCascadeId: mainCid,
          modelEnumInt: 1429,
          inputTokens: 1_000_000,
        }),
        null
      );
    emptySideDb.close();

    const execFileAsync = promisify(execFile);
    const builderUrl = new URL('../backend/telemetry-builder.mjs', import.meta.url).href;
    const { stdout: rawJson } = await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { buildTelemetryPayload } = await import(${JSON.stringify(builderUrl)});
         const p = await buildTelemetryPayload(${JSON.stringify(mainCid)}, false, { range: 'all' });
         process.stdout.write(JSON.stringify(p));`,
      ],
      {
        env: {
          ...process.env,
          ANTIGRAVITY_GEMINI_DIR: tempRoot,
          ANTIGRAVITY_APP_DATA_DIR: '',
          USAGE_MONITOR_APP_DATA_DIR: '',
          ANTIGRAVITY_EXECUTABLE_DATA_DIR: '',
          USAGE_MONITOR_DATA_DIR: join(tempRoot, 'sidecar-data'),
          ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${lsPort}`,
          ANTIGRAVITY_CSRF_TOKEN: 'test-csrf',
        },
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      }
    );

    const payload = JSON.parse(rawJson);

    // A. Verify RPC calls: ZERO GetAllCascadeTrajectories, ZERO GetCascadeTrajectory for local SQLite DBs,
    //    and exactly ONE GetCascadeTrajectory fallback for rpcOnlyCid!
    assert.equal(
      rpcCalls.some((c) => c.method === 'GetAllCascadeTrajectories'),
      false,
      'local conversation_summaries.db must eliminate GetAllCascadeTrajectories RPC'
    );
    const trajRpcTargets = rpcCalls
      .filter((c) => c.method === 'GetCascadeTrajectory')
      .map((c) => c.cascadeId);
    assert.deepEqual(
      trajRpcTargets,
      [rpcOnlyCid],
      'only conversation missing local .db falls back to GetCascadeTrajectory RPC'
    );

    // B. Top-level conversations list contains ONLY mainCid and rpcOnlyCid (no orphan/empty side questions or subagents)
    assert.deepEqual(
      payload.conversations.map((c) => c.cascadeId).sort(),
      [mainCid, rpcOnlyCid].sort()
    );

    // C. Verify Turn Rail prompt decoded directly from SQLite USER_INPUT step_payload
    const mainUnit = payload.activeConversation.agents.find((a) => a.isMain);
    assert.ok(mainUnit);
    assert.equal(payload.activeConversation.recentSteps[0].turnPrompt, '设计混合 SQLite 读取');

    // D. Verify agents under mainCid: [main, subagent #1, side question #1] (emptySideCid hidden!)
    const agents = payload.activeConversation.agents;
    assert.equal(agents.length, 3);
    assert.equal(agents[1].badgeText, '子1');
    assert.equal(Boolean(agents[1].isSideQuestion), false);
    assert.equal(agents[2].badgeText, '旁1');
    assert.equal(agents[2].isSideQuestion, true);
    assert.equal(agents[2].sideIndex, 1);
    assert.equal(agents[2].role, '为什么用 WAL 模式？');
    assert.equal(agents[2].stepCount, 1, 'cloned parent steps must be stripped from Side Question');
    assert.equal(agents[2].sessionCostUsd, 0.75, 'Side Question bills ONLY its own step ($0.75), never parent ($12.10)');

    // E. Verify total session & account costs have ZERO double-counting:
    // Session (main $12.10 + sub $0.30 + sideQ $0.75) = $13.15
    // Account (session $13.15 + rpcOnlyCid $0.30) = $13.45
    assert.equal(payload.activeConversation.aggregated.sessionCostUsd, 13.15);
    assert.equal(payload.consumption.account.costUsd, 13.45);
    assert.equal(payload.activeConversation.aggregated.role, '主代理 + 1 子代理 + 1 旁问');

    // F. Verify mainline context watermark protection (backend aggregated + frontend auto-follow)
    // Main agent has 3_000_000 tokens (1M in + 1M cache + 1M out), Side Question has 15_000/1_000_000
    assert.equal(payload.activeConversation.aggregated.activeAgentId, 'main');
    assert.equal(payload.activeConversation.aggregated.context.totalTokens, mainUnit.context.totalTokens);

    const scopedAuto = resolveScopedConversation(payload, 'all', 'auto', true);
    assert.equal(scopedAuto.ctxAgent.agentId, 'main', 'auto context inspector locks onto mainline agent');
    const scopedExplicitSide = resolveScopedConversation(payload, 'all', sideCid, false);
    assert.equal(scopedExplicitSide.ctxAgent.agentId, sideCid, 'explicitly selecting Side Question pill still inspects it');

    // G. Verify zh-CN & en-US badge and label formatting
    const prevLocale = i18nStore.getState().locale;
    try {
      i18nStore.setState({ locale: 'zh-CN', hostLocale: 'zh-CN' });
      assert.equal(formatAgentBadgeText(agents[2]), '旁1');
      assert.equal(formatAgentLabel(agents[2]), '旁路提问 #1 · 为什么用 WAL 模式？');

      i18nStore.setState({ locale: 'en-US', hostLocale: 'en-US' });
      assert.equal(formatAgentBadgeText(agents[1]), 'S1');
      assert.equal(formatAgentBadgeText(agents[2]), 'Q1');
      assert.equal(formatAgentLabel(agents[2]), 'Side Question #1 · 为什么用 WAL 模式？');
    } finally {
      i18nStore.setState({ locale: prevLocale });
    }
  } finally {
    await new Promise((resolve) => mockLsServer.close(resolve));
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('persistTrajectoryCacheIfNeeded throttles RUNNING disk writes to 30s and flushes immediately on IDLE or cache rebuild', () => {
  let now = 1_000_000;
  const scheduled = new Map();
  const h = backendHarness({
    cache: { live: { title: 'Cached session', steps: [] } },
    clock: () => now,
    timerApi: {
      setTimeout(_callback, delay) {
        const id = Symbol();
        scheduled.set(id, delay);
        return id;
      },
      clearTimeout(id) {
        scheduled.delete(id);
      },
    },
  });

  // 1st save (lastSavedAtMs === 0) flushes immediately even while running
  h.persistTrajectoryCacheIfNeeded({ hasRunningSessions: true, allowThrottleInTest: true });
  assert.equal(h.state.saves.length, 1);
  assert.equal(h.hasPendingTrajectoryCacheSave(), false);

  // Subsequent saves within 30s window while RUNNING are throttled in memory
  now += 2_000;
  h.persistTrajectoryCacheIfNeeded({ hasRunningSessions: true, allowThrottleInTest: true });
  now += 2_000;
  h.persistTrajectoryCacheIfNeeded({ hasRunningSessions: true, allowThrottleInTest: true });
  assert.equal(h.state.saves.length, 1, '2s polling during RUNNING must not rewrite disk every tick');
  assert.equal(h.hasPendingTrajectoryCacheSave(), true);
  assert.deepEqual([...scheduled.values()], [28_000]);

  // Transitioning to IDLE flushes immediately and clears pending timer
  now += 2_000;
  h.persistTrajectoryCacheIfNeeded({ hasRunningSessions: false, allowThrottleInTest: true });
  assert.equal(h.state.saves.length, 2, 'transition to IDLE flushes immediately');
  assert.equal(h.hasPendingTrajectoryCacheSave(), false);
  assert.equal(scheduled.size, 0);

  // Re-arming throttle then calling executeRebuildCacheAction cancels timer cleanly
  now += 2_000;
  h.persistTrajectoryCacheIfNeeded({ hasRunningSessions: true, allowThrottleInTest: true });
  assert.equal(scheduled.size, 1);
  h.state.cacheWriteError = new Error('Disk unavailable');
  assert.equal(h.executeRebuildCacheAction().status, 500);
  assert.equal(h.getCachedTrajectory('live').title, 'Cached session');
  assert.equal(h.hasPendingTrajectoryCacheSave(), true);
  assert.equal(scheduled.size, 1);

  h.state.cacheWriteError = null;
  const rebuildRes = h.executeRebuildCacheAction();
  assert.equal(rebuildRes.ok, true);
  assert.equal(scheduled.size, 0);
  assert.equal(h.hasPendingTrajectoryCacheSave(), false);
  assert.equal(h.listCachedTrajectoryEntries().length, 0);
  assert.deepEqual(h.state.saves.at(-1).data, {});
});

test('SQLite trajectory reader scans backwards past trailing plannerConfig-only gen_metadata rows to preserve pre-compaction tokenBreakdown', (t) => {
  const sqliteMod =
    typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null;
  if (!sqliteMod?.DatabaseSync) {
    t.skip('node:sqlite DatabaseSync unavailable');
    return;
  }
  const { DatabaseSync } = sqliteMod;
  const tempRoot = mkdtempSync(join(tmpdir(), 'agy-sqlite-compact-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  const cid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const dbPath = join(tempRoot, `${cid}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
  `);
  db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, 1, 1)').run(cid, cid);
  db.prepare('INSERT INTO steps VALUES (0, 15, 3, ?, NULL)').run(
    encodeStepMeta({
      createdSec: 1794960010,
      finishedSec: 1794960014,
      stepIndex: 0,
      originCascadeId: cid,
      modelEnumInt: 1429,
      inputTokens: 10000,
      cacheReadTokens: 110000,
      outputTokens: 500,
    })
  );
  // Step 1: CHECKPOINT compaction step (step_type = 23)
  db.prepare('INSERT INTO steps VALUES (1, 23, 3, ?, NULL)').run(
    encodeStepMeta({
      createdSec: 1794960020,
      finishedSec: 1794960024,
      stepIndex: 1,
      originCascadeId: cid,
      modelEnumInt: 1429,
      inputTokens: 10000,
      cacheReadTokens: 110000,
      outputTokens: 2400,
      thinkingTokens: 400,
      responseTokens: 2000,
    })
  );

  // gen_metadata[0] has the full tokenBreakdown, followed by 3 plannerConfig-only records [1..3]
  db.prepare('INSERT INTO gen_metadata VALUES (0, ?)').run(
    encodeGenMeta({
      stepIndex: 0,
      cascadeId: cid,
      responseModel: 'gemini-4-carbon-high',
      modelDisplayName: 'Gemini 4 Carbon (High)',
      estimatedTokensUsed: 120_000,
      maxContextTokens: 384_000,
      userMsgTokens: 120_000,
    })
  );
  const plannerOnlyBlob = encodeFieldBytes(3, encodeFieldBytes(28, 'gemini-4-carbon-high'));
  db.prepare('INSERT INTO gen_metadata VALUES (1, ?)').run(plannerOnlyBlob);
  db.prepare('INSERT INTO gen_metadata VALUES (2, ?)').run(plannerOnlyBlob);
  db.prepare('INSERT INTO gen_metadata VALUES (3, ?)').run(plannerOnlyBlob);
  db.close();

  const res = readLocalSqliteTrajectory(dbPath, { cascadeId: cid });
  assert.ok(res);
  assert.equal(res.steps.length, 2);
  assert.equal(res.steps[1].type, 'CORTEX_STEP_TYPE_CHECKPOINT');
  const gm0 = res.generatorMetadata.find((g) => g.stepIndices.includes(0));
  assert.ok(
    gm0?.chatModel?.chatStartMetadata?.contextWindowMetadata?.tokenBreakdown?.groups?.length > 0,
    'must decode tokenBreakdown on gen_metadata[0] even with 3 trailing plannerConfig-only records'
  );
});
