/**
 * @fileoverview Standalone decoupled Context Window Widget (`ContextWindowWidget.js`).
 * Supports both interactive multi-agent inspector mode (`LiveOverviewView`)
 * and pointer-events-none in-place pre-allocated mode (`WindowOverlayShell` hover popup).
 */

import { defineComponent } from '../../core/component.js';
import { isModernUiActiveForElement } from '../../core/appearance.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchText,
} from '../../core/domPatch.js';
import { formatTokens, resolveModelDisplayInfo } from '../../core/formatters.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { getEffectiveLocale, isEnglishLocale, t } from '../../i18n/index.js';
import {
  formatAgentBadgeText,
  formatAgentLabel,
  getAgentBadgeClass,
  resolveScopedConversation,
} from '../../store/telemetryStore.js';
import { uiStore } from '../../store/uiStore.js';
import { ContextSegmentMeter } from '../ui/ContextSegmentMeter.js';

const CTX_PILL_BASE_PAD_PX = 14;
const CTX_CJK_CHAR_PX = 11;
const CTX_ASCII_CHAR_PX = 6.1;
const CTX_PILL_GAP_PX = 4;
const CTX_DEFAULT_BAR_WIDTH_PX = 310;

function estimateCtxPillWidth(text, withChevron = false) {
  let w = CTX_PILL_BASE_PAD_PX + (withChevron ? 14 : 0);
  for (const ch of String(text || '')) {
    w += ch.charCodeAt(0) > 255 ? CTX_CJK_CHAR_PX : CTX_ASCII_CHAR_PX;
  }
  return Math.ceil(w);
}

/**
 * 10 通道上下文窗口构成定义（通过动态 getter 自动跟随当前激活语言）。
 */
export const CTX_CHANNEL_DEFS = [
  {
    key: 'assistant',
    labelKey: 'ctx.ch.assistant',
    titleKey: 'ctx.ch.assistantTitle',
    get label() {
      return t(this.labelKey);
    },
    get title() {
      return t(this.titleKey);
    },
    segClass: 'seg-assistant',
    getValue: (c) => Number(c.assistantTokens || 0),
  },
  {
    key: 'toolResults',
    labelKey: 'ctx.ch.toolResults',
    titleKey: 'ctx.ch.toolResultsTitle',
    get label() {
      return t(this.labelKey);
    },
    get title() {
      return t(this.titleKey);
    },
    segClass: 'seg-tool-results',
    getValue: (c) => Number(c.toolResultsTokens || 0),
  },
  {
    key: 'userInput',
    labelKey: 'ctx.ch.userInput',
    titleKey: 'ctx.ch.userInputTitle',
    get label() {
      return t(this.labelKey);
    },
    get title() {
      return t(this.titleKey);
    },
    segClass: 'seg-user-input',
    getValue: (c) => Number(c.userInputTokens ?? c.messagesTokens ?? 0),
  },
  {
    key: 'subagent',
    labelKey: 'ctx.ch.subagent',
    titleKey: 'ctx.ch.subagentTitle',
    get label() {
      return t(this.labelKey);
    },
    get title() {
      return t(this.titleKey);
    },
    segClass: 'seg-subagent-msg',
    getValue: (c) => Number(c.subagentTokens || 0),
  },
  {
    key: 'checkpoint',
    labelKey: 'ctx.ch.checkpoint',
    titleKey: 'ctx.ch.checkpointTitle',
    get label() {
      return t(this.labelKey);
    },
    get title() {
      return t(this.titleKey);
    },
    segClass: 'seg-checkpoint',
    getValue: (c) => Number(c.checkpointTokens || 0),
  },
  {
    key: 'systemPrompt',
    labelKey: 'ctx.ch.systemPrompt',
    titleKey: 'ctx.ch.systemPromptTitle',
    get label() {
      return t(this.labelKey);
    },
    get title() {
      return t(this.titleKey);
    },
    segClass: 'seg-system-prompt',
    getValue: (c) => Number(c.systemPromptTokens || 0),
  },
  {
    key: 'systemTools',
    labelKey: 'ctx.ch.systemTools',
    titleKey: 'ctx.ch.systemToolsTitle',
    get label() {
      return t(this.labelKey);
    },
    get title() {
      return t(this.titleKey);
    },
    segClass: 'seg-system-tools',
    getValue: (c) => Number(c.systemToolsTokens || 0),
  },
  {
    key: 'mcpTools',
    labelKey: 'ctx.ch.mcpTools',
    titleKey: 'ctx.ch.mcpToolsTitle',
    get label() {
      return t(this.labelKey);
    },
    get title() {
      return t(this.titleKey);
    },
    segClass: 'seg-mcp-tools',
    getValue: (c) => Number(c.mcpToolsTokens || 0),
  },
  {
    key: 'skills',
    labelKey: 'ctx.ch.skills',
    titleKey: 'ctx.ch.skillsTitle',
    get label() {
      return t(this.labelKey);
    },
    get title() {
      return t(this.titleKey);
    },
    segClass: 'seg-skills',
    getValue: (c) => Number(c.skillsTokens || 0),
  },
  {
    key: 'userRules',
    labelKey: 'ctx.ch.userRules',
    titleKey: 'ctx.ch.userRulesTitle',
    get label() {
      return t(this.labelKey);
    },
    get title() {
      return t(this.titleKey);
    },
    segClass: 'seg-user-rules',
    getValue: (c) => Number(c.userRulesTokens || 0),
  },
];

export const ContextWindowWidget = defineComponent({
  name: 'ContextWindowWidget',
  setup({ props, onCleanup }) {
    const interactiveInspector = props.interactiveInspector !== false;
    const getCtxAgentId =
      typeof props.getCtxAgentId === 'function'
        ? props.getCtxAgentId
        : () => uiStore.getState().ctxInspectorAgentId;
    const setCtxAgentId =
      typeof props.setCtxAgentId === 'function'
        ? props.setCtxAgentId
        : (nextId) => uiStore.setState({ ctxInspectorAgentId: nextId });
    const isVisibleFn =
      typeof props.isVisibleFn === 'function' ? props.isVisibleFn : () => true;

    const titleTextEl = h('span', { text: t('module.context') });
    const ctxAgentBadge = h('span', {
      className: 'agent-badge badge-main',
      hidden: true,
      text: t('fmt.mainAgent'),
    });
    const ctxSummaryText = h('span', { className: 'text-mono', text: '0 / 256.0k (0%)' });
    const ctxSegmentBar = ContextSegmentMeter({ context: {} });

    const ctxPillGroup = h('div', { className: 'ctx-pill-group' });
    const ctxInspectorBar = h(
      'div',
      { className: 'ctx-inspector-bar', hidden: true },
      [ctxPillGroup]
    );

    const ctxChannels = CTX_CHANNEL_DEFS.map((ch, idx) => {
      const swatchEl = h('span', { className: `swatch ${ch.segClass}` });
      const labelEl = h('span', { text: ch.label });
      const valEl = h('strong', { className: 'text-mono', text: '0' });
      const itemEl = h(
        'div',
        { className: 'legend-item', ...(interactiveInspector ? { title: ch.title } : {}) },
        [h('span', { className: 'legend-left' }, [swatchEl, labelEl]), valEl]
      );
      return { ch, defaultOrder: idx, swatchEl, labelEl, valEl, itemEl };
    });

    const ctxLegendGrid = h(
      'div',
      { className: 'ctx-legend-grid' },
      ctxChannels.map((entry) => entry.itemEl)
    );
    let lastLegendOrderSig = ctxChannels.map((entry) => entry.ch.key).join(',');
    let lastLocale = getEffectiveLocale();

    const children = [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('layers', { size: 13 }),
          titleTextEl,
          ctxAgentBadge,
        ]),
        h('span', { className: 'panel-meta' }, [ctxSummaryText]),
      ]),
    ];
    if (interactiveInspector) {
      children.push(ctxInspectorBar);
    }
    children.push(ctxSegmentBar.el, ctxLegendGrid);

    const ctxPanel = h('section', { className: 'panel' }, children);

    let latestData = null;
    let ctxPillsExpanded = false;
    let isCollapsingCtxPills = false;
    let ctxCollapseTimer = null;
    let lastCascadeId = '';
    let cachedBarWidth = 0;

    function clearCtxExpandAnim() {
      if (ctxCollapseTimer) {
        clearTimeout(ctxCollapseTimer);
        ctxCollapseTimer = null;
      }
      isCollapsingCtxPills = false;
      ctxInspectorBar.ontransitionend = null;
      ctxInspectorBar.style.height = '';
      ctxInspectorBar.style.overflow = '';
      ctxInspectorBar.style.transition = '';
      for (const child of ctxPillGroup.children) {
        child.onanimationend = null;
        patchClasses(child, {
          'is-pill-entering': false,
          'is-pill-collapsing': false,
        });
      }
    }

    function update({ data } = {}) {
      latestData = data || null;
      const curLocale = getEffectiveLocale();
      patchText(titleTextEl, t('module.context'));

      if (!data) {
        if (curLocale !== lastLocale) {
          lastLocale = curLocale;
          for (const entry of ctxChannels) {
            patchText(entry.labelEl, entry.ch.label);
            if (interactiveInspector) {
              patchAttr(entry.itemEl, 'title', entry.ch.title);
            }
          }
        }
        return;
      }

      let availRowWidth = CTX_DEFAULT_BAR_WIDTH_PX;
      if (interactiveInspector) {
        const measuredWidth =
          ctxInspectorBar.clientWidth || (ctxPanel.clientWidth ? ctxPanel.clientWidth - 24 : 0);
        if (measuredWidth > 160) {
          cachedBarWidth = measuredWidth;
        }
        availRowWidth = cachedBarWidth > 160 ? cachedBarWidth : CTX_DEFAULT_BAR_WIDTH_PX;

        const currentCascadeId = data.activeConversation?.cascadeId || '';
        if (currentCascadeId && currentCascadeId !== lastCascadeId) {
          if (lastCascadeId) {
            clearCtxExpandAnim();
            ctxPillsExpanded = false;
          }
          lastCascadeId = currentCascadeId;
        }
      }

      const {
        hasSubagents,
        effectiveCtxScope,
        agents,
        aggregated,
        scopedConv,
        ctxAgent,
      } = resolveScopedConversation(data, 'all', getCtxAgentId());

      const active = scopedConv || data.activeConversation || {};
      const ctx = ctxAgent?.context || active.context || {};

      patchAttr(ctxAgentBadge, 'hidden', !(hasSubagents && ctxAgent));
      if (hasSubagents && ctxAgent) {
        const badgeCls = getAgentBadgeClass(ctxAgent.index || 0, Boolean(ctxAgent.isMain));
        patchAttr(ctxAgentBadge, 'class', `agent-badge ${badgeCls}`);
        const badgeFullText = formatAgentLabel(ctxAgent);
        patchText(ctxAgentBadge, badgeFullText);
        if (interactiveInspector) {
          patchAttr(ctxAgentBadge, 'title', badgeFullText);
        }
      }

      if (interactiveInspector) {
        patchAttr(ctxInspectorBar, 'hidden', !hasSubagents);
        if (!hasSubagents && isCollapsingCtxPills) {
          clearCtxExpandAnim();
        }
        if (hasSubagents && ctxAgent && !isCollapsingCtxPills) {
          const activeBadgeText = formatAgentBadgeText({
            agentKind:
              aggregated?.activeAgentKind ||
              (!aggregated?.activeAgentId || aggregated.activeAgentId === 'main'
                ? 'main'
                : 'subagent'),
            agentOrdinal: Number(aggregated?.activeAgentOrdinal || 0),
            isMain: !aggregated?.activeAgentId || aggregated.activeAgentId === 'main',
            badgeText: aggregated?.activeAgentBadge,
          });

          const pillItems = [
            {
              key: 'auto',
              label: t('ctx.followActive', { badge: activeBadgeText }),
              title: t('ctx.followActiveTitle'),
              isActive: effectiveCtxScope === 'auto',
              mode: 'ctx-only',
            },
          ];

          const allAgentPills = agents.map((ag) => {
            const agPct = ag.context?.usedPct ?? 0;
            const agModelDisplay = resolveModelDisplayInfo(ag, data.settings, {
              fallback: t('fmt.unknownModel'),
            }).text;
            const badgeLabel = formatAgentBadgeText(ag);
            return {
              key: ag.agentId,
              label: `${badgeLabel} ${agPct}%`,
              title: `${formatAgentLabel(ag)} (${agModelDisplay} · ${t('header.convMetaSteps', { count: ag.stepCount || 0 })})`,
              isActive: effectiveCtxScope === ag.agentId,
              mode: 'ctx-only',
            };
          });

          const firstPillWidth =
            pillItems.length > 0 ? estimateCtxPillWidth(pillItems[0].label) : 0;
          const totalAllWidth = allAgentPills.reduce(
            (sum, p) => sum + CTX_PILL_GAP_PX + estimateCtxPillWidth(p.label),
            firstPillWidth
          );
          const needsCollapse = totalAllWidth > availRowWidth && allAgentPills.length > 2;

          if (needsCollapse && !ctxPillsExpanded) {
            const toggleSample = t('ctx.expandMore', { count: allAgentPills.length });
            const toggleReservePx = CTX_PILL_GAP_PX + estimateCtxPillWidth(toggleSample, true);
            let usedW = firstPillWidth;
            let fitCount = 0;
            for (let i = 0; i < allAgentPills.length; i += 1) {
              const pw = CTX_PILL_GAP_PX + estimateCtxPillWidth(allAgentPills[i].label);
              if (fitCount >= 1 && usedW + pw + toggleReservePx > availRowWidth) {
                break;
              }
              usedW += pw;
              fitCount += 1;
            }
            const maxKeep = Math.max(1, allAgentPills.length - 2);
            const maxCollapsedCount = Math.max(1, Math.min(maxKeep, fitCount));
            const visibleAgentPills = allAgentPills.slice(0, maxCollapsedCount);
            const activeHiddenPill = allAgentPills
              .slice(maxCollapsedCount)
              .find((p) => p.isActive);
            if (activeHiddenPill) {
              if (visibleAgentPills.length >= 2) {
                visibleAgentPills[visibleAgentPills.length - 1] = activeHiddenPill;
              } else {
                visibleAgentPills.push(activeHiddenPill);
              }
            }
            const hiddenCount = allAgentPills.length - visibleAgentPills.length;
            pillItems.push(...visibleAgentPills, {
              key: '__toggle_more__',
              label: t('ctx.expandMore', { count: hiddenCount }),
              title: t('ctx.expandMoreTitle', { count: allAgentPills.length - 1 }),
              isActive: false,
              isMoreToggle: true,
              isExpanded: false,
              mode: 'toggle-expand',
            });
          } else {
            pillItems.push(...allAgentPills);
            if (needsCollapse) {
              pillItems.push({
                key: '__toggle_more__',
                label: t('ctx.collapse'),
                title: t('ctx.collapseTitle'),
                isActive: false,
                isMoreToggle: true,
                isExpanded: true,
                mode: 'toggle-expand',
              });
            }
          }

          patchKeyedList(ctxPillGroup, pillItems, {
            keyFn: (item) => item.key,
            sigFn: (item) =>
              `${item.key}:${item.label}:${item.isActive}:${item.isMoreToggle}:${Boolean(item.isExpanded)}:${item.mode}:${item.title}`,
            createRow: () => {
              const labelSpan = h('span', { className: 'ctx-pill-label' });
              const chevronEl = createSvgIcon('chevron-down', {
                size: 11,
                className: 'ctx-toggle-chevron',
              });
              patchAttr(chevronEl, 'hidden', true);
              const btn = h('button', { type: 'button', className: 'ctx-agent-pill' }, [
                labelSpan,
                chevronEl,
              ]);
              return { el: btn, refs: { btn, labelSpan, chevronEl } };
            },
            updateRow: (refs, item) => {
              patchText(refs.labelSpan, item.label);
              patchAttr(refs.chevronEl, 'hidden', !item.isMoreToggle);
              patchAttr(refs.btn, 'title', item.title);
              patchAttr(refs.btn, 'data-pill-key', item.key);
              patchClasses(refs.btn, {
                'is-active': item.isActive,
                'is-more-toggle': Boolean(item.isMoreToggle),
                'is-expanded': Boolean(item.isExpanded),
                'is-pill-collapsing': false,
              });
              refs.btn.onclick = () => {
                if (item.mode === 'toggle-expand') {
                  const modern = isModernUiActiveForElement(ctxPanel);
                  const startH = Number(ctxInspectorBar.offsetHeight || 0);
                  clearCtxExpandAnim();
                  if (!modern || !(startH > 0)) {
                    ctxPillsExpanded = !ctxPillsExpanded;
                    if (latestData) update({ data: latestData });
                    return;
                  }

                  if (!ctxPillsExpanded) {
                    const prevKeys = new Set(
                      Array.from(ctxPillGroup.children, (el) => el.getAttribute?.('data-pill-key') || '')
                    );
                    ctxPillsExpanded = true;
                    if (latestData) update({ data: latestData });
                    const endH = Number(ctxPillGroup.offsetHeight || 0);
                    for (const child of ctxPillGroup.children) {
                      const k = child.getAttribute?.('data-pill-key') || '';
                      if (k && k !== '__toggle_more__' && !prevKeys.has(k)) {
                        patchClasses(child, { 'is-pill-entering': true });
                        child.onanimationend = () => {
                          child.onanimationend = null;
                          patchClasses(child, { 'is-pill-entering': false });
                        };
                      }
                    }
                    if (endH > startH + 1) {
                      ctxInspectorBar.style.height = `${startH}px`;
                      ctxInspectorBar.style.overflow = 'hidden';
                      void ctxInspectorBar.offsetHeight;
                      ctxInspectorBar.style.transition =
                        'height 220ms cubic-bezier(0.16, 1, 0.3, 1)';
                      ctxInspectorBar.style.height = `${endH}px`;
                      const finishExpand = () => clearCtxExpandAnim();
                      ctxInspectorBar.ontransitionend = (ev) => {
                        if (
                          ev?.target === ctxInspectorBar &&
                          (!ev.propertyName || ev.propertyName === 'height')
                        ) {
                          finishExpand();
                        }
                      };
                      ctxCollapseTimer = setTimeout(finishExpand, 260);
                    }
                  } else {
                    const firstPill = ctxPillGroup.children[0] || null;
                    const firstTop = Number(firstPill?.offsetTop || 0);
                    let firstRowH = Number(firstPill?.offsetHeight || 20);
                    for (const child of ctxPillGroup.children) {
                      const top = Number(child.offsetTop || 0);
                      if (top <= firstTop + 4) {
                        const bottom = top - firstTop + Number(child.offsetHeight || 0);
                        if (bottom > firstRowH) firstRowH = bottom;
                      }
                    }
                    const targetH = Math.max(18, firstRowH);
                    ctxPillsExpanded = false;
                    isCollapsingCtxPills = true;
                    patchClasses(refs.btn, { 'is-expanded': false });
                    for (const child of ctxPillGroup.children) {
                      if (Number(child.offsetTop || 0) > firstTop + 4) {
                        patchClasses(child, { 'is-pill-collapsing': true });
                      }
                    }
                    ctxInspectorBar.style.height = `${startH}px`;
                    ctxInspectorBar.style.overflow = 'hidden';
                    void ctxInspectorBar.offsetHeight;
                    ctxInspectorBar.style.transition =
                      'height 200ms cubic-bezier(0.16, 1, 0.3, 1)';
                    ctxInspectorBar.style.height = `${targetH}px`;
                    const finishCollapse = () => {
                      clearCtxExpandAnim();
                      if (latestData) update({ data: latestData });
                    };
                    ctxInspectorBar.ontransitionend = (ev) => {
                      if (
                        ev?.target === ctxInspectorBar &&
                        (!ev.propertyName || ev.propertyName === 'height')
                      ) {
                        finishCollapse();
                      }
                    };
                    ctxCollapseTimer = setTimeout(finishCollapse, 240);
                  }
                } else {
                  setCtxAgentId(item.key);
                }
              };
            },
          });
        }
      }

      const limitTokens = Number(ctx.compactionLimitTokens || ctx.limitTokens || 256000);
      const totalTokens = Number(ctx.totalTokens || 0);
      const usedPct =
        limitTokens > 0 ? Math.min(100, +((totalTokens / limitTokens) * 100).toFixed(1)) : 0;
      const ctxToneCls =
        usedPct >= 88 ? 'tone-danger' : usedPct >= 70 ? 'tone-warn' : '';
      patchAttr(ctxSummaryText, 'class', ctxToneCls ? `text-mono ${ctxToneCls}` : 'text-mono');
      patchText(
        ctxSummaryText,
        `${formatTokens(totalTokens)} / ${formatTokens(limitTokens)} (${usedPct}%)`
      );
      ctxSegmentBar.setProps({ context: { ...ctx, limitTokens, usedPct } });

      if (interactiveInspector) {
        const localeChanged = curLocale !== lastLocale;
        lastLocale = curLocale;
        const scored = ctxChannels.map((entry) => {
          const val = entry.ch.getValue(ctx);
          if (localeChanged) {
            patchText(entry.labelEl, entry.ch.label);
            patchAttr(entry.itemEl, 'title', entry.ch.title);
          }
          patchText(entry.valEl, formatTokens(val));
          return { entry, val };
        });
        scored.sort((a, b) => b.val - a.val || a.entry.defaultOrder - b.entry.defaultOrder);
        const nextLegendOrderSig = scored.map((x) => x.entry.ch.key).join(',');
        if (nextLegendOrderSig !== lastLegendOrderSig) {
          lastLegendOrderSig = nextLegendOrderSig;
          for (const { entry } of scored) {
            ctxLegendGrid.appendChild(entry.itemEl);
          }
        }
      } else {
        lastLocale = curLocale;
        const scoredChannels = CTX_CHANNEL_DEFS.map((ch, defaultOrder) => ({
          ch,
          defaultOrder,
          val: ch.getValue(ctx),
        }));
        scoredChannels.sort((a, b) => b.val - a.val || a.defaultOrder - b.defaultOrder);
        for (let i = 0; i < ctxChannels.length; i += 1) {
          const slot = ctxChannels[i];
          const item = scoredChannels[i];
          if (!slot || !item) continue;
          patchAttr(slot.swatchEl, 'class', `swatch ${item.ch.segClass}`);
          patchText(slot.labelEl, item.ch.label);
          patchText(slot.valEl, formatTokens(item.val));
        }
      }
    }

    let ro = null;
    if (interactiveInspector && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        if (!isVisibleFn()) return;
        const nextW =
          ctxInspectorBar.clientWidth || (ctxPanel.clientWidth ? ctxPanel.clientWidth - 24 : 0);
        if (nextW > 160 && Math.abs(nextW - cachedBarWidth) >= 6) {
          cachedBarWidth = nextW;
          if (latestData?.activeConversation?.hasSubagents) {
            update({ data: latestData });
          }
        }
      });
      ro.observe(ctxPanel);
    }

    onCleanup(() => {
      clearCtxExpandAnim();
      if (ro) ro.disconnect();
      ctxSegmentBar.destroy();
    });

    return {
      el: ctxPanel,
      refs: { update, ctxSegmentBar },
    };
  },
});
