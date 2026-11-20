/**
 * @fileoverview Sliding SegmentedControl switcher with variable-width GPU glider.
 * Measures active button geometry via ResizeObserver so both inline variable-width
 * segments (e.g. "今天 / 1天 / ... / 自定义", "按步查看 (1520) / 总汇总") and equal-width
 * grid bars ("常规 / 结构 / 其他") glide smoothly without stretching from 0px on tab reveal.
 */

import { defineComponent } from '../../core/component.js';
import { h, patchAttr, patchClasses, patchStyleVar, patchText } from '../../core/domPatch.js';

export const SegmentedControl = defineComponent({
  name: 'SegmentedControl',
  setup({ getProps, setProps, emit, onCleanup }) {
    const gliderEl = h('div', { className: 'seg-glider', 'aria-hidden': 'true' });
    const rootEl = h(
      'div',
      {
        className: 'segmented',
        role: 'group',
        'aria-label': getProps().ariaLabel || '分段切换器',
      },
      [gliderEl]
    );

    const btnMap = new Map();
    let orderedBtns = [];
    let activeBtnEl = null;
    let observedBtnEl = null;
    let hasMeasuredVisible = false;
    let readyRafId = 0;

    function cancelReadyRaf() {
      if (readyRafId && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(readyRafId);
      }
      readyRafId = 0;
    }

    function syncGliderGeometry() {
      if (!activeBtnEl) {
        cancelReadyRaf();
        hasMeasuredVisible = false;
        patchClasses(rootEl, { 'has-glider': false });
        patchClasses(gliderEl, { 'is-ready': false });
        return;
      }

      const w = Number(activeBtnEl.offsetWidth || 0);
      const h = Number(activeBtnEl.offsetHeight || 0);
      if (!(w > 0 && h > 0)) {
        // Hidden parent tab or headless Mock DOM: keep .seg-btn.is-active fallback background
        // and snap cleanly on first real paint when tab becomes visible.
        cancelReadyRaf();
        hasMeasuredVisible = false;
        patchClasses(rootEl, { 'has-glider': false });
        patchClasses(gliderEl, { 'is-ready': false });
        return;
      }

      const x = Number(activeBtnEl.offsetLeft || 0);
      const y = Number(activeBtnEl.offsetTop || 0);
      patchStyleVar(gliderEl, '--glider-x', `${x}px`);
      patchStyleVar(gliderEl, '--glider-y', `${y}px`);
      patchStyleVar(gliderEl, '--glider-w', `${w}px`);
      patchStyleVar(gliderEl, '--glider-h', `${h}px`);
      patchClasses(rootEl, { 'has-glider': true });

      if (!hasMeasuredVisible) {
        hasMeasuredVisible = true;
        patchClasses(gliderEl, { 'is-ready': false });
        void gliderEl.offsetWidth;
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          cancelReadyRaf();
          readyRafId = window.requestAnimationFrame(() => {
            readyRafId = 0;
            if (hasMeasuredVisible) {
              patchClasses(gliderEl, { 'is-ready': true });
            }
          });
        } else {
          patchClasses(gliderEl, { 'is-ready': true });
        }
      }
    }

    let resizeObs = null;
    if (typeof ResizeObserver === 'function') {
      resizeObs = new ResizeObserver(() => {
        syncGliderGeometry();
      });
      resizeObs.observe(rootEl);
    }

    function updateObservedActiveButton(nextActiveBtn) {
      if (!resizeObs || observedBtnEl === nextActiveBtn) return;
      if (observedBtnEl) {
        try {
          resizeObs.unobserve(observedBtnEl);
        } catch {
          // ignore
        }
      }
      observedBtnEl = nextActiveBtn || null;
      if (observedBtnEl) {
        try {
          resizeObs.observe(observedBtnEl);
        } catch {
          // ignore
        }
      }
    }

    function selectValue(nextVal) {
      if (getProps().modelValue !== nextVal) {
        setProps({ modelValue: nextVal });
        emit('update:modelValue', nextVal);
      }
    }

    function syncSegments() {
      const { options = [], modelValue, ariaLabel } = getProps();
      if (ariaLabel) {
        patchAttr(rootEl, 'aria-label', ariaLabel);
      }

      const validKeys = new Set(options.map((opt) => String(opt.value)));
      for (const [key, btn] of btnMap.entries()) {
        if (!validKeys.has(key)) {
          if (btn.parentNode === rootEl) {
            rootEl.removeChild(btn);
          }
          btnMap.delete(key);
        }
      }

      orderedBtns = [];
      let nextActiveBtn = null;

      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        const key = String(opt.value);
        let btn = btnMap.get(key);
        if (!btn) {
          btn = h('button', {
            type: 'button',
            className: 'seg-btn',
            onClick: (e) => {
              e.stopPropagation();
              selectValue(opt.value);
            },
            onKeydown: (e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault();
                const curOpts = getProps().options || [];
                if (!curOpts.length) return;
                const curIdx = Math.max(
                  0,
                  curOpts.findIndex((o) => String(o.value) === key)
                );
                const delta = e.key === 'ArrowRight' ? 1 : -1;
                const nextIdx = (curIdx + delta + curOpts.length) % curOpts.length;
                const targetOpt = curOpts[nextIdx];
                if (targetOpt) {
                  selectValue(targetOpt.value);
                  btnMap.get(String(targetOpt.value))?.focus?.();
                }
              }
            },
          });
          btnMap.set(key, btn);
        }

        const active = opt.value === modelValue;
        patchText(btn, opt.label);
        patchClasses(btn, { 'is-active': active });
        patchAttr(btn, 'aria-pressed', active ? 'true' : 'false');
        patchAttr(btn, 'data-seg-value', opt.value);
        orderedBtns.push(btn);
        if (active) {
          nextActiveBtn = btn;
        }
      }

      // Ensure gliderEl remains index 0 and buttons follow in exact option order
      if (rootEl.firstChild !== gliderEl) {
        rootEl.insertBefore(gliderEl, rootEl.firstChild);
      }
      for (let i = 0; i < orderedBtns.length; i++) {
        const targetNode = orderedBtns[i];
        const currentAtSlot = rootEl.children[i + 1] || null;
        if (currentAtSlot !== targetNode) {
          rootEl.insertBefore(targetNode, currentAtSlot);
        }
      }

      activeBtnEl = nextActiveBtn || orderedBtns[0] || null;
      updateObservedActiveButton(activeBtnEl);
      syncGliderGeometry();
    }

    syncSegments();

    onCleanup(() => {
      cancelReadyRaf();
      resizeObs?.disconnect?.();
      resizeObs = null;
      observedBtnEl = null;
    });

    return {
      el: rootEl,
      refs: { gliderEl, refreshGlider: syncGliderGeometry },
      onPropsChange: syncSegments,
      getValue: () => getProps().modelValue,
    };
  },
});
