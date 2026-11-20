/**
 * @fileoverview 10-channel segmented context window progress bar updated via
 * CSS custom variables against the current model's automatic compaction baseline,
 * dynamically ordered from largest to smallest segment.
 */

import { defineComponent } from '../../core/component.js';
import { h, patchAttr, patchClasses, patchStyleVar } from '../../core/domPatch.js';
import { formatTokens } from '../../core/formatters.js';
import { t } from '../../i18n/index.js';

const SEGMENT_DEFS = [
  { key: 'assistant', labelKey: 'ctx.ch.assistant', cls: 'seg-assistant', getVal: (c) => Number(c.assistantTokens || 0) },
  { key: 'toolResults', labelKey: 'ctx.ch.toolResults', cls: 'seg-tool-results', getVal: (c) => Number(c.toolResultsTokens || 0) },
  {
    key: 'userInput',
    labelKey: 'ctx.ch.userInput',
    cls: 'seg-user-input',
    getVal: (c) => Number(c.userInputTokens ?? c.messagesTokens ?? 0),
  },
  { key: 'subagent', labelKey: 'ctx.ch.subagent', cls: 'seg-subagent-msg', getVal: (c) => Number(c.subagentTokens || 0) },
  { key: 'checkpoint', labelKey: 'ctx.ch.checkpoint', cls: 'seg-checkpoint', getVal: (c) => Number(c.checkpointTokens || 0) },
  { key: 'systemPrompt', labelKey: 'ctx.ch.systemPrompt', cls: 'seg-system-prompt', getVal: (c) => Number(c.systemPromptTokens || 0) },
  { key: 'systemTools', labelKey: 'ctx.ch.systemTools', cls: 'seg-system-tools', getVal: (c) => Number(c.systemToolsTokens || 0) },
  { key: 'mcpTools', labelKey: 'ctx.ch.mcpTools', cls: 'seg-mcp-tools', getVal: (c) => Number(c.mcpToolsTokens || 0) },
  { key: 'skills', labelKey: 'ctx.ch.skills', cls: 'seg-skills', getVal: (c) => Number(c.skillsTokens || 0) },
  { key: 'userRules', labelKey: 'ctx.ch.userRules', cls: 'seg-user-rules', getVal: (c) => Number(c.userRulesTokens || 0) },
];

export const ContextSegmentMeter = defineComponent({
  name: 'ContextSegmentMeter',
  setup({ getProps }) {
    // 固定 10 个位置槽位节点，不通过 appendChild 移动 DOM，防止浏览器中断 CSS transition 动画
    const slotEls = SEGMENT_DEFS.map((def) =>
      h('div', { className: `progress-seg ${def.cls}` })
    );

    const trackEl = h(
      'div',
      {
        className: 'progress-track ctx-segment-meter',
        role: 'progressbar',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
      },
      slotEls
    );

    let lastOrderSig = '';

    function syncMeter() {
      const ctx = getProps().context || {};
      const limit = Math.max(1, Number(ctx.compactionLimitTokens || ctx.limitTokens || 256000));
      const scored = SEGMENT_DEFS.map((def, defaultOrder) => {
        const val = def.getVal(ctx);
        const pct = Math.min(100, (val / limit) * 100);
        return { def, defaultOrder, val, pct };
      });

      scored.sort((a, b) => b.val - a.val || a.defaultOrder - b.defaultOrder);
      // 仅关注非零通道的相对顺序变化，决定是否启用 0.05s 先变色再伸缩的衔接延迟
      const activeOrderSig = scored
        .filter((x) => x.val > 0)
        .map((x) => x.def.key)
        .join(',');
      const orderChanged = Boolean(lastOrderSig && activeOrderSig && activeOrderSig !== lastOrderSig);
      if (activeOrderSig) {
        lastOrderSig = activeOrderSig;
      }

      patchClasses(trackEl, { 'is-reordering': orderChanged });

      let seenActive = false;
      for (let i = 0; i < slotEls.length; i++) {
        const slotEl = slotEls[i];
        const item = scored[i];
        const isActive = item.val > 0 && item.pct > 0;
        const hasSep = isActive && seenActive;
        if (isActive) seenActive = true;
        const cls = `progress-seg ${item.def.cls}${isActive ? ' is-active' : ''}${hasSep ? ' has-sep' : ''}`;
        patchAttr(slotEl, 'class', cls);
        patchStyleVar(slotEl, '--seg-w', isActive ? `${item.pct.toFixed(2)}%` : '0%');
        patchAttr(
          slotEl,
          'title',
          isActive
            ? `${t(item.def.labelKey)} · ${formatTokens(item.val)} (${item.pct.toFixed(1)}%)`
            : null
        );
      }

      patchAttr(trackEl, 'aria-valuenow', Math.round(ctx.compactionUsedPct ?? ctx.usedPct ?? 0));
    }

    syncMeter();

    return {
      el: trackEl,
      refs: { segments: slotEls },
      onPropsChange: syncMeter,
    };
  },
});
