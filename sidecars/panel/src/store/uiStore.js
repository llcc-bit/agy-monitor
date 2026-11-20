/**
 * @fileoverview UI navigation and view state store.
 */

import { createReactiveStore } from '../core/reactive.js';
import { t } from '../i18n/index.js';

export function getViewTabs() {
  return [
    { value: 'overview', label: t('nav.overview'), icon: 'pulse' },
    { value: 'consumption', label: t('nav.consumption'), icon: 'chart-bar' },
    { value: 'steps', label: t('nav.steps'), icon: 'table' },
    { value: 'settings', label: t('nav.settings'), icon: 'sliders' },
  ];
}

export const uiStore = createReactiveStore({
  activeView: 'overview',
  monitorVisible: true,
  stepsSubTab: 'steps', // 'steps' | 'models'
  settingsSubTab: 'general', // 'general' | 'structure' | 'account' | 'other'
  settingsStructureTab: 'mount', // 'mount' | 'hover' | 'overview' | 'steps'
  selectedAgentScope: 'all', // 'all' | 'main' | <subagent cascadeId>
  ctxInspectorAgentId: 'auto', // 'auto' | 'main' | <subagent cascadeId>
});

export function getVisibleMonitorView(state = uiStore.getState()) {
  return state.monitorVisible ? state.activeView : null;
}
