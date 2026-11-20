/**
 * @fileoverview Antigravity Usage Monitor 面板 Sidecar HTTP 服务入口。
 *
 * 职责边界：
 * - 提供前端静态资产路由（`/`、`/app.js`、`/styles.css`，每次请求从磁盘读取最新产物）；
 * - 提供严格同端口 Loopback 受保护的 JSON API 路由；
 * - 在真实宿主环境中通过 `node:worker_threads` 托管 `./backend/sidecar-worker.mjs`：
 *   当插件在客户端未关闭时执行自更新或外部覆盖文件，主进程保持常驻不退出（守护 `SidecarApp` 宿主端口不断连），
 *   仅在后台毫秒级平滑替换为全新 V8 Isolate 的 Worker 实例并复用桥接端口，彻底消除热更新后的「重试中」失联问题。
 */

import { Worker } from 'node:worker_threads';
import { Response, SidecarApp } from 'sidecar_sdk';
import { BRIDGE_API_ROUTE_DEFS } from './shared/window-bridge-protocol.mjs';
import { isLocalHostRequest, readLocalAsync } from './backend/http-helpers.mjs';

const app = new SidecarApp();

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, no-cache, must-revalidate' };

const isTestHarnessEnv =
  String(process?.env?.ANTIGRAVITY_LS_ADDRESS || '').trim() === 'test.invalid' ||
  typeof Worker !== 'function';

// ---------------------------------------------------------------------------
// 热可替换后端 Worker 监督器（仅在真实宿主运行时启用，测试沙箱直接走内存分发）
// ---------------------------------------------------------------------------

let activeWorker = null;
let workerSwapPromise = null;
let rpcSeq = 0;
const pendingWorkerRpcs = new Map();

function createBackendWorkerInstance() {
  const workerUrl = new URL('./backend/sidecar-worker.mjs', import.meta.url);
  const worker = new Worker(workerUrl);

  worker.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'reload_request') {
      if (worker === activeWorker) {
        void reloadBackendWorker();
      }
      return;
    }
    if (msg.type === 'api_result' || msg.type === 'shutdown_ack') {
      const pending = pendingWorkerRpcs.get(msg.id);
      if (!pending) return;
      pendingWorkerRpcs.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.type === 'shutdown_ack' || msg.ok) {
        pending.resolve(msg.response ?? true);
      } else {
        pending.reject(new Error(msg.error || 'Backend worker error'));
      }
    }
  });

  worker.on('exit', () => {
    for (const [id, entry] of pendingWorkerRpcs.entries()) {
      if (entry.worker === worker) {
        pendingWorkerRpcs.delete(id);
        clearTimeout(entry.timer);
        entry.reject(new Error('Backend worker exited during request'));
      }
    }
    if (activeWorker === worker) {
      activeWorker = null;
      if (!workerSwapPromise) {
        setTimeout(() => {
          if (!activeWorker && !workerSwapPromise) {
            activeWorker = createBackendWorkerInstance();
          }
        }, 120).unref?.();
      }
    }
  });

  worker.on('error', () => {
    // 交由 exit 回调统一回收并拉起新实例
  });

  return worker;
}

function sendWorkerMessage(worker, payload, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = ++rpcSeq;
    const timer = setTimeout(() => {
      pendingWorkerRpcs.delete(id);
      reject(new Error('Backend worker request timeout'));
    }, timeoutMs);
    timer.unref?.();
    pendingWorkerRpcs.set(id, { worker, timer, resolve, reject });
    try {
      worker.postMessage({ ...payload, id });
    } catch (err) {
      pendingWorkerRpcs.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
}

async function stopWorkerGracefully(worker) {
  if (!worker) return;
  try {
    await sendWorkerMessage(worker, { type: 'shutdown' }, 1200);
  } catch {
    // 超时或通道已关闭时直接强制终止旧 Isolate
  }
  try {
    await worker.terminate();
  } catch {
    // 忽略重复终止异常
  }
}

function reloadBackendWorker() {
  if (workerSwapPromise) return workerSwapPromise;
  workerSwapPromise = (async () => {
    const prev = activeWorker;
    activeWorker = null;
    await stopWorkerGracefully(prev);
    activeWorker = createBackendWorkerInstance();
    return activeWorker;
  })().finally(() => {
    workerSwapPromise = null;
  });
  return workerSwapPromise;
}

async function ensureActiveWorker() {
  if (workerSwapPromise) {
    return workerSwapPromise;
  }
  if (!activeWorker) {
    activeWorker = createBackendWorkerInstance();
  }
  return activeWorker;
}

let testHarnessApiModulePromise = null;

function getTestHarnessApiModule() {
  testHarnessApiModulePromise ||= import('./backend/api-actions.mjs');
  return testHarnessApiModulePromise;
}

async function forwardApiCall(pathname, method, data) {
  if (isTestHarnessEnv) {
    if (typeof dispatchBridgeApiRequest === 'function') {
      return dispatchBridgeApiRequest(pathname, method, data);
    }
    const mod = await getTestHarnessApiModule();
    return mod.dispatchBridgeApiRequest(pathname, method, data);
  }
  const upperMethod = String(method || 'GET').toUpperCase();
  try {
    const worker = await ensureActiveWorker();
    return await sendWorkerMessage(worker, { type: 'api', pathname, method: upperMethod, data });
  } catch (err) {
    if (upperMethod === 'GET') {
      const retryWorker = await ensureActiveWorker();
      return sendWorkerMessage(retryWorker, { type: 'api', pathname, method: upperMethod, data });
    }
    throw err;
  }
}

async function handleProtectedApi(pathname, method, data, req) {
  if (!isLocalHostRequest(req)) {
    return new Response(JSON.stringify({ error: 'Forbidden host or origin' }), {
      status: 403,
      contentType: 'application/json',
    });
  }
  const out = await forwardApiCall(pathname, method, data);
  return new Response(out.body, {
    status: out.status,
    contentType: out.contentType,
    headers: out.headers,
  });
}

// ---------------------------------------------------------------------------
// 静态页面与前端资产路由
// ---------------------------------------------------------------------------

app.page(
  '/',
  async () =>
    new Response(await readLocalAsync('index.html'), {
      contentType: 'text/html; charset=utf-8',
      headers: NO_STORE_HEADERS,
    })
);

app.page(
  '/app.js',
  async () =>
    new Response(await readLocalAsync('app.js'), {
      contentType: 'application/javascript; charset=utf-8',
      headers: NO_STORE_HEADERS,
    })
);

app.page(
  '/styles.css',
  async () =>
    new Response(await readLocalAsync('styles.css'), {
      contentType: 'text/css; charset=utf-8',
      headers: NO_STORE_HEADERS,
    })
);

// ---------------------------------------------------------------------------
// 业务数据与控制 API 路由（统一源自 shared/window-bridge-protocol.mjs）
// ---------------------------------------------------------------------------

for (const route of BRIDGE_API_ROUTE_DEFS) {
  app.api(
    route.path,
    (data, req) =>
      handleProtectedApi(
        route.path,
        route.method,
        route.method === 'GET' && route.action !== 'telemetry' ? undefined : data,
        req
      ),
    route.method
  );
}

app.run();
if (isTestHarnessEnv) {
  if (typeof bootWindowBridgeRuntime === 'function') {
    bootWindowBridgeRuntime({ allowDynamicLs: false });
  } else {
    void getTestHarnessApiModule().then((mod) =>
      mod.bootWindowBridgeRuntime({ allowDynamicLs: false })
    );
  }
} else {
  void ensureActiveWorker();
}
