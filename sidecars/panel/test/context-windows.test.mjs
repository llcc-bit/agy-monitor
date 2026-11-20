import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createContextWindowSyncExpression } from '../backend/context-windows.mjs';
import { backendHarness } from './backend-harness.mjs';

const argon = 'MODEL_PLACEHOLDER_M430';
const flash = 'MODEL_PLACEHOLDER_M431';
const other = 'MODEL_PLACEHOLDER_M432';
const carbon = 'MODEL_PLACEHOLDER_M427';
const carbonLow = 'MODEL_PLACEHOLDER_M438';
const newCarbonLow = 'MODEL_PLACEHOLDER_M439';
const carbonGroup = 'model:gemini-4-carbon';
const availableModels = {
  'gemini-4-carbon-high': { model: carbon, maxTokens: 1048576, maxOutputTokens: 262144 },
  'gemini-4-carbon-low': { model: carbonLow, maxTokens: 700000, maxOutputTokens: 64000 },
  'gemini-other': { model: other, maxTokens: 250000, maxOutputTokens: 64000 },
};
const carbonModels = [
  { label: 'Gemini 4 Carbon (High)', modelId: 'gemini-4-carbon-high', modelOrAlias: { model: carbon } },
  { label: 'Gemini 4 Carbon (Low)', modelId: 'gemini-4-carbon-low', modelOrAlias: { model: carbonLow } },
];

test('saves and restores one model at a time using host presets or verified model capacity', async () => {
  const h = backendHarness({
    settings: { contextLimitOverrideTokens: 900000 },
    availableModels,
    userStatus: {
      cascadeModelConfigData: {
        clientModelConfigs: [
          { label: 'Argon', modelOrAlias: { model: argon },
            contextWindowOptions: [{ name: '512K' }, { name: '900K', expensive: true }] },
          { label: 'Flash', modelOrAlias: { model: flash }, contextWindowOptions: [{ name: '256K' }] },
          { label: 'Other', modelOrAlias: { model: other } },
          ...carbonModels,
        ],
      },
    },
  });
  const update = h.executeModelContextWindowAction;
  const { contextWindowModels } = await h.buildTelemetryPayloadInternal('');
  const [argonModel, flashModel, otherModel, carbonModel] = JSON.parse(JSON.stringify(contextWindowModels));
  assert.deepEqual(argonModel.options, [{ name: '512K', expensive: false }, { name: '900K', expensive: true }]);
  assert.deepEqual(flashModel.options, [{ name: '256K', expensive: false }]);
  assert.deepEqual(otherModel.options.map(({ tokens }) => tokens), [128000, 186000]);
  assert.equal(carbonModel.id, carbonGroup);
  assert.equal(carbonModel.label, 'Gemini 4 Carbon');
  assert.deepEqual(carbonModel.members, [carbon, carbonLow]);
  assert.deepEqual(carbonModel.options.map(({ tokens }) => tokens), [128000, 256000, 384000, 512000, 636000]);
  assert.equal((await update({ modelId: carbonGroup, option: '768000' })).status, 400);
  h.state.settings.modelContextWindows = { [carbon]: '768000', [carbonLow]: '256000' };
  assert.equal((await update({ modelId: carbonGroup, option: '384000' })).status, 200);
  assert.deepEqual({ ...h.loadSettings().modelContextWindows }, { [carbonGroup]: '384000' });
  assert.equal((await update({ modelId: carbonGroup, option: '512000' })).status, 200);
  assert.deepEqual({ ...h.loadSettings().modelContextWindows }, { [carbonGroup]: '512000' });
  assert.equal((await update({ modelId: carbonGroup, option: null })).status, 200);
  assert.equal((await update({ modelId: flash, option: '900K' })).status, 400);
  assert.equal((await update({ modelId: other, option: '900K' })).status, 400);
  assert.equal((await update({ modelId: '__proto__', option: null })).status, 400);
  assert.deepEqual({ ...h.loadSettings().modelContextWindows }, {});

  const [a, b] = await Promise.all([
    update({ modelId: argon, option: '900K' }),
    update({ modelId: flash, option: '256K' }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual({ ...h.loadSettings().modelContextWindows }, { [argon]: '900K', [flash]: '256K' });
  assert.equal((await update({ modelId: argon, option: null })).status, 200);
  assert.deepEqual({ ...h.loadSettings().modelContextWindows }, { [flash]: '256K' });
  h.executeResetSettingsAction();
  assert.deepEqual({ ...h.loadSettings().modelContextWindows }, {});
});

test('reports the latest observed threshold separately from the saved group preference', async () => {
  const h = backendHarness({
    availableModels,
    settings: { modelContextWindows: { [carbonGroup]: '512000' } },
    userStatus: { cascadeModelConfigData: { clientModelConfigs: carbonModels } },
    summaries: { active: { stepCount: 1, lastModifiedTime: '2026-01-01T00:00:01Z', status: 'IDLE' } },
    trajectories: {
      active: { trajectory: {
        steps: [{ metadata: {
          createdAt: '2026-01-01T00:00:00Z',
          finishedGeneratingAt: '2026-01-01T00:00:01Z',
          modelUsage: { model: carbonLow, inputTokens: 20, outputTokens: 20 },
        }, plannerResponse: { response: 'ok' } }],
        generatorMetadata: [{ stepIndices: [0], chatModel: {
          chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } },
        } }],
      } },
    },
  });
  const result = await h.buildTelemetryPayloadInternal('active');
  assert.equal(result.contextWindowModels.find(({ id }) => id === carbonGroup).reportedLimitTokens, 256000);
  assert.equal(result.settings.modelContextWindows[carbonGroup], '512000');
  const previouslyCached = h.state.saves.find(({ data }) => data.active?.contextLimitTelemetry).data.active;
  const cached = structuredClone(previouslyCached);
  delete cached.contextLimitTelemetry;
  delete cached.steps[0].reportedContextLimitTokens;
  const upgraded = backendHarness({
    availableModels,
    userStatus: h.state.userStatus,
    cache: { active: cached },
    summaries: { active: { stepCount: 1, lastModifiedTime: '2026-01-01T00:00:01Z', status: 'IDLE' } },
    trajectories: h.state.trajectories,
  });
  const reloaded = await upgraded.buildTelemetryPayloadInternal('active');
  assert.equal(reloaded.contextWindowModels[0].reportedLimitTokens, 256000);
});

test('host requests apply a rule only to the exact model across App and IDE transports', async () => {
  const sendPath = '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage';
  const statusPath = sendPath.replace('SendUserCascadeMessage', 'GetUserStatus');
  const host = 'https://127.0.0.1:25190';
  let catalog = availableModels;
  let variants = carbonModels;
  const nativeFetch = async (url, init) => {
    if (url === host + statusPath.replace('GetUserStatus', 'GetAvailableModels')) {
      return { ok: true, json: async () => ({ response: { models: catalog } }) };
    }
    if (url !== host + statusPath || init.body !== '{}') return init;
    assert.equal(init.headers['x-codeium-csrf-token'], 'local-test');
    return { ok: true, json: async () => ({ userStatus: { cascadeModelConfigData: { clientModelConfigs: [
      { modelOrAlias: { model: argon }, contextWindowOptions: [{ name: '900K' }] },
      { modelOrAlias: { model: flash }, contextWindowOptions: [{ name: '256K' }] },
      ...variants,
      { modelOrAlias: { model: other } },
    ] } } }) };
  };
  class WebSocket {
    constructor(url) { this.url = url; }
    send(data) { return data; }
  }
  const nativeSend = WebSocket.prototype.send;
  const window = { location: new URL(host), fetch: nativeFetch, WebSocket, __APP_CONFIG__: { csrfToken: 'local-test' } };
  const context = vm.createContext({ window, URL, TextEncoder, TextDecoder, Headers, Uint8Array, AbortSignal, setTimeout, clearTimeout });
  const install = (rules, boot = 'first') => vm.runInContext(createContextWindowSyncExpression(rules, boot), context);
  const request = (model) => ({
    cascadeId: 'conversation-1',
    items: [{ text: 'Keep the request intact' }],
    cascadeConfig: {
      plannerConfig: { planModel: model },
      checkpointConfig: { maxTokenLimit: 128000, checkpointIntervalTokens: 20000 },
    },
  });
  const options = (body, type = 'application/json') => ({
    method: 'POST', headers: { 'Content-Type': type }, body,
  });
  const preferences = { [argon]: '900K', [flash]: '900K', [carbonGroup]: '512000', [other]: '512000' };
  await install(preferences);
  try {
    const payload = request(argon);
    const input = options(JSON.stringify(payload));
    const edited = JSON.parse((await window.fetch(host + sendPath, input)).body);
    assert.deepEqual(edited, {
      ...payload,
      cascadeConfig: {
        ...payload.cascadeConfig,
        checkpointConfig: { contextWindow: '900K', checkpointIntervalTokens: 20000 },
      },
    });
    const untouched = options(JSON.stringify(request(flash)));
    assert.equal(await window.fetch(host + sendPath, untouched), untouched);
    const lowCapacity = options(JSON.stringify(request(other)));
    assert.equal(await window.fetch(host + sendPath, lowCapacity), lowCapacity);
    const carbonPayload = request(carbon);
    carbonPayload.cascadeConfig.checkpointConfig.contextWindow = 'default';
    const carbonBody = (await window.fetch(host + sendPath, options(JSON.stringify(carbonPayload)))).body;
    assert.deepEqual(JSON.parse(carbonBody).cascadeConfig.checkpointConfig,
      { maxTokenLimit: 512000, checkpointIntervalTokens: 20000 });
    const lowPayload = options(JSON.stringify(request(carbonLow)));
    assert.equal(JSON.parse((await window.fetch(host + sendPath, lowPayload)).body).cascadeConfig.checkpointConfig.maxTokenLimit, 512000);
    assert.equal(await window.fetch('https://127.0.0.1:25191' + sendPath, input), input);
    assert.equal(await window.fetch(host + statusPath, input), input);

    const frame = Buffer.alloc(5 + Buffer.byteLength(input.body));
    frame.writeUInt32BE(frame.length - 5, 1);
    frame.write(input.body, 5);
    const framed = await window.fetch(host + sendPath, options(frame, 'application/grpc-web+json'));
    assert.equal(Buffer.from(framed.body).readUInt32BE(1), framed.body.length - 5);
    assert.deepEqual(JSON.parse(Buffer.from(framed.body.subarray(5)).toString()), edited);

    const socket = new WebSocket('wss://127.0.0.1:25190/connect-websocket');
    const msg = { type: 'start', stream: false, procedure: sendPath, streamId: 'request-1', payload };
    assert.deepEqual(JSON.parse(socket.send(JSON.stringify(msg))), { ...msg, payload: edited });
    const unrelated = JSON.stringify({ ...msg, payload: request(flash) });
    assert.equal(socket.send(unrelated), unrelated);
    const external = new WebSocket('wss://127.0.0.1:25191/connect-websocket');
    assert.equal(external.send(JSON.stringify(msg)), JSON.stringify(msg));

    const firstHook = window.fetch;
    variants = [carbonModels[0], { ...carbonModels[1], modelOrAlias: { model: newCarbonLow } }];
    catalog = { ...availableModels, 'gemini-4-carbon-low': { ...availableModels['gemini-4-carbon-low'], model: newCarbonLow } };
    await install(preferences, 'second');
    assert.notEqual(window.fetch, firstHook);
    assert.equal(await window.fetch(host + sendPath, lowPayload), lowPayload);
    window.fetch = nativeFetch;
    await install(preferences, 'second');
    const newLowPayload = options(JSON.stringify(request(newCarbonLow)));
    assert.equal(JSON.parse((await window.fetch(host + sendPath, newLowPayload)).body).cascadeConfig.checkpointConfig.maxTokenLimit, 512000);

    catalog['gemini-4-carbon-low'] = { model: newCarbonLow, maxTokens: 300000, maxOutputTokens: 64000 };
    await install(preferences, 'third');
    assert.equal(await window.fetch(host + sendPath, newLowPayload), newLowPayload);
    assert.equal(await window.fetch(host + sendPath, options(JSON.stringify(carbonPayload))).then(({ body }) => body), JSON.stringify(carbonPayload));
  } finally {
    await install({});
  }
  assert.equal(window.fetch, nativeFetch);
  assert.equal(WebSocket.prototype.send, nativeSend);
});

test('Issue #27: syncHostContextWindows falls back to backend pre-resolved rules without __APP_CONFIG__.csrfToken and intercepts StartCascade + Uint8Array / connect+json frames', async () => {
  const sendPath = '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage';
  const startPath = '/exa.language_server_pb.LanguageServerService/StartCascade';
  const host = 'https://127.0.0.1:26190';
  const nativeFetch = async (_url, init) => init;
  class WebSocket {
    constructor(url) {
      this.url = url;
    }
    send(data) {
      return data;
    }
  }
  const window = {
    location: new URL(host),
    fetch: nativeFetch,
    WebSocket,
    __APP_CONFIG__: {}, // Simulate 2.33.0+ environment without exposed csrfToken on window
  };
  const context = vm.createContext({
    window,
    URL,
    TextEncoder,
    TextDecoder,
    Headers,
    Uint8Array,
    AbortSignal,
    setTimeout,
    clearTimeout,
  });

  const prefs = { [carbonGroup]: '256000' };
  const fallbackRules = { [carbon]: 256000, [carbonLow]: 256000 };
  const syncResult = await vm.runInContext(
    createContextWindowSyncExpression(prefs, 'boot-233', fallbackRules),
    context
  );
  assert.deepEqual({ ...syncResult }, { attached: true, ruleCount: 2 });

  try {
    // 1. StartCascade on new conversation creation with Uint8Array JSON body
    const startPayload = {
      cascadeConfig: {
        plannerConfig: { planModel: carbon },
        checkpointConfig: { maxTokenLimit: 512000 },
      },
    };
    const uint8Body = new TextEncoder().encode(JSON.stringify(startPayload));
    const startOut = await window.fetch(new URL(host + startPath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: uint8Body,
    });
    assert.equal(startOut.body instanceof Uint8Array, true);
    assert.equal(
      JSON.parse(new TextDecoder().decode(startOut.body)).cascadeConfig.checkpointConfig
        .maxTokenLimit,
      256000
    );

    // 2. application/connect+json 5-byte envelope on SendUserCascadeMessage
    const msgBytes = Buffer.from(JSON.stringify(startPayload), 'utf8');
    const connectFrame = new Uint8Array(5 + msgBytes.length);
    new DataView(connectFrame.buffer).setUint32(1, msgBytes.length);
    connectFrame.set(msgBytes, 5);
    const framedOut = await window.fetch(host + sendPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/connect+json' },
      body: connectFrame,
    });
    const decodedJson = JSON.parse(
      new TextDecoder().decode(framedOut.body.subarray(5))
    );
    assert.equal(decodedJson.cascadeConfig.checkpointConfig.maxTokenLimit, 256000);

    // 3. WebSocket StartCascade frame
    const ws = new WebSocket('wss://127.0.0.1:26190/connect-websocket');
    const wsFrame = JSON.parse(
      ws.send(
        JSON.stringify({
          type: 'start',
          stream: false,
          procedure: startPath,
          payload: startPayload,
        })
      )
    );
    assert.equal(wsFrame.payload.cascadeConfig.checkpointConfig.maxTokenLimit, 256000);
  } finally {
    await vm.runInContext(createContextWindowSyncExpression({}, 'boot-233', {}), context);
  }
  assert.equal(window.fetch, nativeFetch);
});
