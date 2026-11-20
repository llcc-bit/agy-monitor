/** @fileoverview 宿主上报的模型上下文档位与逐次请求配置。 */

import { CONTEXT_WINDOWS_GLOBAL_KEY } from '../shared/window-bridge-protocol.mjs';

export function isContextWindowModelId(value) {
  return typeof value === 'string' && /^MODEL_[A-Z0-9_]{1,120}$/.test(value) &&
    value !== 'MODEL_UNSPECIFIED' && value !== 'MODEL_UNKNOWN';
}

export function isContextWindowSettingId(value) {
  return isContextWindowModelId(value) || (typeof value === 'string' && /^model:[a-z0-9][a-z0-9._-]{0,119}$/.test(value));
}

export function isContextWindowOption(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 80 &&
    value.trim() === value && value.toLowerCase() !== 'default' && !/[\x00-\x1f\x7f]/.test(value);
}

export function getContextWindowModels(clientConfigs, catalog) {
  const capacities = new Map();
  const upstreamIds = new Map();
  const thinkingLevels = new Set();
  for (const [key, info] of Object.entries(catalog || {})) {
    const { model, maxTokens, maxOutputTokens } = info || {};
    if (isContextWindowModelId(model)) upstreamIds.set(model, upstreamIds.has(model) ? '' : key);
    if (Number.isInteger(info?.thinkingLevel) && info.thinkingLevel > 0) thinkingLevels.add(model);
    if (!Number.isSafeInteger(maxTokens) || !Number.isSafeInteger(maxOutputTokens) ||
        maxOutputTokens <= 0 || maxTokens <= maxOutputTokens) continue;
    // 宿主校验压缩阈值时会从模型总窗口中扣除输出预算。
    const capacity = maxTokens - maxOutputTokens;
    capacities.set(model, Math.min(capacity, capacities.get(model) ?? capacity));
  }
  const models = new Map();
  for (const config of Array.isArray(clientConfigs) ? clientConfigs : []) {
    const id = config?.modelOrAlias?.model;
    if (!isContextWindowModelId(id) || config.disabled || models.has(id)) continue;
    const options = Array.isArray(config.contextWindowOptions) ? config.contextWindowOptions : [];
    const byName = new Map();
    for (const option of options) {
      if (!isContextWindowOption(option?.name) || byName.has(option.name)) continue;
      byName.set(option.name, {
        name: option.name,
        expensive: option.expensive === true,
      });
    }
    const reportedId = typeof config.modelId === 'string' ? config.modelId.trim() : '';
    const upstreamId = (reportedId && reportedId !== id ? reportedId : upstreamIds.get(id) || '').toLowerCase();
    const label = config.label || id;
    const effort = upstreamId.match(/-(low|medium|high|xhigh|extra-high|extra|max)$/);
    const labelEffort = typeof label === 'string' && label.match(/\s+\((low|medium|high|xhigh|extra[ -]high|extra|max)\)$/i);
    const isEffortVariant = effort && (thinkingLevels.has(id) ||
      labelEffort && effort[1].replace('-', '') === labelEffort[1].toLowerCase().replace(/[ -]/g, ''));
    const baseId = isEffortVariant ? upstreamId.slice(0, effort.index) : upstreamId;
    const groupId = `model:${baseId}`;
    models.set(id, {
      id,
      groupId: isContextWindowSettingId(groupId) ? groupId : id,
      label: isEffortVariant ? (labelEffort ? label.slice(0, labelEffort.index) : baseId) : label,
      capacity: capacities.get(id) || 0,
      options: [...byName.values()],
    });
  }
  return [...models.values()];
}

export function getContextWindowGroups(models) {
  const byId = new Map();
  for (const model of models) {
    const group = byId.get(model.groupId);
    if (group) group.members.push(model);
    else byId.set(model.groupId, { id: model.groupId, label: model.label, members: [model] });
  }
  return [...byId.values()].map(({ id, label, members }) => {
    const options = members[0].options.filter(({ name }) =>
      members.every((member) => member.options.some((option) => option.name === name))
    ).map(({ name }) => ({
      name,
      expensive: members.some(({ options }) => options.some((option) => option.name === name && option.expensive)),
    }));
    const capacity = Math.min(...members.map((member) => member.capacity));
    if (!options.length && capacity) {
      for (const tokens of new Set([128000, 256000, 384000, 512000, 768000, 900000, capacity])) {
        if (tokens <= capacity && !options.some(({ name }) => name === String(tokens))) {
          options.push({ name: String(tokens), tokens });
        }
      }
    }
    return { id, label, members: members.map((member) => member.id), capacity, options };
  });
}

export function resolveContextWindowOption(model, value) {
  if (!value) return null;
  if (model.options.some(({ name, tokens }) => name === value && !tokens)) return value;
  const tokens = Number(value);
  return Number.isSafeInteger(tokens) && String(tokens) === value && tokens > 0 && tokens <= model.capacity ? tokens : null;
}

export function resolveContextWindowRules(models, preferences) {
  const byId = new Map(models.map((model) => [model.id, model]));
  const rules = {};
  for (const group of getContextWindowGroups(models)) {
    const saved = preferences[group.id];
    // 不同推理档的旧设置有冲突时，保留各自的值，直到用户选定统一上限。
    const previous = new Set(group.members.map((id) => preferences[id]).filter(Boolean));
    const shared = saved || (previous.size === 1 ? previous.values().next().value : null);
    if (resolveContextWindowOption(group, shared) !== null) {
      for (const id of group.members) rules[id] = resolveContextWindowOption(byId.get(id), shared);
    } else if (!saved) {
      for (const id of group.members) {
        const option = resolveContextWindowOption(byId.get(id), preferences[id]);
        if (option !== null) rules[id] = option;
      }
    }
  }
  return rules;
}

// 在宿主聊天窗口执行；只改发往当前 LS 的提交请求，模型 ID 必须完全匹配。
export async function syncHostContextWindows(
  rules,
  bootId,
  key = '__AGUsageMonitorContextWindows',
  fallbackRules = {}
) {
  let state = window[key];
  const appConfig = window.__APP_CONFIG__;
  const csrfToken = appConfig?.csrfToken;
  const hasPrefs = Boolean(rules && Object.keys(rules).length > 0);
  const safeFallback =
    fallbackRules && typeof fallbackRules === 'object' && !Array.isArray(fallbackRules)
      ? fallbackRules
      : {};
  const hasFallback = Object.keys(safeFallback).length > 0;
  if (!hasPrefs || appConfig?.isRemoteControl || (!csrfToken && !hasFallback)) {
    state?.dispose();
    return { attached: false, ruleCount: 0 };
  }
  if (state && (state.bootId !== bootId || !state.isAttached?.())) {
    state.dispose();
    state = null;
  }
  if (!state) {
    const servicePath = '/exa.language_server_pb.LanguageServerService/';
    const sendPath = servicePath + 'SendUserCascadeMessage';
    const startPath = servicePath + 'StartCascade';
    const isTargetProcedure = (p) => p === sendPath || p === startPath;
    const nativeFetch = window.fetch;
    const wsProto = window.WebSocket?.prototype;
    const nativeSend = wsProto?.send;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    function updatePayload(payload) {
      const config = payload?.cascadeConfig;
      const model = config?.plannerConfig?.planModel;
      if (typeof model !== 'string' || !Object.hasOwn(state.rules, model)) return false;
      const checkpoint = config.checkpointConfig ??= {};
      if (typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return false;
      const option = state.rules[model];
      if (typeof option === 'number') {
        delete checkpoint.contextWindow;
        checkpoint.maxTokenLimit = option;
      } else {
        delete checkpoint.maxTokenLimit;
        checkpoint.contextWindow = option;
      }
      return true;
    }

    function rewriteBody(body, contentType) {
      if (contentType === 'application/json') {
        if (typeof body === 'string') {
          const json = JSON.parse(body);
          if (updatePayload(json)) return JSON.stringify(json);
        } else if (body instanceof Uint8Array) {
          const json = JSON.parse(decoder.decode(body));
          if (updatePayload(json)) return encoder.encode(JSON.stringify(json));
        }
      } else if (
        (contentType === 'application/grpc-web+json' || contentType === 'application/connect+json') &&
        body instanceof Uint8Array &&
        body.length >= 5 &&
        body[0] === 0
      ) {
        const header = new DataView(body.buffer, body.byteOffset, body.byteLength);
        if (header.getUint32(1) !== body.length - 5) return body;
        const json = JSON.parse(decoder.decode(body.subarray(5)));
        if (!updatePayload(json)) return body;
        const message = encoder.encode(JSON.stringify(json));
        const frame = new Uint8Array(5 + message.length);
        new DataView(frame.buffer).setUint32(1, message.length);
        frame.set(message, 5);
        return frame;
      }
      return body;
    }

    function fetchWithContextWindow(input, init) {
      let nextInit = init;
      try {
        const rawUrl =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : '';
        if (rawUrl && init?.method === 'POST') {
          const url = new URL(rawUrl, window.location.href);
          if (url.origin === window.location.origin && isTargetProcedure(url.pathname)) {
            const type = new Headers(init.headers).get('content-type')?.split(';')[0].trim();
            const body = rewriteBody(init.body, type);
            if (body !== init.body) nextInit = { ...init, body };
          }
        }
      } catch {
        // 未识别的请求格式交回宿主原样发送。
      }
      return nextInit === init
        ? nativeFetch.apply(this, arguments)
        : nativeFetch.call(this, input, nextInit);
    }

    function sendWithContextWindow(data) {
      let nextData = data;
      try {
        if (typeof data === 'string' && (data.includes(sendPath) || data.includes(startPath))) {
          const url = new URL(this.url);
          const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          if (url.protocol === protocol && url.host === window.location.host &&
              url.pathname === '/connect-websocket') {
            const frame = JSON.parse(data);
            if (frame.type === 'start' && frame.stream === false && isTargetProcedure(frame.procedure) &&
                updatePayload(frame.payload)) {
              nextData = JSON.stringify(frame);
            }
          }
        }
      } catch {
        // 未识别的帧交回宿主原样发送。
      }
      return nativeSend.call(this, nextData);
    }

    state = window[key] = {
      bootId,
      rules: { ...safeFallback },
      serviceUrl: window.location.origin + servicePath,
      isAttached() {
        return (typeof nativeFetch !== 'function' || window.fetch === fetchWithContextWindow) &&
          (typeof nativeSend !== 'function' || wsProto.send === sendWithContextWindow);
      },
      dispose() {
        clearTimeout(state.timer);
        state.rules = {};
        if (window.fetch === fetchWithContextWindow) window.fetch = nativeFetch;
        if (wsProto?.send === sendWithContextWindow) wsProto.send = nativeSend;
        delete window[key];
      },
    };
    if (typeof nativeFetch === 'function') window.fetch = fetchWithContextWindow;
    if (typeof nativeSend === 'function') wsProto.send = sendWithContextWindow;
  }
  state.preferences = rules;
  state.fallbackRules = safeFallback;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => state.dispose(), 15000);

  if (!csrfToken) {
    state.rules = { ...safeFallback };
    return { attached: Boolean(state.isAttached?.()), ruleCount: Object.keys(state.rules).length };
  }

  // App 和 IDE 同时打开时，各窗口优先使用自身宿主上报的档位；若窗口内查询异常则回退后端预解析规则。
  if (state.csrfToken !== csrfToken || Date.now() >= state.refreshAt) {
    if (state.csrfToken !== csrfToken) state.rules = { ...safeFallback };
    state.csrfToken = csrfToken;
    state.refreshAt = Date.now() + 10000;
    state.status = (async () => {
      try {
        const init = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': csrfToken },
          body: '{}',
          signal: AbortSignal.timeout(1500),
        };
        const call = async (method) => {
          const response = await window.fetch(state.serviceUrl + method, init);
          return response.ok ? response.json() : null;
        };
        const [status, catalog] = await Promise.all([
          call('GetUserStatus'),
          call('GetAvailableModels').catch(() => null),
        ]);
        const userStatus = status?.userStatus;
        const configs = userStatus?.cascadeModelConfigData?.clientModelConfigs;
        if (!Array.isArray(configs)) return null;
        return getContextWindowModels(configs, catalog?.response?.models);
      } catch {
        return null;
      }
    })();
  }
  const status = state.status;
  const models = await status;
  if (window[key] !== state || state.status !== status) {
    return { attached: Boolean(state?.isAttached?.()), ruleCount: Object.keys(state?.rules || {}).length };
  }
  state.rules = Array.isArray(models)
    ? resolveContextWindowRules(models, state.preferences)
    : { ...state.fallbackRules };
  return { attached: Boolean(state.isAttached?.()), ruleCount: Object.keys(state.rules).length };
}

export function createContextWindowSyncExpression(preferences, bootId, fallbackRules = {}) {
  return `(() => {
    ${isContextWindowModelId.toString()}
    ${isContextWindowSettingId.toString()}
    ${isContextWindowOption.toString()}
    ${getContextWindowModels.toString()}
    ${getContextWindowGroups.toString()}
    ${resolveContextWindowOption.toString()}
    ${resolveContextWindowRules.toString()}
    return (${syncHostContextWindows.toString()})(${JSON.stringify(preferences)}, ${JSON.stringify(bootId)}, ${JSON.stringify(CONTEXT_WINDOWS_GLOBAL_KEY)}, ${JSON.stringify(fallbackRules || {})});
  })()`;
}
