/**
 * @fileoverview Decoupled Overview & Hover Widget Registry (`widgetRegistry.js`).
 * Maps module keys (`metrics`, `context`, `quotas`, `live_tasks`) to standalone
 * widget components and provides `createDynamicWidgetHost` for zero-hardcode mounting,
 * live reordering, and clean instance disposal.
 */

import { OVERVIEW_MODULE_KEYS } from '../../shared/settings-normalization.mjs';
import { ContextWindowWidget } from '../components/widgets/ContextWindowWidget.js';
import { LiveActivityWidget } from '../components/widgets/LiveActivityWidget.js';
import { MetricMatrixWidget } from '../components/widgets/MetricMatrixWidget.js';
import { QuotaPoolsWidget } from '../components/widgets/QuotaPoolsWidget.js';
import { t } from '../i18n/index.js';

export const OVERVIEW_WIDGET_KEYS = OVERVIEW_MODULE_KEYS;

export const OVERVIEW_WIDGET_REGISTRY = Object.freeze({
  metrics: {
    key: 'metrics',
    labelKey: 'module.metrics',
    create: ({ mode, isVisibleFn, preview, getCtxAgentId }) =>
      MetricMatrixWidget({ mode, isVisibleFn, preview, getCtxAgentId }),
  },
  context: {
    key: 'context',
    labelKey: 'module.context',
    create: ({ mode, isVisibleFn, preview, getCtxAgentId, setCtxAgentId }) =>
      ContextWindowWidget({
        interactiveInspector: mode !== 'hover',
        isVisibleFn,
        preview,
        getCtxAgentId,
        setCtxAgentId,
      }),
  },
  quotas: {
    key: 'quotas',
    labelKey: 'module.quotas',
    create: ({ mode }) =>
      QuotaPoolsWidget({
        compactHover: mode === 'hover',
      }),
  },
  live_tasks: {
    key: 'live_tasks',
    labelKey: 'module.live_tasks',
    create: ({ mode, isVisibleFn, preview, getCtxAgentId }) =>
      LiveActivityWidget({
        interactive: mode !== 'hover',
        isVisibleFn,
        preview,
        getCtxAgentId,
      }),
  },
});

export function getOverviewModuleOptions() {
  return OVERVIEW_WIDGET_KEYS.map((key) => ({
    value: key,
    label: t(`module.${key}`),
  }));
}

/**
 * Create a dynamic container host that mounts, reorders, updates, and disposes
 * standalone telemetry widgets based on user-configured module keys.
 *
 * @param {{
 *   containerEl: HTMLElement,
 *   mode?: 'overview' | 'hover',
 *   isVisibleFn?: () => boolean,
 *   initialModuleKeys?: string[]
 * }} options
 */
export function createDynamicWidgetHost({
  containerEl,
  mode = 'overview',
  preview = false,
  isVisibleFn = () => true,
  initialModuleKeys = [],
}) {
  const instances = new Map();
  let currentKeys = [];
  let previewCtxAgentId = 'auto';
  let latestUpdatePayload = null;

  const getCtxAgentId = preview ? () => previewCtxAgentId : undefined;
  const setCtxAgentId = preview
    ? (nextId) => {
        previewCtxAgentId = String(nextId || 'auto');
        if (latestUpdatePayload) {
          for (const key of currentKeys) {
            instances.get(key)?.refs?.update?.(latestUpdatePayload);
          }
        }
      }
    : undefined;

  function syncModules(nextKeys) {
    const validKeys = [];
    const seen = new Set();
    for (const rawKey of Array.isArray(nextKeys) ? nextKeys : []) {
      const k = String(rawKey || '').trim();
      if (!k || seen.has(k) || !OVERVIEW_WIDGET_REGISTRY[k]) continue;
      seen.add(k);
      validKeys.push(k);
    }

    // Remove and destroy widgets no longer present
    for (const [existingKey, inst] of [...instances.entries()]) {
      if (!seen.has(existingKey)) {
        try {
          inst.el?.remove?.();
        } catch {}
        try {
          inst.destroy?.();
        } catch {}
        instances.delete(existingKey);
      }
    }

    // Instantiate newly added widgets
    for (const key of validKeys) {
      if (!instances.has(key)) {
        const inst = OVERVIEW_WIDGET_REGISTRY[key].create({
          mode,
          preview,
          isVisibleFn,
          getCtxAgentId,
          setCtxAgentId,
        });
        instances.set(key, inst);
      }
    }

    // Reorder DOM nodes in containerEl only where needed
    const orderChanged =
      validKeys.length !== currentKeys.length ||
      validKeys.some((k, idx) => currentKeys[idx] !== k) ||
      (containerEl.children && containerEl.children.length !== validKeys.length);

    if (orderChanged) {
      for (let i = 0; i < validKeys.length; i += 1) {
        const targetEl = instances.get(validKeys[i]).el;
        const curChild = containerEl.children ? containerEl.children[i] : null;
        if (curChild !== targetEl) {
          if (curChild && typeof containerEl.insertBefore === 'function') {
            containerEl.insertBefore(targetEl, curChild);
          } else {
            containerEl.appendChild(targetEl);
          }
        }
      }
      currentKeys = [...validKeys];
    }

    return validKeys;
  }

  function update({ moduleKeys = [], data = null, minuteTick = undefined } = {}) {
    latestUpdatePayload = { data, minuteTick };
    const validKeys = syncModules(moduleKeys);
    for (const key of validKeys) {
      const inst = instances.get(key);
      inst?.refs?.update?.({ data, minuteTick });
    }
  }

  function pauseTickers() {
    for (const inst of instances.values()) {
      inst?.refs?.pauseTicker?.();
    }
  }

  function resumeTickers() {
    for (const inst of instances.values()) {
      inst?.refs?.resumeTicker?.();
    }
  }

  function getInstance(key) {
    return instances.get(key) || null;
  }

  function destroy() {
    for (const inst of instances.values()) {
      try {
        inst.el?.remove?.();
      } catch {}
      try {
        inst.destroy?.();
      } catch {}
    }
    instances.clear();
    currentKeys = [];
  }

  if (Array.isArray(initialModuleKeys) && initialModuleKeys.length > 0) {
    syncModules(initialModuleKeys);
  }

  return {
    update,
    pauseTickers,
    resumeTickers,
    getInstance,
    getActiveKeys: () => [...currentKeys],
    destroy,
  };
}
