export const WINDOW_BRIDGE_KEY = '__AGUsageMonitorBridge';
export const WINDOW_BRIDGE_ROUTE_KEY = 'hostRouteCascadeId';
export const WINDOW_OVERLAY_KEY = '__AGUsageMonitorOverlay';
export const CONTEXT_WINDOWS_GLOBAL_KEY = '__AGUsageMonitorContextWindows';

export const WINDOW_OVERLAY_METHODS = Object.freeze({
  ensureAlive: 'ensureAlive',
  getDockKind: 'getDockKind',
  getMountMode: 'getMountMode',
  updateBridge: 'updateBridge',
  applyMountMode: 'applyMountMode',
  syncHostRoute: 'syncHostRoute',
  deliverRpc: 'deliverRpc',
  dispose: 'dispose',
});

export const BRIDGE_API_ROUTE_DEFS = Object.freeze([
  Object.freeze({ path: '/api/telemetry', method: 'GET', action: 'telemetry' }),
  Object.freeze({ path: '/api/settings', method: 'POST', action: 'settings' }),
  Object.freeze({ path: '/api/accounts', method: 'GET', action: 'accounts_get' }),
  Object.freeze({ path: '/api/accounts/update', method: 'POST', action: 'accounts_update' }),
  Object.freeze({ path: '/api/context-window', method: 'POST', action: 'context_window' }),
  Object.freeze({ path: '/api/settings/reset', method: 'POST', action: 'settings_reset' }),
  Object.freeze({ path: '/api/cache/rebuild', method: 'POST', action: 'cache_rebuild' }),
  Object.freeze({ path: '/api/cloud-sync', method: 'POST', action: 'cloud_sync' }),
  Object.freeze({ path: '/api/plugin-update', method: 'POST', action: 'plugin_update' }),
  Object.freeze({ path: '/api/bridge/relaunch', method: 'POST', action: 'bridge_relaunch' }),
]);

export const BRIDGE_API_PATHS = Object.freeze(BRIDGE_API_ROUTE_DEFS.map((r) => r.path));

export function readInjectedWindowBridge() {
  return typeof window === 'undefined' ? undefined : window[WINDOW_BRIDGE_KEY];
}
