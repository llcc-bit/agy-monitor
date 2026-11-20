/**
 * @fileoverview Incremental DOM patching utilities and keyed list reconciler.
 * Prevents full innerHTML replacements and preserves active DOM element state.
 */

export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, val] of Object.entries(props)) {
      if (val === undefined || val === null || val === false) continue;
      if (key === 'className' || key === 'class') {
        el.className = String(val);
      } else if (key === 'dataset' && typeof val === 'object') {
        for (const [dk, dv] of Object.entries(val)) {
          if (dv !== undefined && dv !== null) {
            el.dataset[dk] = String(dv);
          }
        }
      } else if (key.startsWith('on') && typeof val === 'function') {
        const evt = key.slice(2).toLowerCase();
        el.addEventListener(evt, val);
      } else if (key === 'text') {
        el.textContent = String(val);
      } else if (val === true) {
        el.setAttribute(key, '');
      } else {
        el.setAttribute(key, String(val));
      }
    }
  }
  const childArray = Array.isArray(children) ? children : [children];
  for (const child of childArray) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      el.appendChild(document.createTextNode(String(child)));
    } else {
      el.appendChild(child);
    }
  }
  return el;
}

export function patchText(el, nextValue) {
  if (!el) return false;
  const nextStr = String(nextValue ?? '');
  if (el.textContent === nextStr) {
    return false;
  }
  el.textContent = nextStr;
  return true;
}

export function patchAttr(el, attrName, nextValue) {
  if (!el) return false;
  if (nextValue === null || nextValue === undefined || nextValue === false) {
    let mutated = false;
    if (el.hasAttribute(attrName)) {
      el.removeAttribute(attrName);
      mutated = true;
    }
    if (attrName === 'value' && 'value' in el && el.value !== '') {
      el.value = '';
      mutated = true;
    }
    return mutated;
  }
  const strVal = nextValue === true ? '' : String(nextValue);
  let mutated = false;
  if (el.getAttribute(attrName) !== strVal) {
    el.setAttribute(attrName, strVal);
    mutated = true;
  }
  if (attrName === 'value' && 'value' in el && el.value !== strVal) {
    el.value = strVal;
    mutated = true;
  }
  return mutated;
}

export function patchClasses(el, classMap) {
  if (!el || !classMap) return false;
  let mutated = false;
  for (const [cls, active] of Object.entries(classMap)) {
    if (!cls) continue;
    const shouldHave = Boolean(active);
    const tokens = String(cls).split(/\s+/).filter(Boolean);
    for (const tok of tokens) {
      const has = el.classList.contains(tok);
      if (has !== shouldHave) {
        el.classList.toggle(tok, shouldHave);
        mutated = true;
      }
    }
  }
  return mutated;
}

export function patchStyleVar(el, varName, nextValue) {
  if (!el) return false;
  const strVal = String(nextValue ?? '');
  const prev = el.style.getPropertyValue(varName);
  if (prev === strVal) {
    return false;
  }
  el.style.setProperty(varName, strVal);
  return true;
}

/**
 * 判断事件是否发生在目标节点内部（兼容 Shadow DOM 的 `composedPath()` 穿透）。
 *
 * @param {Event|null|undefined} event
 * @param {Node|null|undefined} element
 * @returns {boolean}
 */
export function isEventInside(event, element) {
  if (!event || !element) return false;
  if (typeof event.composedPath === 'function') {
    const path = event.composedPath();
    if (Array.isArray(path) && path.includes(element)) {
      return true;
    }
  }
  const target = event.target;
  return Boolean(target && typeof element.contains === 'function' && element.contains(target));
}

const keyedListState = new WeakMap();

/**
 * Keyed incremental list reconciler.
 * Reuses existing DOM nodes by key and patches only changed items in-place.
 */
export function patchKeyedList(
  container,
  items,
  { keyFn = (_, i) => i, sigFn, createRow, updateRow, destroyRow } = {}
) {
  if (!container) return;
  let map = keyedListState.get(container);
  if (!map) {
    map = new Map();
    keyedListState.set(container, map);
  }

  const nextKeys = new Set();
  const seenInPass = new Map();
  const orderedNodes = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const rawKey = String(keyFn(item, i));
    const dupIdx = seenInPass.get(rawKey) || 0;
    seenInPass.set(rawKey, dupIdx + 1);
    const key = dupIdx === 0 ? rawKey : `${rawKey}__dup_${dupIdx}`;
    const sig = sigFn ? String(sigFn(item, i)) : JSON.stringify(item);
    nextKeys.add(key);

    let record = map.get(key);
    if (!record) {
      const created = createRow(item, i);
      record = {
        el: created.el,
        refs: created.refs,
        sig,
      };
      updateRow(record.refs, item, i, record.el);
      map.set(key, record);
    } else if (record.sig !== sig) {
      record.sig = sig;
      updateRow(record.refs, item, i, record.el);
    }
    orderedNodes.push(record.el);
  }

  // Remove stale keys
  for (const [oldKey, record] of map.entries()) {
    if (!nextKeys.has(oldKey)) {
      if (record.el.parentNode === container) {
        container.removeChild(record.el);
      }
      destroyRow?.(record.refs, record.el);
      map.delete(oldKey);
    }
  }

  if (!container.firstChild && orderedNodes.length > 1 && typeof document.createDocumentFragment === 'function') {
    const fragment = document.createDocumentFragment();
    for (const node of orderedNodes) {
      fragment.appendChild(node);
    }
    container.appendChild(fragment);
    return;
  }

  // Reorder or insert nodes with minimal DOM moves
  for (let i = 0; i < orderedNodes.length; i++) {
    const targetNode = orderedNodes[i];
    const currentNode = container.children[i] || null;
    if (currentNode !== targetNode) {
      container.insertBefore(targetNode, currentNode);
    }
  }
}

const CLIPPING_OVERFLOW_RE = /(?:hidden|clip|auto|scroll)/i;

/**
 * 解析浮层所在的可视裁剪边界（兼容 Shadow DOM 悬浮窗 `.wm-popover-panel`、
 * 侧栏 `.app-shell`、自定义滚动容器 `.custom-scroll-content` 与窗口视口）。
 *
 * @param {HTMLElement} anchorRootEl
 * @returns {{ left: number, top: number, right: number, bottom: number, width: number, height: number } | null}
 */
function resolvePopupBoundaryRect(anchorRootEl) {
  if (!anchorRootEl) return null;
  const winW = typeof window !== 'undefined' ? Number(window.innerWidth || 0) : 0;
  const winH = typeof window !== 'undefined' ? Number(window.innerHeight || 0) : 0;
  let boundLeft = 0;
  let boundTop = 0;
  let boundRight = winW > 0 ? winW : Infinity;
  let boundBottom = winH > 0 ? winH : Infinity;
  let hasBoundary = winW > 0 && winH > 0;

  const getStyle =
    typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle
      : null;

  let cur = anchorRootEl.parentNode || null;
  while (cur) {
    if (cur.nodeType === 1 || typeof cur.getBoundingClientRect === 'function') {
      const cls = cur.classList;
      const isShell = Boolean(
        cls?.contains?.('wm-popover-panel') ||
          cls?.contains?.('wm-multi-panel') ||
          cls?.contains?.('app-shell') ||
          cls?.contains?.('custom-scroll-host') ||
          cls?.contains?.('custom-scroll-content')
      );
      let clipsX = isShell;
      let clipsY = isShell;
      if (!isShell && getStyle) {
        try {
          const cs = getStyle(cur);
          if (cs) {
            clipsX = CLIPPING_OVERFLOW_RE.test(cs.overflowX || cs.overflow || '');
            clipsY = CLIPPING_OVERFLOW_RE.test(cs.overflowY || cs.overflow || '');
          }
        } catch {
          // 忽略 Mock DOM 样式查询异常
        }
      }
      if (clipsX || clipsY) {
        const r = cur.getBoundingClientRect?.();
        if (r && r.width > 0 && r.height > 0) {
          hasBoundary = true;
          if (clipsX) {
            boundLeft = Math.max(boundLeft, r.left);
            boundRight = Math.min(boundRight, r.right);
          }
          if (clipsY) {
            boundTop = Math.max(boundTop, r.top);
            boundBottom = Math.min(boundBottom, r.bottom);
          }
        }
      }
    }
    // 到达 ShadowRoot 或文档顶层后停止，避免误受宿主页面外层容器干扰
    if (!cur.parentNode) break;
    cur = cur.parentNode;
  }

  if (!hasBoundary || !Number.isFinite(boundRight) || !Number.isFinite(boundBottom)) {
    return null;
  }
  const width = Math.max(0, boundRight - boundLeft);
  const height = Math.max(0, boundBottom - boundTop);
  if (width <= 0 || height <= 0) return null;
  return { left: boundLeft, top: boundTop, right: boundRight, bottom: boundBottom, width, height };
}

/**
 * 为锚定在触发器上的绝对定位下拉浮层执行水平/垂直碰撞检测与边界夹紧：
 * - 水平方向优先左对齐，右侧溢出时切右对齐，仍越界则直接夹紧在容器可视安全区内；
 * - 垂直方向底部空间不足且上方更宽裕时自动向上翻转（追加 `.is-above`），并按可用空间收紧 `max-height`。
 *
 * @param {HTMLElement} rootEl 定位基准容器 (`position: relative`)
 * @param {HTMLElement} triggerEl 触发按钮
 * @param {HTMLElement} popupEl 下拉浮层 (`position: absolute`)
 * @param {{ margin?: number, gap?: number, maxHeight?: number, minFlipSpace?: number }} [opts]
 */
export function positionAnchoredPopup(
  rootEl,
  triggerEl,
  popupEl,
  { margin = 6, gap = 4, maxHeight = 220, minFlipSpace = 140 } = {}
) {
  if (!rootEl || !triggerEl || !popupEl || !popupEl.style) return;
  if (popupEl.hasAttribute?.('hidden')) return;

  const rootRect = rootEl.getBoundingClientRect?.();
  const triggerRect = triggerEl.getBoundingClientRect?.();
  if (
    !rootRect ||
    !triggerRect ||
    !(triggerRect.width > 0 && triggerRect.height > 0)
  ) {
    return;
  }

  const bound = resolvePopupBoundaryRect(rootEl);
  if (!bound) return;

  // 清除旧的动态夹紧值以便读取自然布局宽度
  popupEl.style.left = '';
  popupEl.style.right = '';
  popupEl.style.top = '';
  popupEl.style.bottom = '';
  popupEl.style.minWidth = '';
  popupEl.style.maxWidth = '';
  popupEl.style.maxHeight = '';

  const availWidth = Math.max(120, Math.floor(bound.width - margin * 2));
  popupEl.style.maxWidth = `${availWidth}px`;

  const rawRect = popupEl.getBoundingClientRect?.();
  // 优先读取 offsetWidth，避免入场动画 scale(0.975) 导致测宽偏小
  const naturalW = Math.max(
    Number(popupEl.offsetWidth || 0),
    Math.ceil(Number(rawRect?.width || 0))
  );
  if (naturalW > availWidth) {
    popupEl.style.minWidth = '0px';
  }
  const popupW = Math.min(availWidth, naturalW > 0 ? naturalW : Math.max(triggerRect.width, 210));

  const safeLeft = bound.left + margin;
  const safeRight = bound.right - margin;
  const rawLeft = Number(rawRect?.left);
  const rawRight = Number(rawRect?.right);
  const hasRawBox = Number.isFinite(rawLeft) && Number.isFinite(rawRight) && rawRight > rawLeft;
  // 若入场缩放动画（如 scale(0.975)）正在首帧生效，按对称补偿还原终态边界再判断是否越界
  const scalePadX = hasRawBox ? Math.max(0, (popupW - (rawRight - rawLeft)) / 2) : 0;
  const naturalLeft = hasRawBox ? rawLeft - scalePadX : triggerRect.left;
  const naturalRight = hasRawBox
    ? Math.max(rawRight + scalePadX, naturalLeft + popupW)
    : naturalLeft + popupW;
  const fitsAsDefault = hasRawBox && naturalLeft >= safeLeft && naturalRight <= safeRight;

  if (!fitsAsDefault) {
    let targetLeft = triggerRect.left;
    if (targetLeft + popupW > safeRight) {
      const rightAlignedLeft = triggerRect.right - popupW;
      if (rightAlignedLeft >= safeLeft) {
        targetLeft = rightAlignedLeft;
      } else {
        targetLeft = Math.max(safeLeft, safeRight - popupW);
      }
    }
    if (targetLeft < safeLeft) {
      targetLeft = safeLeft;
    }

    const offsetLeft = Math.round(targetLeft - rootRect.left);
    popupEl.style.left = `${offsetLeft}px`;
    popupEl.style.right = 'auto';
  }

  const spaceBelow = Math.max(0, bound.bottom - triggerRect.bottom - gap - margin);
  const spaceAbove = Math.max(0, triggerRect.top - bound.top - gap - margin);
  const naturalH = Math.max(
    Number(popupEl.scrollHeight || 0),
    Number(popupEl.offsetHeight || 0),
    Math.ceil(Number(rawRect?.height || 0))
  );
  const desiredH = maxHeight > 0 ? Math.min(maxHeight, naturalH || maxHeight) : naturalH || 240;
  const shouldOpenAbove =
    spaceBelow < Math.min(desiredH, minFlipSpace) && spaceAbove > spaceBelow;

  patchClasses(popupEl, { 'is-above': shouldOpenAbove });
  if (shouldOpenAbove) {
    popupEl.style.top = 'auto';
    popupEl.style.bottom = `calc(100% + ${gap}px)`;
    if (maxHeight > 0) {
      popupEl.style.maxHeight = `${Math.max(88, Math.floor(Math.min(maxHeight, spaceAbove)))}px`;
    }
  } else {
    popupEl.style.top = `calc(100% + ${gap}px)`;
    popupEl.style.bottom = 'auto';
    if (maxHeight > 0) {
      popupEl.style.maxHeight = `${Math.max(88, Math.floor(Math.min(maxHeight, spaceBelow)))}px`;
    }
  }
}
