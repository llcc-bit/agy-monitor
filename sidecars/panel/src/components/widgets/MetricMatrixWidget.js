/**
 * @fileoverview Standalone decoupled Metric Matrix Widget (`MetricMatrixWidget.js`).
 * Renders 1..4 user-selected telemetry cells dynamically via `metricRegistry.js`.
 */

import { defineComponent } from '../../core/component.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchStyleVar,
  patchText,
} from '../../core/domPatch.js';
import { createSvgIcon, patchSvgIcon } from '../../icons/SvgIcon.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';
import { resolveOverviewMetricCell } from '../../registries/metricRegistry.js';
import {
  normalizeClientOverviewMetrics,
  resolveScopedConversation,
} from '../../store/telemetryStore.js';
import { uiStore } from '../../store/uiStore.js';

export const MetricMatrixWidget = defineComponent({
  name: 'MetricMatrixWidget',
  setup({ props }) {
    const getCtxAgentId =
      typeof props?.getCtxAgentId === 'function'
        ? props.getCtxAgentId
        : () => uiStore.getState().ctxInspectorAgentId;
    const matrixEl = h('section', {
      className: 'telemetry-matrix',
      'aria-label': t('module.metrics'),
      'data-cols': '4',
    });
    patchStyleVar(matrixEl, '--matrix-cols', '4');

    function createMetricCellNode() {
      const labelSpan = h('span', { text: '—' });
      const iconSvg = createSvgIcon('pulse', { size: 11 });
      const valueEl = h('strong', { className: 'cell-value', text: '—' });
      const subEl = h('span', { className: 'cell-sub', text: '—' });
      const el = h('div', { className: 'matrix-cell' }, [
        h('div', { className: 'cell-label' }, [labelSpan, iconSvg]),
        valueEl,
        subEl,
      ]);
      return {
        el,
        refs: { labelSpan, iconSvg, valueEl, subEl },
      };
    }

    function update({ data } = {}) {
      patchAttr(matrixEl, 'aria-label', t('module.metrics'));
      const metricKeys = normalizeClientOverviewMetrics(data?.settings?.overviewMetrics);
      const colCount = Math.max(1, Math.min(4, metricKeys.length));
      patchAttr(matrixEl, 'data-cols', String(colCount));
      patchStyleVar(matrixEl, '--matrix-cols', String(colCount));

      const { hasSubagents, scopedConv, ctxAgent } = resolveScopedConversation(
        data,
        'all',
        getCtxAgentId()
      );
      const active = scopedConv || data?.activeConversation || {};
      const ctx = ctxAgent?.context || active.context || {};
      const quotas = data?.quotas || {};
      const settings = data?.settings || {};
      const locale = getEffectiveLocale();

      const cells = metricKeys.map((key) =>
        resolveOverviewMetricCell(key, {
          active,
          ctx,
          quotas,
          settings,
          hasSubagents,
        })
      );

      patchKeyedList(matrixEl, cells, {
        keyFn: (cell) => cell.key,
        sigFn: (cell) =>
          `${locale}:${cell.key}:${cell.label}:${cell.icon}:${cell.isPulsing}:${cell.valueClass}:${cell.valueText}:${cell.subClass}:${cell.subText}`,
        createRow: createMetricCellNode,
        updateRow: (refs, cell) => {
          patchText(refs.labelSpan, cell.label);
          patchSvgIcon(refs.iconSvg, cell.icon);
          refs.iconSvg.setAttribute('width', String(cell.iconSize));
          refs.iconSvg.setAttribute('height', String(cell.iconSize));
          patchClasses(refs.iconSvg, { 'is-pulsing': Boolean(cell.isPulsing) });
          patchAttr(refs.valueEl, 'class', cell.valueClass);
          patchText(refs.valueEl, cell.valueText);
          patchAttr(refs.subEl, 'class', cell.subClass);
          patchText(refs.subEl, cell.subText);
        },
      });
    }

    // Initialize default 4-cell skeleton so hover/overview has zero initial height jump
    update({ data: null });

    return {
      el: matrixEl,
      refs: { update },
    };
  },
});
