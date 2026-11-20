/**
 * @fileoverview 通用 4 段式 Token 构成比例条组件 (FourSegmentBar).
 * 用于在消费概览、热门模型明细及数据来源明细中直观展示：
 * 直接输入 (Input)、缓存读取 (Cached)、内容生成 (Output) 与思考推理 (Thinking) 的 Token 占比。
 */

import { h, patchStyleVar } from '../../core/domPatch.js';

/**
 * 创建 4 段式水平比例进度条实例。
 * 通过动态更新各分段节点的 `--seg-w` CSS 变量实现零重排平滑过渡。
 *
 * @returns {{
 *   el: HTMLElement,
 *   update: (metrics: {
 *     inputTokens?: number,
 *     cacheReadTokens?: number,
 *     responseTokens?: number,
 *     thinkingTokens?: number
 *   }) => void
 * }} 组件根元素与增量更新方法
 */
export function createFourSegmentBar() {
  const segInput = h('div', { className: 'progress-seg seg-input' });
  const segCached = h('div', { className: 'progress-seg seg-cached' });
  const segOutput = h('div', { className: 'progress-seg seg-output' });
  const segThinking = h('div', { className: 'progress-seg seg-thinking' });
  const el = h('div', { className: 'progress-track cons-seg-bar' }, [
    segInput,
    segCached,
    segOutput,
    segThinking,
  ]);

  /**
   * 根据四类 Token 数量与整体行宽占比系数 (`scaleRatio`，默认 `1` 占满 100%) 重新计算并写入各分段百分比宽度。
   */
  function update({
    inputTokens = 0,
    cacheReadTokens = 0,
    responseTokens = 0,
    thinkingTokens = 0,
    scaleRatio = 1,
  }) {
    const sum = inputTokens + cacheReadTokens + responseTokens + thinkingTokens;
    const clampedRatio = Number.isFinite(Number(scaleRatio))
      ? Math.min(1, Math.max(0, Number(scaleRatio)))
      : 1;
    if (sum <= 0 || clampedRatio <= 0) {
      patchStyleVar(segInput, '--seg-w', '0%');
      patchStyleVar(segCached, '--seg-w', '0%');
      patchStyleVar(segOutput, '--seg-w', '0%');
      patchStyleVar(segThinking, '--seg-w', '0%');
      return;
    }
    patchStyleVar(segInput, '--seg-w', `${((inputTokens / sum) * 100 * clampedRatio).toFixed(2)}%`);
    patchStyleVar(segCached, '--seg-w', `${((cacheReadTokens / sum) * 100 * clampedRatio).toFixed(2)}%`);
    patchStyleVar(segOutput, '--seg-w', `${((responseTokens / sum) * 100 * clampedRatio).toFixed(2)}%`);
    patchStyleVar(segThinking, '--seg-w', `${((thinkingTokens / sum) * 100 * clampedRatio).toFixed(2)}%`);
  }

  return { el, update };
}
