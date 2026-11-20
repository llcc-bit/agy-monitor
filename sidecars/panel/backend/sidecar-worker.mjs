/**
 * @fileoverview Hot-reloadable backend Worker runtime (`sidecar-worker.mjs`) for `main.mjs`.
 *
 * Isolates all ESM backend modules (`api-actions.mjs`, `telemetry-builder.mjs`, `window-bridge.mjs`,
 * `pricing-catalog.mjs`, etc.) inside a dedicated V8 Worker isolate so plugin updates (in-app Git/ZIP
 * or external file overwrite while Antigravity is open) can tear down and respawn a fresh Worker
 * without ever exiting the parent `SidecarApp` process or losing its host-assigned HTTP port.
 */

import { parentPort } from 'node:worker_threads';
import {
  bootBundleVersion,
  bootWindowBridgeRuntime,
  dispatchBridgeApiRequest,
} from './api-actions.mjs';
import { computeRuntimeCodeVersion } from './config.mjs';

let shuttingDown = false;
let reloadRequested = false;

function requestWorkerReload() {
  if (shuttingDown || reloadRequested) return;
  reloadRequested = true;
  try {
    parentPort?.postMessage({ type: 'reload_request' });
  } catch {
    // Ignore postMessage errors if parent is already closing
  }
}

const bridgeController = bootWindowBridgeRuntime({
  allowDynamicLs: true,
  onRestart: requestWorkerReload,
});

const driftWatchTimer = setInterval(() => {
  if (shuttingDown || reloadRequested) return;
  try {
    const diskVersion = String(computeRuntimeCodeVersion() || '');
    if (bootBundleVersion && diskVersion && diskVersion !== String(bootBundleVersion)) {
      requestWorkerReload();
    }
  } catch {
    // Ignore transient file stat errors while files are being overwritten
  }
}, 3000);
driftWatchTimer.unref?.();

async function gracefulStop() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(driftWatchTimer);
  try {
    await bridgeController?.stop?.({ disposeWindows: false });
  } catch {
    // Ignore shutdown errors
  }
}

parentPort?.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'shutdown') {
    await gracefulStop();
    try {
      parentPort?.postMessage({ type: 'shutdown_ack', id: msg.id });
    } catch {
      // Ignore closed channel
    }
    return;
  }

  if (msg.type === 'api') {
    const reqId = msg.id;
    try {
      const out = await dispatchBridgeApiRequest(
        String(msg.pathname || ''),
        String(msg.method || 'GET'),
        msg.data,
        { onRestart: requestWorkerReload }
      );
      parentPort?.postMessage({
        type: 'api_result',
        id: reqId,
        ok: true,
        response: {
          status: out?.status || 200,
          contentType: out?.contentType || 'application/json',
          headers: out?.headers || { 'Cache-Control': 'no-store' },
          body: typeof out?.body === 'string' ? out.body : JSON.stringify(out?.body ?? {}),
        },
      });
    } catch (err) {
      parentPort?.postMessage({
        type: 'api_result',
        id: reqId,
        ok: false,
        error: err?.message || 'Worker API execution failed',
      });
    }
  }
});

parentPort?.postMessage({ type: 'ready', bundleVersion: bootBundleVersion });
