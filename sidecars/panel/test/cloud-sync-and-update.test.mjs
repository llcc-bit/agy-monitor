import test from 'node:test';
import assert from 'node:assert/strict';
import { backendHarness } from './backend-harness.mjs';

const createdAtMs = Date.now() - 20_000;
function makeStep(index, modelKey, responseModel = '') {
  return {
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      sourceTrajectoryStepInfo: { stepIndex: index },
      createdAt: new Date(createdAtMs).toISOString(),
      completedAt: new Date(createdAtMs + 5_000).toISOString(),
      modelUsage: {
        model: modelKey,
        ...(responseModel ? { responseModel } : {}),
        apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
        inputTokens: '100000',
        cacheReadTokens: '400000',
        outputTokens: '50000',
      },
    },
  };
}

test('sanitizeCatalogPayload filters malformed/null/zero entries, untrusted URLs, and preserves valid pricing', () => {
  const { sanitizeCatalogPayload } = backendHarness();
  assert.equal(sanitizeCatalogPayload(null), null);
  assert.equal(sanitizeCatalogPayload({ pricing: {} }), null);

  const sanitized = sanitizeCatalogPayload({
    schemaVersion: 1,
    catalogVersion: '2026.11.03.9',
    updatedAt: '2026-11-03T15:00:00Z',
    latestPluginVersion: '1.5.0',
    downloadUrl: 'https://evil.example.com/malware.zip',
    pricing: {
      'gemini-4.5-ultra': {
        input: 3.5,
        cache: 0.35,
        output: 15.0,
        short: 'ultra-4.5',
        family: 'Gemini',
        phases: [
          { until: '2026-12-01T00:00:00Z', input: 1.75, cache: 0.175, output: 7.5 },
          { from: '2026-12-01T00:00:00Z', input: 3.5, cache: 0.35, output: 15.0 },
          { until: 'not-a-date', input: 1.0, cache: 0.1, output: 5.0 },
          { from: '2026-12-10T00:00:00Z', until: '2026-12-01T00:00:00Z', input: 1.0, cache: 0.1, output: 5.0 },
          { input: 1.0, cache: 0.1, output: 5.0 },
          { until: '2026-12-01T00:00:00Z', input: -1, cache: 0.1, output: 5.0 },
          { until: '2026-12-01T00:00:00Z', input: 0, cache: 0, output: 0 },
          { until: '2026-12-01T00:00:00Z', input: '1.0', cache: 0.1, output: 5.0 },
        ],
      },
      'broken-negative': { input: -1, cache: 0.1, output: 5, short: 'bad', family: 'Gemini' },
      'broken-nan': { input: 'NaN', cache: 0.1, output: 5, short: 'bad', family: 'Gemini' },
      'broken-null': { input: null, cache: null, output: null, short: 'bad', family: 'Gemini' },
      'broken-zero': { input: 0, cache: 0, output: 0, short: 'bad', family: 'Gemini' },
      'broken-string-num': { input: '1.5', cache: 0.1, output: 5, short: 'bad', family: 'Gemini' },
      'broken-missing-short': { input: 1, cache: 0.1, output: 5, short: '', family: 'Gemini' },
    },
    placeholders: {
      MODEL_PLACEHOLDER_M999: { modelId: 'gemini-4.5-ultra', label: 'Gemini 4.5 Ultra' },
      MODEL_BROKEN: { modelId: '', label: 'Broken' },
    },
  });

  assert.ok(sanitized);
  assert.equal(sanitized.catalogVersion, '2026.11.03.9');
  assert.equal(sanitized.latestPluginVersion, '1.5.0');
  assert.ok(sanitized.downloadUrl.startsWith('https://github.com/llcc-bit/'));
  assert.deepEqual(Object.keys(sanitized.pricing), ['gemini-4.5-ultra']);
  assert.equal(sanitized.pricing['gemini-4.5-ultra'].phases.length, 2);
  assert.equal(sanitized.pricing['gemini-4.5-ultra'].phases[0].input, 1.75);
  assert.equal(sanitized.pricing['gemini-4.5-ultra'].phases[1].input, 3.5);
  assert.deepEqual(Object.keys(sanitized.placeholders), ['MODEL_PLACEHOLDER_M999']);
});

test('time-phased promotional pricing resolves exact rates across Carbon/Argon (Dec 1) and 3.6-3.8 Flash (Jan 1) boundaries while preserving historical costs and flat models', async () => {
  let now = Date.parse('2026-11-30T23:59:59.000Z');
  const makeTimedStep = (idx, model, isoStart, inTok = 1_000_000, cacheTok = 1_000_000, outTok = 1_000_000) => ({
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      sourceTrajectoryStepInfo: { stepIndex: idx },
      createdAt: isoStart,
      completedAt: new Date(Date.parse(isoStart) + 1_000).toISOString(),
      modelUsage: {
        model,
        apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
        inputTokens: String(inTok),
        cacheReadTokens: String(cacheTok),
        outputTokens: String(outTok),
      },
    },
  });

  const steps = [
    // Step 1: Carbon High right before Nov 30 cutoff -> $2.0 + $0.1 + $10.0 = $12.10 (saved: $1.90)
    makeTimedStep(1, 'MODEL_PLACEHOLDER_M429', '2026-11-30T23:59:59.999Z'),
    // Step 2: Carbon High at exact Dec 1 cutoff -> $4.0 + $0.2 + $20.0 = $24.20 (saved: $3.80)
    makeTimedStep(2, 'MODEL_PLACEHOLDER_M429', '2026-12-01T00:00:00.000Z'),
    // Step 3: Orchestrator (Argon) in Nov promo -> $2.0 + $0.1 + $10.0 = $12.10
    makeTimedStep(3, 'MODEL_PLACEHOLDER_M681', '2026-11-20T10:00:00.000Z'),
    // Step 4: Orchestrator (Argon) in Dec standard -> $4.0 + $0.2 + $20.0 = $24.20
    makeTimedStep(4, 'MODEL_PLACEHOLDER_M681', '2026-12-05T10:00:00.000Z'),
    // Step 5: Gemini 3.8 Flash (High) in Dec (still promo!) -> $0.75 + $0.075 + $3.75 = $4.575
    makeTimedStep(5, 'MODEL_PLACEHOLDER_M318', '2026-12-31T23:59:59.999Z'),
    // Step 6: Gemini 3.8 Flash (High) on Jan 1, 2027 (standard!) -> $1.50 + $0.15 + $7.50 = $9.15
    makeTimedStep(6, 'MODEL_PLACEHOLDER_M318', '2027-01-01T00:00:00.000Z'),
    // Step 7: Gemini 3.8 Flash (Low) in Jan 2027 (flat, no doubling!) -> $0.30 + $0.03 + $2.50 = $2.83
    makeTimedStep(7, 'MODEL_PLACEHOLDER_M320', '2027-01-15T00:00:00.000Z'),
    // Step 8: Gemini 3.5 Flash in Nov 2026 (no half-price promo!) -> $1.50 + $0.15 + $9.00 = $10.65
    makeTimedStep(8, 'MODEL_PLACEHOLDER_M149', '2026-11-17T00:00:00.000Z'),
    // Step 9: Gemini 3.6 Flash in Jan 2027 -> $1.50 + $0.15 + $7.50 = $9.15
    makeTimedStep(9, 'MODEL_PLACEHOLDER_M71', '2027-01-02T00:00:00.000Z'),
    // Step 10: Gemini 3.7 Flash in Nov 2026 -> $0.75 + $0.075 + $3.75 = $4.575
    makeTimedStep(10, 'MODEL_PLACEHOLDER_M298', '2026-11-17T00:00:00.000Z'),
  ];

  // Advance clock to 2027-01-20: historical Nov & Dec steps must NOT be overwritten with 2027 rates!
  now = Date.parse('2027-01-20T12:00:00Z');
  const h = backendHarness({
    clock: () => now,
    summaries: { convPhase: { stepCount: steps.length, lastModifiedTime: '2027-01-15T00:00:01Z' } },
    trajectories: { convPhase: { trajectory: { steps } } },
  });

  // Direct resolveModelInfo without timestamp uses current clock (2027-01-20 -> post-promo for all phased models)
  assert.equal(h.resolveModelInfo('MODEL_PLACEHOLDER_M429').pricing.input, 4.0);
  assert.equal(h.resolveModelInfo('MODEL_PLACEHOLDER_M417').pricing.output, 20.0);
  assert.equal(h.resolveModelInfo('MODEL_PLACEHOLDER_M318').pricing.input, 1.5);
  assert.equal(h.resolveModelInfo('MODEL_PLACEHOLDER_M318').pricing.output, 7.5);
  // Explicit historical timestamp still resolves promo pricing
  assert.equal(
    h.resolveModelInfo('MODEL_PLACEHOLDER_M429', new Map(), '', '', '', '2026-11-17T00:00:00Z').pricing.input,
    2.0
  );
  assert.equal(
    h.resolveModelInfo('MODEL_PLACEHOLDER_M318', new Map(), '', '', '', '2026-12-15T00:00:00Z').pricing.input,
    0.75
  );

  // computeStepCost honors step timestamp even when passed post-promo pricing object
  const postPromoCarbonPricing = h.resolveModelInfo('MODEL_PLACEHOLDER_M429').pricing;
  assert.equal(
    h.computeStepCost(
      { createdAtMs: Date.parse('2026-11-15T00:00:00Z'), inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 },
      postPromoCarbonPricing
    ),
    2.0
  );
  assert.equal(
    h.computeStepCost(
      { createdAtMs: Date.parse('2026-12-15T00:00:00Z'), inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 },
      postPromoCarbonPricing
    ),
    4.0
  );

  const p = await h.buildTelemetryPayloadInternal('convPhase');
  const byIdx = new Map(p.activeConversation.recentSteps.map((s) => [s.stepIndex, s]));

  assert.equal(byIdx.get(1).costUsd, 12.1);
  assert.equal(byIdx.get(1).inCostUsd, 2.0);
  assert.equal(byIdx.get(1).cacheCostUsd, 0.1);
  assert.equal(byIdx.get(1).outCostUsd, 10.0);

  assert.equal(byIdx.get(2).costUsd, 24.2);
  assert.equal(byIdx.get(2).inCostUsd, 4.0);
  assert.equal(byIdx.get(2).cacheCostUsd, 0.2);
  assert.equal(byIdx.get(2).outCostUsd, 20.0);

  assert.equal(byIdx.get(3).costUsd, 12.1);
  assert.equal(byIdx.get(4).costUsd, 24.2);
  assert.equal(byIdx.get(5).costUsd, 4.575);
  assert.equal(byIdx.get(6).costUsd, 9.15);
  assert.equal(byIdx.get(7).costUsd, 2.83);
  assert.equal(byIdx.get(8).costUsd, 10.65);
  assert.equal(byIdx.get(9).costUsd, 9.15);
  assert.equal(byIdx.get(10).costUsd, 4.575);

  // Total across all 10 steps = 12.1 + 24.2 + 12.1 + 24.2 + 4.575 + 9.15 + 2.83 + 10.65 + 9.15 + 4.575 = 113.53
  assert.equal(p.activeConversation.sessionCostUsd, 113.53);
  assert.equal(p.consumption.account.costUsd, 113.53);

  // Verify getPricingPhaseEpoch advances across boundaries (0 -> 1 -> 2) and invalidates cached snapshots for timestamp-less steps
  assert.equal(h.getPricingPhaseEpoch(Date.parse('2026-11-30T23:59:59Z')), 0);
  assert.equal(h.getPricingPhaseEpoch(Date.parse('2026-12-15T00:00:00Z')), 1);
  assert.equal(h.getPricingPhaseEpoch(Date.parse('2027-01-01T00:00:00Z')), 2);

  let dynamicClock = Date.parse('2026-11-30T23:59:59Z');
  const hBoundary = backendHarness({
    clock: () => dynamicClock,
    summaries: { cZeroTs: { stepCount: 1 } },
    cache: {
      cZeroTs: {
        signature: 'v10-model-identity:disk:0',
        contextLimitTelemetry: true,
        turnRailTelemetry: true,
        contextGroupsTelemetry: true,
        speedClearedTelemetry: true,
        subagentRefs: [],
        steps: [
          {
            stepIndex: 1,
            createdAtMs: 0,
            modelKey: 'MODEL_PLACEHOLDER_M429',
            modelIdentityVersion: 1,
            modelSource: 'usage.model',
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
            inputTokens: 1_000_000,
            cacheReadTokens: 0,
            outputTokens: 0,
            thinkingTokens: 0,
            responseTokens: 0,
          },
        ],
      },
    },
  });
  const beforeCutoff = await hBoundary.buildTelemetryPayloadInternal('cZeroTs');
  assert.equal(beforeCutoff.activeConversation.latestStepCostUsd, 2.0);
  assert.equal(beforeCutoff.consumption.account.costUsd, 2.0);

  dynamicClock = Date.parse('2026-12-01T00:00:01Z');
  const afterCutoff = await hBoundary.buildTelemetryPayloadInternal('cZeroTs');
  assert.equal(afterCutoff.activeConversation.latestStepCostUsd, 4.0);
  assert.equal(afterCutoff.consumption.account.costUsd, 4.0);
});

test('cloud catalog sync fetches from GitHub raw URL and dynamically prices newly pushed models', async () => {
  const step = makeStep(1, 'MODEL_PLACEHOLDER_M888');
  let fetchedUrl = '';

  const h = backendHarness({
    pluginManifest: { name: 'usage-monitor', version: '1.4.0' },
    summaries: { conv1: { stepCount: 1 } },
    trajectories: { conv1: { trajectory: { steps: [step] } } },
    remoteFetch: async (url) => {
      fetchedUrl = String(url);
      return {
        ok: true,
        json: async () => ({
          schemaVersion: 1,
          catalogVersion: '2026.11.03.2',
          updatedAt: '2026-11-03T16:00:00Z',
          latestPluginVersion: '1.5.0',
          pricing: {
            'gemini-5-nova': { input: 4.0, cache: 0.4, output: 20.0, short: 'nova-5', family: 'Gemini' },
          },
          placeholders: {
            MODEL_PLACEHOLDER_M888: { modelId: 'gemini-5-nova', label: 'Gemini 5 Nova' },
          },
        }),
      };
    },
  });

  // Before cloud sync: M888 is unknown and unpriced
  const before = await h.buildTelemetryPayloadInternal('conv1');
  assert.equal(before.activeConversation.activeModelShort, 'MODEL_PLACEHOLDER_M888');
  assert.equal(before.activeConversation.latestStepCostUsd, null);
  assert.equal(before.consumption.account.unpricedCalls, 1);
  assert.equal(before.cloudStatus.updateAvailable, false);

  // Sync cloud catalog from GitHub
  const syncStatus = await h.syncCloudCatalog({ force: true });
  assert.ok(fetchedUrl.startsWith('https://raw.githubusercontent.com/llcc-bit/agy-monitor/main/pricing-catalog.json'));
  assert.equal(syncStatus.source, 'remote');
  assert.equal(syncStatus.catalogVersion, '2026.11.03.2');
  assert.equal(syncStatus.latestPluginVersion, '1.5.0');
  assert.equal(syncStatus.updateAvailable, true);

  // Immediately re-evaluate payload: M888 is now resolved and priced without clearing trajectoryCache
  const after = await h.buildTelemetryPayloadInternal('conv1');
  assert.equal(after.activeConversation.activeModelShort, 'nova-5');
  assert.equal(after.activeConversation.activeModelLabel, 'Gemini 5 Nova');
  // Cost = 0.1M * $4.0 + 0.4M * $0.4 + 0.05M * $20.0 = 0.4 + 0.16 + 1.0 = $1.56
  assert.equal(after.activeConversation.latestStepCostUsd, 1.56);
  assert.equal(after.consumption.account.unpricedCalls, 0);
  assert.equal(after.consumption.account.costUsd, 1.56);
});

test('resolveModelInfo falls back to responseModel when placeholder enum is unmapped', async () => {
  const step = makeStep(1, 'MODEL_PLACEHOLDER_M777', 'gemini-4-argon-high');
  const h = backendHarness({
    summaries: { conv1: { stepCount: 1 } },
    trajectories: { conv1: { trajectory: { steps: [step] } } },
  });
  const p = await h.buildTelemetryPayloadInternal('conv1');
  assert.equal(p.activeConversation.activeModelShort, 'argon-4-high');
  assert.equal(p.consumption.account.unpricedCalls, 0);
  assert.ok(p.activeConversation.latestStepCostUsd > 0);
});

test('performPluginUpdate blocks overwriting dirty worktrees (including untracked ?? files) without stashing', async () => {
  for (const [rootPath, porcelainOutput] of [
    ['/workspace/agy-monitor', ' M sidecars/panel/main.mjs\n'],
    ['/Users/test/.gemini/config/plugins/agy-monitor', '?? sidecars/panel/backend/config.mjs\n'],
  ]) {
    const gitCalls = [];
    const h = backendHarness({
      hasGitDir: true,
      pluginRootPath: rootPath,
      pluginManifest: { name: 'usage-monitor', version: '1.4.0' },
      execFileImpl: (_cmd, args, opts, cb) => {
        const fn = typeof opts === 'function' ? opts : cb;
        gitCalls.push(args);
        if (args.includes('status')) {
          assert(!args.includes('--untracked-files=no'), 'must inspect untracked files too');
          fn(null, porcelainOutput, '');
          return;
        }
        fn(null, '', '');
      },
    });

    const res = await h.performPluginUpdate({ isAuto: false });
    assert.equal(res.ok, false);
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'dirty_worktree');
    assert.equal(gitCalls.length, 1);
    assert(!gitCalls.some((args) => args.includes('stash')));
  }
});

test('performPluginUpdate blocks non-main branches and diverged git history', async () => {
  const branchH = backendHarness({
    hasGitDir: true,
    pluginRootPath: '/Users/test/.gemini/config/plugins/usage-monitor',
    pluginManifest: { name: 'usage-monitor', version: '1.4.0' },
    execFileImpl: (_cmd, args, opts, cb) => {
      const fn = typeof opts === 'function' ? opts : cb;
      if (args.includes('rev-parse')) {
        fn(null, 'fix/humanize-copy-strings\n', '');
        return;
      }
      fn(null, '', '');
    },
  });
  const branchRes = await branchH.performPluginUpdate({ isAuto: false });
  assert.equal(branchRes.ok, false);
  assert.equal(branchRes.reason, 'not_on_main_branch');

  const divergedH = backendHarness({
    hasGitDir: true,
    pluginRootPath: '/Users/test/.gemini/config/plugins/usage-monitor',
    pluginManifest: { name: 'usage-monitor', version: '1.3.0' },
    execFileImpl: (_cmd, args, opts, cb) => {
      const fn = typeof opts === 'function' ? opts : cb;
      if (args.includes('rev-parse')) {
        fn(null, 'main\n', '');
        return;
      }
      if (args.includes('show')) {
        fn(null, JSON.stringify({ name: 'usage-monitor', version: '1.4.0' }), '');
        return;
      }
      if (args.includes('merge-base')) {
        fn(new Error('not ancestor'));
        return;
      }
      fn(null, '', '');
    },
  });
  const divRes = await divergedH.performPluginUpdate({ isAuto: false });
  assert.equal(divRes.ok, false);
  assert.equal(divRes.reason, 'diverged_worktree');
});

test('performPluginUpdate refuses to downgrade or pull when remote version is older, equal, or unreadable', async () => {
  for (const showOutput of [
    JSON.stringify({ name: 'usage-monitor', version: '1.2.0' }),
    JSON.stringify({ name: 'usage-monitor', version: '1.4.0' }),
    '', // git show failed or empty — must NOT fall back to cloudSyncState.latestPluginVersion
  ]) {
    const gitCalls = [];
    const h = backendHarness({
      hasGitDir: true,
      pluginRootPath: '/Users/test/.gemini/config/plugins/usage-monitor',
      pluginManifest: { name: 'usage-monitor', version: '1.4.0' },
      remoteCatalog: {
        schemaVersion: 1,
        catalogVersion: '2026.11.03.9',
        updatedAt: '2026-11-03T18:00:00Z',
        latestPluginVersion: '1.9.0',
        pricing: { 'gemini-4-argon': { input: 2, cache: 0.1, output: 10, short: 'argon-4', family: 'Gemini' } },
      },
      execFileImpl: (_cmd, args, opts, cb) => {
        const fn = typeof opts === 'function' ? opts : cb;
        gitCalls.push(args);
        if (args.includes('rev-parse')) {
          fn(null, 'main\n', '');
          return;
        }
        if (args.includes('show')) {
          if (!showOutput) {
            fn(new Error('fatal: Path plugin.json does not exist'));
            return;
          }
          fn(null, showOutput, '');
          return;
        }
        fn(null, '', '');
      },
    });

    const res = await h.performPluginUpdate({ isAuto: false });
    assert.equal(res.ok, false);
    assert.equal(res.skipped, true);
    assert.equal(res.upToDate, true);
    assert.equal(res.reason, 'already_up_to_date');
    assert.equal(res.currentVersion, '1.4.0');
    assert(!gitCalls.some((args) => args.includes('pull')));
  }
});

test('performPluginUpdate pulls fast-forward when git worktree is clean, on main, ancestor, and remote version is newer', async () => {
  const gitCalls = [];
  const h = backendHarness({
    hasGitDir: true,
    pluginRootPath: '/Users/test/.gemini/config/plugins/usage-monitor',
    pluginManifest: { name: 'usage-monitor', version: '1.3.1' },
    execFileImpl: (_cmd, args, opts, cb) => {
      const fn = typeof opts === 'function' ? opts : cb;
      gitCalls.push(args);
      if (args.includes('rev-parse')) {
        fn(null, 'main\n', '');
        return;
      }
      if (args.includes('show')) {
        fn(null, JSON.stringify({ name: 'usage-monitor', version: '1.4.0' }), '');
        return;
      }
      if (args.includes('pull')) {
        h.state.pluginManifest = { name: 'usage-monitor', version: '1.4.0' };
      }
      fn(null, '', '');
    },
  });

  const res = await h.performPluginUpdate({ isAuto: false });
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'git');
  assert.equal(res.previousVersion, '1.3.1');
  assert.equal(res.currentVersion, '1.4.0');
  assert.equal(gitCalls.length, 7); // status, rev-parse, remote get-url, fetch, show, merge-base, pull
});

test('repository migration: scrubs legacy yuhuan2498281558 cache URLs/TTL and migrates git origin remote to yuhuan-dev', async () => {
  let fetchedNewRepoUrl = '';
  const cacheH = backendHarness({
    pluginManifest: { name: 'usage-monitor', version: '1.4.4' },
    remoteCatalog: {
      schemaVersion: 1,
      catalogVersion: '2026.11.11.4',
      updatedAt: '2026-11-11T23:20:00+09:00',
      latestPluginVersion: '1.4.4',
      releaseUrl: 'https://github.com/yuhuan2498281558/antigravity-usage-monitor/releases/latest',
      downloadUrl: 'https://github.com/yuhuan2498281558/antigravity-usage-monitor/releases/latest/download/usage-monitor.zip',
      archiveFallbackUrl: 'https://codeload.github.com/yuhuan2498281558/antigravity-usage-monitor/zip/refs/heads/main',
      sourceUrl: 'https://raw.githubusercontent.com/yuhuan2498281558/antigravity-usage-monitor/main/pricing-catalog.json',
      fetchedAtMs: Date.now() - 60_000,
      pricing: {
        'gemini-4-carbon-high': { input: 2.0, cache: 0.1, output: 10.0, short: 'carbon-4-high', family: 'Gemini' },
      },
    },
    remoteFetch: async (url) => {
      fetchedNewRepoUrl = String(url);
      return {
        ok: true,
        json: async () => ({
          schemaVersion: 1,
          catalogVersion: '2026.11.12.1',
          updatedAt: '2026-11-12T10:00:00+09:00',
          latestPluginVersion: '1.4.5',
          pricing: {
            'gemini-4-carbon-high': { input: 2.0, cache: 0.1, output: 10.0, short: 'carbon-4-high', family: 'Gemini' },
          },
        }),
      };
    },
  });

  const initialStatus = cacheH.getCloudStatus();
  assert.equal(initialStatus.releaseUrl, 'https://github.com/llcc-bit/agy-monitor/releases/latest');
  assert.equal(initialStatus.downloadUrl, 'https://github.com/llcc-bit/agy-monitor/releases/latest/download/agy-monitor.zip');
  assert.equal(initialStatus.lastSyncedAtMs, 0, 'legacy repo cache TTL must be invalidated so new repo syncs immediately');

  const synced = await cacheH.syncCloudCatalog({ force: false });
  assert.equal(
    fetchedNewRepoUrl,
    'https://raw.githubusercontent.com/llcc-bit/agy-monitor/main/pricing-catalog.json'
  );
  assert.equal(synced.catalogVersion, '2026.11.12.1');
  assert.equal(synced.latestPluginVersion, '1.4.5');

  assert.equal(
    cacheH.resolveMigratedGitRemoteUrl('https://github.com/yuhuan2498281558/antigravity-usage-monitor.git'),
    'https://github.com/llcc-bit/agy-monitor.git'
  );
  assert.equal(
    cacheH.resolveMigratedGitRemoteUrl('git@github.com:yuhuan2498281558/antigravity-usage-monitor.git'),
    'git@github.com:llcc-bit/agy-monitor.git'
  );
  assert.equal(
    cacheH.resolveMigratedGitRemoteUrl('https://github.com/custom-fork/antigravity-usage-monitor.git'),
    ''
  );

  const gitCalls = [];
  const migrateH = backendHarness({
    hasGitDir: true,
    pluginRootPath: '/Users/test/.gemini/config/plugins/agy-monitor',
    pluginManifest: { name: 'agy-monitor', version: '1.4.3' },
    execFileImpl: (_cmd, args, opts, cb) => {
      const fn = typeof opts === 'function' ? opts : cb;
      gitCalls.push(args);
      if (args.includes('rev-parse')) {
        fn(null, 'main\n', '');
        return;
      }
      if (args.includes('remote') && args.includes('get-url')) {
        fn(null, 'https://github.com/yuhuan2498281558/antigravity-usage-monitor.git\n', '');
        return;
      }
      if (args.includes('show')) {
        fn(null, JSON.stringify({ name: 'agy-monitor', version: '1.4.4' }), '');
        return;
      }
      if (args.includes('pull')) {
        migrateH.state.pluginManifest = { name: 'agy-monitor', version: '1.4.4' };
      }
      fn(null, '', '');
    },
  });

  const updRes = await migrateH.performPluginUpdate({ isAuto: false });
  assert.equal(updRes.ok, true);
  assert.equal(updRes.currentVersion, '1.4.4');
  const setUrlCall = gitCalls.find((args) => args.includes('remote') && args.includes('set-url'));
  assert.ok(setUrlCall, 'must run git remote set-url origin before fetching');
  assert.equal(setUrlCall[setUrlCall.length - 1], 'https://github.com/llcc-bit/agy-monitor.git');
});

test('pluginUpdateMode supports off (default), manual, and auto with legacy autoUpdatePlugin compatibility', async () => {
  const defaultH = backendHarness();
  assert.equal(defaultH.loadSettings().pluginUpdateMode, 'off');
  assert.equal(defaultH.loadSettings().autoUpdatePlugin, false);

  const manualRes = defaultH.executeSettingsAction({ pluginUpdateMode: 'manual' });
  assert.equal(manualRes.updated.pluginUpdateMode, 'manual');
  assert.equal(manualRes.updated.autoUpdatePlugin, false);

  const legacyAutoH = backendHarness({ settings: { autoUpdatePlugin: true } });
  assert.equal(legacyAutoH.loadSettings().pluginUpdateMode, 'auto');
  assert.equal(legacyAutoH.loadSettings().autoUpdatePlugin, true);

  const offSettings = {};
  let gitTriggered = false;
  const offH = backendHarness({
    settings: offSettings,
    hasGitDir: true,
    pluginRootPath: '/Users/test/.gemini/config/plugins/usage-monitor',
    pluginManifest: { name: 'usage-monitor', version: '1.4.0' },
    remoteFetch: async () => ({
      ok: true,
      json: async () => ({
        schemaVersion: 1,
        catalogVersion: '2026.11.11.9',
        updatedAt: '2026-11-11T22:00:00+09:00',
        latestPluginVersion: '1.5.0',
        pricing: {
          'gemini-4-argon': { input: 2.0, cache: 0.1, output: 10.0, short: 'argon-4', family: 'Gemini' },
        },
      }),
    }),
    execFileImpl: (_cmd, _args, opts, cb) => {
      gitTriggered = true;
      const fn = typeof opts === 'function' ? opts : cb;
      fn(null, '', '');
    },
  });

  const saveOff = offH.executeSettingsAction({ pluginUpdateMode: 'off' }).updated;
  assert.equal(saveOff.pluginUpdateMode, 'off');
  assert.equal(saveOff.autoUpdatePlugin, false);
  Object.assign(offSettings, saveOff);

  await offH.syncCloudCatalog({ force: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(gitTriggered, false, 'pluginUpdateMode=off must never trigger auto update');

  const saveAuto = offH.executeSettingsAction({ pluginUpdateMode: 'auto' }).updated;
  assert.equal(saveAuto.pluginUpdateMode, 'auto');
  assert.equal(saveAuto.autoUpdatePlugin, true);
  Object.assign(offSettings, saveAuto);

  await offH.syncCloudCatalog({ force: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(gitTriggered, true, 'pluginUpdateMode=auto triggers background update check');
});

test('argon-b / argon-trial deployment shards resolve phased pricing without wildcarding unknown single-letter suffixes, and custom Git forks suppress upstream update badges', async () => {
  const hPromo = backendHarness({ clock: () => Date.parse('2026-11-20T00:00:00Z') });
  for (const shardSlug of ['gemini-4-argon-b', 'gemini-4-argon-trial']) {
    const promoInfo = hPromo.resolveModelInfo(shardSlug);
    assert.equal(promoInfo.label, 'Gemini 4 Argon');
    assert.equal(promoInfo.shortName, 'argon-4');
    assert.equal(promoInfo.pricing.input, 2.0);
    assert.equal(promoInfo.pricing.output, 10.0);

    const postInfo = hPromo.resolveModelInfo(shardSlug, new Map(), '', '', '', '2026-12-05T00:00:00Z');
    assert.equal(postInfo.pricing.input, 4.0);
    assert.equal(postInfo.pricing.output, 20.0);
  }

  // Unverified single-letter shard must NOT recklessly fall back to base model pricing
  const unknownShard = hPromo.resolveModelInfo('gemini-4-argon-z');
  assert.equal(unknownShard.pricing, null);

  // Custom Git fork: upstream cloud catalog sync updates model pricing, while suppressing upstream version badge
  const forkH = backendHarness({
    hasGitDir: true,
    gitConfigText: '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/custom-contributor/antigravity-usage-monitor.git\n',
    pluginManifest: { name: 'usage-monitor', version: '1.5.0' },
    remoteFetch: async () => ({
      ok: true,
      json: async () => ({
        schemaVersion: 1,
        catalogVersion: '2026.12.10.1',
        updatedAt: '2026-12-10T10:00:00Z',
        latestPluginVersion: '1.9.0',
        pricing: {
          'gemini-5-experimental': {
            input: 6.0,
            cache: 0.3,
            output: 30.0,
            short: 'gem-5-exp',
            family: 'Gemini',
          },
        },
      }),
    }),
  });

  assert.equal(forkH.detectCustomGitForkRepo(), 'custom-contributor/antigravity-usage-monitor');
  const statusAfterSync = await forkH.syncCloudCatalog({ force: true });
  assert.equal(statusAfterSync.catalogVersion, '2026.12.10.1');
  assert.equal(statusAfterSync.updateAvailable, false, 'custom fork must not show false update badge from upstream repo');
  assert.equal(statusAfterSync.latestPluginVersion, '1.5.0');
  assert.equal(
    statusAfterSync.releaseUrl,
    'https://github.com/custom-contributor/antigravity-usage-monitor/releases/latest'
  );
  assert.equal(forkH.resolveModelInfo('gemini-5-experimental').pricing.input, 6.0);
});
