/**
 * @fileoverview Root Application Shell (App.js).
 * Combines the compact dual-layer header (TopSessionHeader + TopLongPillNav)
 * and single-viewport functional views.
 */

import { defineComponent } from './core/component.js';
import { h, patchAttr } from './core/domPatch.js';
import { isWindowOverlayMode } from './core/httpClient.js';
import { i18nStore } from './i18n/index.js';
import {
  normalizeClientWindowMountMode,
  resolveScopedConversation,
  telemetryStore,
} from './store/telemetryStore.js';
import { getViewTabs, uiStore } from './store/uiStore.js';
import { BridgeStatusNotice } from './components/settings/BridgeStatusNotice.js';
import { TopSessionHeader } from './components/layout/TopSessionHeader.js';
import { TopLongPillNav } from './components/ui/TopLongPillNav.js';
import { LiveOverviewView } from './views/LiveOverviewView.js';
import { ConsumptionView } from './views/ConsumptionView.js';
import { StepsDetailView } from './views/StepsDetailView.js';
import { SettingsView } from './views/SettingsView.js';

export const App = defineComponent({
  name: 'App',
  setup({ onCleanup }) {
    const sessionHeader = TopSessionHeader();
    const topPillNav = TopLongPillNav({
      modelValue: uiStore.getState().activeView,
      items: getViewTabs(),
      onUpdateModelValue: (nextView) => {
        uiStore.setState({ activeView: nextView });
      },
    });

    const overviewView = LiveOverviewView();
    const consumptionView = ConsumptionView();
    const stepsView = StepsDetailView();
    const settingsView = SettingsView();

    const globalBridgeNotice = BridgeStatusNotice({
      dismissible: true,
    });
    const bannerSlotEl = h('div', { className: 'app-bridge-banner-slot', hidden: true }, [
      globalBridgeNotice.el,
    ]);

    function syncGlobalBridgeBanner() {
      const activeView = uiStore.getState().activeView;
      const telemetry = telemetryStore.getState().telemetry;
      const settings = telemetry?.settings;
      const mountMode = settings
        ? normalizeClientWindowMountMode(settings.windowMountMode, settings.enableWindowOverlay)
        : 'sidebar';
      const hasCtxOverrides = Boolean(
        settings?.modelContextWindows && Object.keys(settings.modelContextWindows).length > 0
      );
      const shouldOfferGlobal =
        !isWindowOverlayMode() &&
        activeView !== 'settings' &&
        (mountMode !== 'sidebar' || hasCtxOverrides);
      globalBridgeNotice.refs.update({
        visible: shouldOfferGlobal,
        contextMode: mountMode === 'sidebar' && hasCtxOverrides,
        windowBridge: telemetry?.windowBridge || null,
        hostPlatform: telemetry?.hostPlatform || 'win32',
      });
      patchAttr(bannerSlotEl, 'hidden', globalBridgeNotice.el.hasAttribute('hidden'));
    }

    const viewMap = {
      overview: overviewView.el,
      consumption: consumptionView.el,
      steps: stepsView.el,
      settings: settingsView.el,
    };

    const stageEl = h('div', { className: 'viewport-stage' }, [
      overviewView.el,
      consumptionView.el,
      stepsView.el,
      settingsView.el,
    ]);

    const shellEl = h('main', { className: 'app-shell' }, [
      h('div', { className: 'top-deck' }, [sessionHeader.el, topPillNav.el]),
      bannerSlotEl,
      stageEl,
    ]);

    function syncStepsBadge() {
      const uiSt = uiStore.getState();
      const scopeForBadge = uiSt.activeView === 'steps' ? uiSt.selectedAgentScope : 'all';
      const { scopedConv } = resolveScopedConversation(
        telemetryStore.getState().telemetry,
        scopeForBadge,
        uiSt.ctxInspectorAgentId
      );
      const stepCount = scopedConv?.stepCount ?? 0;
      topPillNav.setProps({
        items: getViewTabs().map((tabItem) =>
          tabItem.value === 'steps'
            ? { ...tabItem, badge: stepCount > 0 ? stepCount : '' }
            : tabItem
        ),
      });
    }

    const unsubUi = uiStore.subscribe(
      (st) => st.activeView,
      (activeView) => {
        topPillNav.setValue(activeView);
        for (const [key, paneEl] of Object.entries(viewMap)) {
          patchAttr(paneEl, 'hidden', key !== activeView);
        }
        if (activeView === 'overview') {
          overviewView.refs?.viewScrollbar?.refresh();
        } else if (activeView === 'consumption') {
          consumptionView.refs?.viewScrollbar?.refresh();
        } else if (activeView === 'steps') {
          stepsView.refs?.refreshStepTableViewport?.();
          stepsView.refs?.stepsScroll?.refresh();
          stepsView.refs?.modelsScroll?.refresh();
        } else if (activeView === 'settings') {
          settingsView.refs?.viewScrollbar?.refresh();
        }
        syncStepsBadge();
        syncGlobalBridgeBanner();
      }
    );

    const unsubStepCount = telemetryStore.subscribe(
      (st) => ({
        stepCount: st.telemetry?.activeConversation?.stepCount ?? 0,
        totalStepsAllAgents: st.telemetry?.activeConversation?.totalStepsAllAgents ?? 0,
        subagentCount: st.telemetry?.activeConversation?.subagentCount ?? 0,
        windowMountMode: st.telemetry?.settings?.windowMountMode,
        enableWindowOverlay: st.telemetry?.settings?.enableWindowOverlay,
        modelContextWindows: st.telemetry?.settings?.modelContextWindows,
        windowBridge: st.telemetry?.windowBridge,
        hostPlatform: st.telemetry?.hostPlatform,
      }),
      () => {
        syncStepsBadge();
        syncGlobalBridgeBanner();
      }
    );

    const unsubScopeBadge = uiStore.subscribe(
      (st) => st.selectedAgentScope,
      () => syncStepsBadge()
    );

    const unsubI18n = i18nStore.subscribe(
      (st) => st.locale,
      () => {
        syncStepsBadge();
        globalBridgeNotice.refs.refreshLabels();
        patchAttr(bannerSlotEl, 'hidden', globalBridgeNotice.el.hasAttribute('hidden'));
      }
    );

    onCleanup(() => {
      unsubUi();
      unsubStepCount();
      unsubScopeBadge();
      unsubI18n();
      globalBridgeNotice.destroy();
      sessionHeader.destroy();
      topPillNav.destroy();
      overviewView.destroy();
      consumptionView.destroy();
      stepsView.destroy();
      settingsView.destroy();
    });

    return {
      el: shellEl,
      refs: {
        sessionHeader,
        topPillNav,
        globalBridgeNotice,
        overviewView,
        consumptionView,
        stepsView,
        settingsView,
      },
    };
  },
});
