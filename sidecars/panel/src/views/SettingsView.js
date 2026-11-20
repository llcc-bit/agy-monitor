/**
 * @fileoverview View 4: Modular preferences ("常规" / "结构" / "账号" / "其他").
 * Orchestrates the four preference tabs
 * with top sub-navigation and a shared `CustomScrollbar` viewport.
 */

import { defineComponent } from '../core/component.js';
import { h, patchAttr } from '../core/domPatch.js';
import { i18nStore, t } from '../i18n/index.js';
import { telemetryStore } from '../store/telemetryStore.js';
import { getVisibleMonitorView, uiStore } from '../store/uiStore.js';
import { CustomScrollbar } from '../components/ui/CustomScrollbar.js';
import { SegmentedControl } from '../components/ui/SegmentedControl.js';
import { SettingsGeneralTab } from './settings/SettingsGeneralTab.js';
import { SettingsOtherTab } from './settings/SettingsOtherTab.js';
import { SettingsStructureTab } from './settings/SettingsStructureTab.js';

export const SHOW_ACCOUNT_TAB = false;

function getSettingsSubTabOptions() {
  return [
    { value: 'general', label: t('settings.subTab.general') },
    { value: 'structure', label: t('settings.subTab.structure') },
    ...(SHOW_ACCOUNT_TAB ? [{ value: 'account', label: t('settings.subTab.account') }] : []),
    { value: 'other', label: t('settings.subTab.other') },
  ];
}

export const SettingsView = defineComponent({
  name: 'SettingsView',
  setup({ onCleanup }) {
    const initialSubTab = uiStore.getState().settingsSubTab || 'general';

    const subNavSwitch = SegmentedControl({
      ariaLabel: t('settings.subTab.aria'),
      modelValue: initialSubTab,
      options: getSettingsSubTabOptions(),
      onUpdateModelValue: (nextSubTab) => {
        uiStore.setState({ settingsSubTab: nextSubTab }, { sync: true });
      },
    });

    const subNavBar = h('div', { className: 'settings-subnav-bar' }, [subNavSwitch.el]);

    let viewScrollbar = null;
    const refreshScroll = () => {
      if (viewScrollbar) {
        viewScrollbar.refresh();
      }
    };

    const generalTab = SettingsGeneralTab({ onLayoutChange: refreshScroll });
    const structureTab = SettingsStructureTab({ onLayoutChange: refreshScroll });
    const accountTab = null; // SettingsAccountTab kept in src/views/settings/ for future opt-in
    const otherTab = SettingsOtherTab({ onLayoutChange: refreshScroll });

    let showingAccount = false;
    function applyActiveSubTab(subTab, activeView) {
      const target =
        subTab === 'structure' ||
        subTab === 'other' ||
        (accountTab && subTab === 'account')
          ? subTab
          : 'general';
      subNavSwitch.setValue(target);
      patchAttr(generalTab.el, 'hidden', target !== 'general');
      patchAttr(structureTab.el, 'hidden', target !== 'structure');
      patchAttr(structureTab.refs.thirdNavBar, 'hidden', target !== 'structure');
      patchAttr(otherTab.el, 'hidden', target !== 'other');
      if (accountTab) {
        patchAttr(accountTab.el, 'hidden', target !== 'account');
        const nextShowingAccount = target === 'account' && activeView === 'settings';
        if (nextShowingAccount && !showingAccount) void accountTab.refs.load();
        showingAccount = nextShowingAccount;
      }
      refreshScroll();
    }

    const contentContainer = h(
      'div',
      {},
      accountTab
        ? [generalTab.el, structureTab.el, accountTab.el, otherTab.el]
        : [generalTab.el, structureTab.el, otherTab.el]
    );
    viewScrollbar = CustomScrollbar({
      contentEl: contentContainer,
      className: 'view-pane',
    });

    applyActiveSubTab(initialSubTab, uiStore.getState().activeView);

    const rootEl = h('div', { className: 'settings-view-root' }, [
      subNavBar,
      structureTab.refs.thirdNavBar,
      viewScrollbar.el,
    ]);

    function syncActiveTab() {
      const ui = uiStore.getState();
      const { settingsSubTab } = ui;
      if (getVisibleMonitorView(ui) !== 'settings') return;
      const telemetry = telemetryStore.getState().telemetry;
      const settings = telemetry?.settings;
      if (settingsSubTab === 'structure') {
        if (settings) {
          structureTab.refs.renderSettings(
            settings,
            telemetry?.windowBridge,
            telemetry?.hostPlatform
          );
        }
      } else if (settingsSubTab === 'other') {
        if (settings) {
          otherTab.refs.renderSettings(
            settings,
            telemetry.contextWindowModels || [],
            telemetry?.windowBridge,
            telemetry?.hostPlatform
          );
        }
      } else if (accountTab && settingsSubTab === 'account') {
        accountTab.refs.renderAccount(telemetry?.account, telemetry?.quotas);
      } else {
        if (settings) generalTab.refs.renderSettings(settings);
        if (telemetry?.cloudStatus) generalTab.refs.renderCloudStatus(telemetry.cloudStatus);
      }
      refreshScroll();
    }

    const unsubTelemetry = telemetryStore.subscribe(
      (st) => ({
        settings: st.telemetry?.settings,
        windowBridge: st.telemetry?.windowBridge,
        hostPlatform: st.telemetry?.hostPlatform,
        cloudStatus: st.telemetry?.cloudStatus,
        contextWindowModels: st.telemetry?.contextWindowModels,
        account: st.telemetry?.account,
        quotas: st.telemetry?.quotas,
      }),
      syncActiveTab
    );

    const unsubUi = uiStore.subscribe(
      (st) => ({
        activeView: getVisibleMonitorView(st),
        settingsSubTab: st.settingsSubTab,
      }),
      (slice) => {
        applyActiveSubTab(slice.settingsSubTab, slice.activeView);
        syncActiveTab();
      }
    );

    const unsubI18n = i18nStore.subscribe(
      (st) => st.locale,
      () => {
        subNavSwitch.setProps({
          modelValue: uiStore.getState().settingsSubTab || 'general',
          options: getSettingsSubTabOptions(),
        });
        generalTab.refs.refreshLabels();
        structureTab.refs.refreshLabels();
        accountTab?.refs.refreshLabels();
        otherTab.refs.refreshLabels();
        refreshScroll();
      }
    );

    onCleanup(() => {
      unsubTelemetry();
      unsubUi();
      unsubI18n();
      subNavSwitch.destroy();
      generalTab.destroy();
      structureTab.destroy();
      accountTab?.destroy();
      otherTab.destroy();
      viewScrollbar.destroy();
    });

    return {
      el: rootEl,
      refs: {
        subNavSwitch,
        generalTab,
        structureTab,
        accountTab,
        otherTab,
        viewScrollbar,
        // Convenience aliases for external callers / tests
        windowMountSelect: structureTab.refs.windowMountSelect,
        multiSessionToggle: structureTab.refs.multiSessionToggle,
        topbarSlotsList: structureTab.refs.topbarSlotsList,
        stepModelSelect: otherTab.refs.stepModelSelect,
        orchestratorIdSelect: otherTab.refs.orchestratorIdSelect,
        autoUpdateSelect: generalTab.refs.autoUpdateSelect,
      },
    };
  },
});
