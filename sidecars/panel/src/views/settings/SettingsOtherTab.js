/**
 * @fileoverview Preferences Tab 3: `SettingsOtherTab.js` ("其他").
 * Houses Model Identifier Formatting, Per-Model Context Windows,
 * Local Trajectory Cache Rebuild, and Two-Step Factory Preference Reset.
 */

import { defineComponent } from '../../core/component.js';
import { h, patchAttr, patchClasses, patchText } from '../../core/domPatch.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { setI18nLanguage, t } from '../../i18n/index.js';
import {
  normalizeClientModelDisplayMode,
  normalizeClientOrchestratorIdMode,
  rebuildTrajectoryCache,
  resetAllSettings,
  saveModelContextWindow,
  saveSettingsPatch,
} from '../../store/telemetryStore.js';
import { CustomSelect } from '../../components/ui/CustomSelect.js';
import { BridgeStatusNotice } from '../../components/settings/BridgeStatusNotice.js';

function getStepModelDisplayOptions() {
  return [
    { value: 'short', label: t('settings.oth.modelShort') },
    { value: 'upstream', label: t('settings.oth.modelUpstream') },
    { value: 'upstream_compact', label: t('settings.oth.modelUpstreamCompact') },
  ];
}

function getOrchestratorIdDisplayOptions() {
  return [
    { value: 'compact', label: t('settings.oth.orchCompact') },
    { value: 'full', label: t('settings.oth.orchFull') },
  ];
}

export const SettingsOtherTab = defineComponent({
  name: 'SettingsOtherTab',
  setup({ onCleanup, getProps }) {
    let draftModelDisplayMode = 'short';
    let draftOrchestratorIdMode = 'compact';
    let draftContextRiskAccepted = false;
    let acceptingContextRisk = false;
    let latestSettings = null;
    let latestWindowBridge = null;
    let latestHostPlatform = 'win32';
    let contextWindowModels = [];
    let contextModelId = '';
    let savingContextWindow = false;
    let contextFeedback = '';
    let modelTimer = null;
    let maintTimer = null;
    let resetConfirmTimer = null;
    let resetConfirmArmed = false;
    let isRebuilding = false;
    let isResetting = false;

    const modelStatusText = h('span', {
      className: 'text-muted',
      style: 'font-size: var(--fs-md);',
      text: '',
    });
    const maintStatusText = h('span', {
      className: 'text-muted',
      style: 'font-size: var(--fs-md);',
      text: '',
    });

    function showModelFeedback(text, autoClearMs = 1500) {
      if (modelTimer) {
        clearTimeout(modelTimer);
        modelTimer = null;
      }
      patchText(modelStatusText, text);
      if (text && autoClearMs > 0) {
        modelTimer = setTimeout(() => {
          modelTimer = null;
          patchText(modelStatusText, '');
        }, autoClearMs);
      }
    }

    function showMaintFeedback(text, autoClearMs = 2500) {
      if (maintTimer) {
        clearTimeout(maintTimer);
        maintTimer = null;
      }
      patchText(maintStatusText, text);
      if (text && autoClearMs > 0) {
        maintTimer = setTimeout(() => {
          maintTimer = null;
          patchText(maintStatusText, '');
        }, autoClearMs);
      }
    }

    // --- Card 1: 模型标识显示 ---
    const modelCardTitleEl = h('span', { text: t('settings.oth.modelTitle') });
    const modelFormatLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.oth.modelFormat'),
    });
    const orchFormatLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.oth.orchFormat'),
    });

    const stepModelSelect = CustomSelect({
      modelValue: 'short',
      icon: 'table',
      options: getStepModelDisplayOptions(),
      onUpdateModelValue: async (val) => {
        const nextMode = normalizeClientModelDisplayMode(val);
        draftModelDisplayMode = nextMode;
        stepModelSelect.setValue(nextMode);
        showModelFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({
            modelDisplayMode: nextMode,
            showUpstreamModel: nextMode !== 'short',
          });
          showModelFeedback(t('settings.saved'), 1500);
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          showModelFeedback(t('settings.saveFailed'), 2500);
        }
      },
    });

    const orchestratorIdSelect = CustomSelect({
      modelValue: 'compact',
      icon: 'layers',
      options: getOrchestratorIdDisplayOptions(),
      onUpdateModelValue: async (val) => {
        const nextMode = normalizeClientOrchestratorIdMode(val);
        draftOrchestratorIdMode = nextMode;
        orchestratorIdSelect.setValue(nextMode);
        showModelFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({ orchestratorIdMode: nextMode });
          showModelFeedback(t('settings.saved'), 1500);
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          showModelFeedback(t('settings.saveFailed'), 2500);
        }
      },
    });

    const modelPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('sliders', { size: 13 }),
          modelCardTitleEl,
        ]),
        modelStatusText,
      ]),
      h('div', { className: 'form-row' }, [modelFormatLabelEl, stepModelSelect.el]),
      h('div', { className: 'form-row' }, [orchFormatLabelEl, orchestratorIdSelect.el]),
    ]);

    // --- Card 2: 按模型设置上下文窗口 ---
    const baselineTitleEl = h('span', { text: t('settings.oth.baselineTitle') });
    const ctxModelLabel = h('span', { className: 'form-label' });
    const ctxWindowLabel = h('span', { className: 'form-label' });
    const ctxHint = h('span', { className: 'settings-hint-text' });
    const ctxStatus = h('span', { className: 'text-muted', role: 'status' });
    const ctxModelSelect = CustomSelect({
      className: 'settings-context-model',
      options: [],
      onUpdateModelValue: (id) => {
        if (!draftContextRiskAccepted || savingContextWindow) return;
        contextModelId = id;
        contextFeedback = '';
        renderContextWindows();
      },
    });
    const ctxWindowSelect = CustomSelect({
      options: [],
      onUpdateModelValue: async (value) => {
        if (!draftContextRiskAccepted || savingContextWindow || !contextModelId) return;
        savingContextWindow = true;
        contextFeedback = 'settings.saving';
        renderContextWindows();
        try {
          const modelContextWindows = await saveModelContextWindow(contextModelId, value || null);
          latestSettings = { ...latestSettings, modelContextWindows };
          contextFeedback = 'settings.saved';
        } catch {
          contextFeedback = 'settings.saveFailed';
        } finally {
          savingContextWindow = false;
          renderContextWindows();
        }
      },
    });
    const ctxBridgeNotice = BridgeStatusNotice({ contextMode: true });
    const ctxModelRow = h('div', { className: 'form-row' }, [ctxModelLabel, ctxModelSelect.el]);
    const ctxWindowRow = h('div', { className: 'form-row' }, [ctxWindowLabel, ctxWindowSelect.el]);
    const ctxControlsBody = h('div', { className: 'ctx-controls-body is-locked' }, [
      ctxBridgeNotice.el,
      ctxModelRow,
      ctxWindowRow,
      h('div', { className: 'form-row' }, [ctxHint]),
    ]);

    const ctxRiskTitleEl = h('strong', {
      className: 'ctx-risk-title',
      text: t('settings.oth.ctxRiskTitle'),
    });
    const ctxRiskBodyEl = h('p', {
      className: 'ctx-risk-desc',
      text: t('settings.oth.ctxRiskBody'),
    });
    const ctxRiskAcceptBtnText = h('span', { text: t('settings.oth.ctxRiskAcceptBtn') });
    const ctxRiskAcceptBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary btn-danger-confirm ctx-risk-accept-btn',
        onClick: async () => {
          if (acceptingContextRisk || draftContextRiskAccepted) return;
          acceptingContextRisk = true;
          draftContextRiskAccepted = true;
          latestSettings = { ...(latestSettings || {}), contextWindowRiskAccepted: true };
          contextFeedback = 'settings.saving';
          renderContextWindows();
          try {
            await saveSettingsPatch({ contextWindowRiskAccepted: true });
            contextFeedback = 'settings.saved';
          } catch {
            draftContextRiskAccepted = false;
            latestSettings = { ...(latestSettings || {}), contextWindowRiskAccepted: false };
            contextFeedback = 'settings.saveFailed';
          } finally {
            acceptingContextRisk = false;
            renderContextWindows();
          }
        },
      },
      [createSvgIcon('warning', { size: 12 }), ctxRiskAcceptBtnText]
    );
    const ctxRiskMask = h(
      'div',
      {
        className: 'ctx-risk-mask',
        role: 'region',
        'aria-label': t('settings.oth.ctxRiskTitle'),
      },
      [
        h('div', { className: 'ctx-risk-head' }, [
          createSvgIcon('warning', { size: 14, className: 'ctx-risk-icon' }),
          ctxRiskTitleEl,
        ]),
        ctxRiskBodyEl,
        ctxRiskAcceptBtn,
      ]
    );
    const ctxRiskStage = h('div', { className: 'ctx-risk-stage' }, [ctxControlsBody, ctxRiskMask]);

    function renderContextWindows() {
      const unlocked = Boolean(draftContextRiskAccepted);
      if (!unlocked) {
        ctxModelSelect.close();
        ctxWindowSelect.close();
      }
      patchClasses(ctxControlsBody, { 'is-locked': !unlocked });
      patchAttr(ctxControlsBody, 'inert', !unlocked);
      patchAttr(ctxControlsBody, 'aria-hidden', unlocked ? null : 'true');
      patchAttr(ctxRiskMask, 'hidden', unlocked);
      patchAttr(ctxRiskMask, 'aria-label', t('settings.oth.ctxRiskTitle'));
      patchText(ctxRiskTitleEl, t('settings.oth.ctxRiskTitle'));
      patchText(ctxRiskBodyEl, t('settings.oth.ctxRiskBody'));
      patchText(ctxRiskAcceptBtnText, t('settings.oth.ctxRiskAcceptBtn'));
      patchAttr(ctxRiskAcceptBtn, 'disabled', acceptingContextRisk);

      const saved = latestSettings?.modelContextWindows || {};
      const wbState = String(latestWindowBridge?.state || '').trim();
      const isBridgeMissing = wbState === 'no_devtools_port' || wbState === 'cdp_unreachable';
      ctxBridgeNotice.refs.update({
        visible: unlocked,
        windowBridge: latestWindowBridge,
        hostPlatform: latestHostPlatform,
      });
      const models = new Map(contextWindowModels.map((model) => [model.id, model]));
      const knownIds = new Set(contextWindowModels.flatMap(({ id, members = [] }) => [id, ...members]));
      for (const id of Object.keys(saved)) {
        if (!knownIds.has(id)) models.set(id, { id, label: id.replace(/^model:/, ''), options: [] });
      }
      if (!models.has(contextModelId)) contextModelId = '';
      const mixed = '\u0000mixed';
      const getSelection = ({ id, members = [] }) => {
        const legacy = new Set(members.map((member) => saved[member]).filter(Boolean));
        return saved[id] || (legacy.size > 1 ? mixed : legacy.values().next().value) || '';
      };
      const formatLimit = (value) => /^\d+$/.test(value) ? t('settings.oth.ctxTokens', { count: Number(value).toLocaleString() }) : value;
      const isAvailable = (model, value) => model.options.some(({ name }) => name === value) ||
        (/^[1-9]\d*$/.test(value) && Number(value) <= model.capacity);
      const current = models.get(contextModelId);
      const options = current?.options || [];
      const selected = current ? getSelection(current) : '';
      const choices = [
        { value: '', label: t('settings.oth.ctxDefault') },
        ...options.map(({ name, expensive, tokens }) => ({
          value: name,
          label: tokens ? formatLimit(name) :
            (expensive ? t('settings.oth.ctxExpensive', { name }) : name),
        })),
      ];
      if (selected && !choices.some((item) => item.value === selected)) {
        let label = t('settings.oth.ctxMixed');
        if (selected !== mixed) {
          const name = formatLimit(selected);
          label = isAvailable(current, selected) ? name : t('settings.oth.ctxUnavailable', { name });
        }
        choices.push({ value: selected, label, disabled: true });
      }
      ctxModelSelect.setProps({
        modelValue: contextModelId,
        options: [
          { value: '', label: t('settings.oth.ctxChooseModel') },
          ...[...models.values()].map((model) => {
            const value = getSelection(model);
            let meta = t('settings.oth.ctxDefault');
            if (value === mixed) meta = t('settings.oth.ctxMixed');
            else if (value) {
              const name = formatLimit(value);
              if (!isAvailable(model, value)) meta = t('settings.oth.ctxUnavailable', { name });
              else if (isBridgeMissing) meta = t('settings.oth.ctxPendingBridge', { name });
              else if (/^\d+$/.test(value) && model.reportedLimitTokens && Number(value) !== model.reportedLimitTokens) {
                meta = t('settings.oth.ctxConfiguredReported', {
                  name,
                  reported: formatLimit(String(model.reportedLimitTokens)),
                });
              } else meta = t('settings.oth.ctxConfigured', { name });
            }
            else if (model.reportedLimitTokens) meta = t('settings.oth.ctxDefaultReported', { name: formatLimit(String(model.reportedLimitTokens)) });
            return { value: model.id, label: model.label, meta };
          }),
        ],
      });
      ctxWindowSelect.setProps({ modelValue: selected, options: choices });
      patchAttr(ctxModelSelect.refs.triggerBtn, 'disabled', !unlocked || savingContextWindow);
      patchAttr(ctxWindowSelect.refs.triggerBtn, 'disabled', !unlocked || savingContextWindow || (!options.length && !selected));
      patchAttr(ctxModelSelect.refs.triggerBtn, 'aria-label', t('settings.oth.ctxModel'));
      patchAttr(ctxWindowSelect.refs.triggerBtn, 'aria-label', t('settings.oth.ctxBaselineLabel'));
      patchAttr(ctxModelRow, 'hidden', !models.size);
      patchAttr(ctxWindowRow, 'hidden', !contextModelId);
      patchText(ctxModelLabel, t('settings.oth.ctxModel'));
      patchText(ctxWindowLabel, t('settings.oth.ctxBaselineLabel'));
      const hint = !models.size ? 'ctxNoModels' : selected === mixed ? 'ctxMixedHint' :
        contextModelId && !options.length ? 'ctxNoOptions' : 'ctxBaselineHint';
      const reported = current?.reportedLimitTokens;
      patchText(ctxHint, [t(`settings.oth.${hint}`), reported &&
        t('settings.oth.ctxReported', { name: formatLimit(String(reported)) })].filter(Boolean).join(' '));
      patchText(ctxStatus, contextFeedback ? t(contextFeedback) : '');
      getProps().onLayoutChange?.();
    }

    const baselinePanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('layers', { size: 13 }),
          baselineTitleEl,
        ]),
        ctxStatus,
      ]),
      ctxRiskStage,
    ]);
    renderContextWindows();

    // --- Card 3: 缓存与重置 ---
    const maintTitleEl = h('span', { text: t('settings.oth.maintTitle') });
    const cacheLabelEl = h('span', {
      className: 'settings-action-title',
      text: t('settings.oth.cacheLabel'),
    });
    const cacheDescEl = h('span', {
      className: 'settings-action-desc',
      text: t('settings.oth.cacheDesc'),
    });

    const rebuildBtnText = h('span', { text: t('settings.oth.rebuildBtn') });
    const rebuildCacheBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          if (isRebuilding) return;
          isRebuilding = true;
          patchAttr(rebuildCacheBtn, 'disabled', true);
          patchText(rebuildBtnText, t('settings.oth.rebuildingBtn'));
          showMaintFeedback(t('settings.oth.rebuildingBtn'), 0);
          try {
            const res = await rebuildTrajectoryCache();
            if (res?.ok !== false) {
              showMaintFeedback(t('settings.oth.rebuildDone'), 2800);
            } else {
              showMaintFeedback(t('settings.oth.rebuildFailed'), 3000);
            }
          } catch {
            showMaintFeedback(t('settings.oth.rebuildFailed'), 3000);
          } finally {
            isRebuilding = false;
            patchAttr(rebuildCacheBtn, 'disabled', false);
            patchText(rebuildBtnText, t('settings.oth.rebuildBtn'));
          }
        },
      },
      [createSvgIcon('refresh', { size: 12 }), rebuildBtnText]
    );

    const resetLabelEl = h('span', {
      className: 'settings-action-title',
      text: t('settings.oth.resetLabel'),
    });
    const resetDescEl = h('span', {
      className: 'settings-action-desc',
      text: t('settings.oth.resetDesc'),
    });

    const resetBtnText = h('span', { text: t('settings.oth.resetAllBtn') });

    function disarmResetConfirm() {
      resetConfirmArmed = false;
      if (resetConfirmTimer) {
        clearTimeout(resetConfirmTimer);
        resetConfirmTimer = null;
      }
      patchClasses(resetAllBtn, { 'btn-danger-confirm': false });
      if (!isResetting) {
        patchText(resetBtnText, t('settings.oth.resetAllBtn'));
      }
    }

    const resetAllBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          if (isResetting) return;
          if (!resetConfirmArmed) {
            resetConfirmArmed = true;
            patchClasses(resetAllBtn, { 'btn-danger-confirm': true });
            patchText(resetBtnText, t('settings.oth.resetConfirmBtn'));
            if (resetConfirmTimer) clearTimeout(resetConfirmTimer);
            resetConfirmTimer = setTimeout(() => {
              disarmResetConfirm();
            }, 3000);
            return;
          }

          disarmResetConfirm();
          isResetting = true;
          patchAttr(resetAllBtn, 'disabled', true);
          patchText(resetBtnText, t('settings.oth.resettingBtn'));
          showMaintFeedback(t('settings.oth.resettingBtn'), 0);
          try {
            const res = await resetAllSettings();
            setI18nLanguage(res?.settings?.language || 'zh-CN');
            showMaintFeedback(t('settings.oth.resetAllDone'), 2800);
          } catch {
            showMaintFeedback(t('settings.saveFailed'), 2800);
          } finally {
            isResetting = false;
            patchAttr(resetAllBtn, 'disabled', false);
            patchText(resetBtnText, t('settings.oth.resetAllBtn'));
          }
        },
      },
      [resetBtnText]
    );

    const maintPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('refresh', { size: 13 }),
          maintTitleEl,
        ]),
        maintStatusText,
      ]),
      h('div', { className: 'settings-action-block' }, [
        h('div', { className: 'settings-action-info' }, [cacheLabelEl, cacheDescEl]),
        rebuildCacheBtn,
      ]),
      h('div', { className: 'settings-action-block' }, [
        h('div', { className: 'settings-action-info' }, [resetLabelEl, resetDescEl]),
        resetAllBtn,
      ]),
    ]);

    const rootEl = h('div', { className: 'settings-tab-stack' }, [
      modelPanel,
      baselinePanel,
      maintPanel,
    ]);

    function renderSettings(
      settings,
      models = contextWindowModels,
      windowBridge = latestWindowBridge,
      hostPlatform = latestHostPlatform
    ) {
      if (!settings) return;
      latestSettings = settings;
      contextWindowModels = models;
      if (windowBridge !== undefined) latestWindowBridge = windowBridge;
      if (hostPlatform) latestHostPlatform = hostPlatform;
      draftModelDisplayMode = normalizeClientModelDisplayMode(
        settings.modelDisplayMode,
        settings.showUpstreamModel
      );
      draftOrchestratorIdMode = normalizeClientOrchestratorIdMode(settings.orchestratorIdMode);
      if (!acceptingContextRisk) {
        draftContextRiskAccepted = Boolean(settings.contextWindowRiskAccepted);
      }
      stepModelSelect.setProps({
        modelValue: draftModelDisplayMode,
        options: getStepModelDisplayOptions(),
      });
      orchestratorIdSelect.setProps({
        modelValue: draftOrchestratorIdMode,
        options: getOrchestratorIdDisplayOptions(),
      });
      renderContextWindows();
    }

    function refreshLabels() {
      patchText(modelCardTitleEl, t('settings.oth.modelTitle'));
      patchText(modelFormatLabelEl, t('settings.oth.modelFormat'));
      patchText(orchFormatLabelEl, t('settings.oth.orchFormat'));
      patchText(baselineTitleEl, t('settings.oth.baselineTitle'));
      renderContextWindows();
      patchText(maintTitleEl, t('settings.oth.maintTitle'));
      patchText(cacheLabelEl, t('settings.oth.cacheLabel'));
      patchText(cacheDescEl, t('settings.oth.cacheDesc'));
      patchText(resetLabelEl, t('settings.oth.resetLabel'));
      patchText(resetDescEl, t('settings.oth.resetDesc'));

      if (!isRebuilding) {
        patchText(rebuildBtnText, t('settings.oth.rebuildBtn'));
      }
      if (!isResetting) {
        patchText(
          resetBtnText,
          resetConfirmArmed ? t('settings.oth.resetConfirmBtn') : t('settings.oth.resetAllBtn')
        );
      }

      stepModelSelect.setProps({
        modelValue: draftModelDisplayMode,
        options: getStepModelDisplayOptions(),
      });
      orchestratorIdSelect.setProps({
        modelValue: draftOrchestratorIdMode,
        options: getOrchestratorIdDisplayOptions(),
      });
    }

    onCleanup(() => {
      if (modelTimer) clearTimeout(modelTimer);
      if (maintTimer) clearTimeout(maintTimer);
      if (resetConfirmTimer) clearTimeout(resetConfirmTimer);
      stepModelSelect.destroy();
      orchestratorIdSelect.destroy();
      ctxBridgeNotice.destroy();
      ctxModelSelect.destroy();
      ctxWindowSelect.destroy();
    });

    return {
      el: rootEl,
      refs: {
        stepModelSelect,
        orchestratorIdSelect,
        ctxBridgeNotice,
        ctxModelSelect,
        ctxWindowSelect,
        rebuildCacheBtn,
        resetAllBtn,
        renderSettings,
        refreshLabels,
      },
    };
  },
});
