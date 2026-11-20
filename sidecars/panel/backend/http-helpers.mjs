/**
 * @fileoverview 零业务状态依赖的静态资源读取与本机回环请求来源校验工具。
 *
 * 独立于 `./config.mjs` 与 `./api-actions.mjs`，使宿主入口 `main.mjs` 在生产环境下无需加载完整后端图谱与轨迹缓存。
 */

import { readFileSync, promises as fsPromises } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveHttpHelperPanelDir() {
  const modDir = dirname(fileURLToPath(import.meta.url));
  return /[\\/]backend$/i.test(modDir) ? dirname(modDir) : modDir;
}

/**
 * 异步读取 `sidecars/panel` 目录下的静态资源文件（兼容单元测试同步沙箱）。
 *
 * @param {string} relPath 相对路径
 * @returns {Promise<string>}
 */
export const readLocalAsync = async (relPath) => {
  const fullPath = join(resolveHttpHelperPanelDir(), relPath);
  if (typeof fsPromises !== 'undefined' && fsPromises?.readFile) {
    return fsPromises.readFile(fullPath, 'utf8');
  }
  return readFileSync(fullPath, 'utf8');
};

/**
 * 校验请求是否来自本机回环同端口地址 (`127.0.0.1` / `localhost` / `[::1]`) 或受信 Webview Origin，
 * 阻止跨端口本地服务（如本地其他端口的开发服务器）或跨站 DNS Rebinding 访问 API。
 *
 * @param {object} req
 * @returns {boolean}
 */
export function isLocalHostRequest(req) {
  if (!req?.headers) return true;
  const host = String(req.headers.host || '').trim().toLowerCase();
  const hostMatch = host.match(/^(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/);
  if (host && !hostMatch) {
    return false;
  }
  const origin = String(req.headers.origin || '').trim().toLowerCase();
  if (origin && /^vscode-webview:\/\/[a-z0-9._-]+$/.test(origin)) {
    return true;
  }
  const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (secFetchSite === 'cross-site') {
    return false;
  }
  if (origin) {
    const originMatch = origin.match(
      /^(https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/
    );
    if (!originMatch) {
      return false;
    }
    if (hostMatch) {
      const defaultPort = originMatch[1] === 'https' ? '443' : '80';
      const originPort = originMatch[3] || defaultPort;
      const hostPort = hostMatch[2] || defaultPort;
      if (originPort !== hostPort) {
        return false;
      }
    }
  }
  return true;
}
