/**
 * @fileoverview Reusable Drag-Sortable & `+` / `-` / `↑` / `↓` Dynamic Slot List (`EditableSlotList.js`).
 * Powers Topbar Capsule Slots (1..5), Hover Popup Modules (0..4),
 * Live Overview Modules (1..4), First-Row Metrics (1..4), and Step Table Columns (2..12).
 * Supports smooth pointer-based drag reordering with live preview callbacks (`onPreview`)
 * and single-commit persistence on drop (`onChange`).
 */

import { defineComponent } from '../../core/component.js';
import { h, patchAttr, patchClasses, patchText } from '../../core/domPatch.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { t } from '../../i18n/index.js';
import { CustomSelect } from '../ui/CustomSelect.js';

function isNodeWithin(target, container) {
  let cur = target;
  while (cur) {
    if (cur === container) return true;
    cur = cur.parentNode || cur.host || null;
  }
  return false;
}

function areSlotListsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export const EditableSlotList = defineComponent({
  name: 'EditableSlotList',
  setup({ props, onCleanup }) {
    const minItems = Math.max(0, Number(props.minItems ?? 1));
    const maxItems = Math.max(minItems, Number(props.maxItems ?? 5));
    let currentItems = Array.isArray(props.items) ? [...props.items] : [];
    let currentOptions = Array.isArray(props.options) ? [...props.options] : [];
    let emptyHintText = String(props.emptyHintText || '');
    let addBtnTextFn = typeof props.addBtnTextFn === 'function' ? props.addBtnTextFn : null;
    let activeDrag = null;

    const listEl = h('div', { className: 'editable-slot-list' });
    const emptyEl = h('div', {
      className: 'editable-slot-empty',
      hidden: true,
      text: emptyHintText,
    });

    const addBtnLabel = h('span', { text: '' });
    const addBtn = h(
      'button',
      {
        type: 'button',
        className: 'slot-add-btn',
        onClick: () => {
          if (currentItems.length >= maxItems) return;
          const usedSet = new Set(currentItems);
          const nextOpt = currentOptions.find((opt) => !usedSet.has(opt.value));
          if (!nextOpt) return;
          emitChange([...currentItems, nextOpt.value]);
        },
      },
      [createSvgIcon('plus', { size: 11 }), addBtnLabel]
    );

    const footerEl = h('div', { className: 'editable-slot-footer' }, [addBtn]);
    const rootEl = h('div', { className: 'editable-slot-wrap' }, [emptyEl, listEl, footerEl]);

    const rowPool = [];

    function emitChange(nextItems) {
      currentItems = [...nextItems];
      syncRows();
      if (typeof props.onPreview === 'function') {
        props.onPreview([...currentItems]);
      }
      if (typeof props.onChange === 'function') {
        props.onChange([...currentItems]);
      }
    }

    function teardownActiveDrag({ revert = false } = {}) {
      if (!activeDrag) return;
      const { startItems, hasMoved, cleanupListeners } = activeDrag;
      activeDrag = null;
      cleanupListeners();
      patchClasses(listEl, { 'is-dragging-list': false });
      for (const r of rowPool) {
        patchClasses(r.rowEl, { 'is-dragging': false });
      }
      if (revert && hasMoved && !areSlotListsEqual(startItems, currentItems)) {
        currentItems = [...startItems];
        syncRows();
        if (typeof props.onPreview === 'function') {
          props.onPreview([...currentItems]);
        }
      }
    }

    function startPointerDrag(e, initialRowIdx) {
      if (e && e.button != null && e.button !== 0) return;
      if (currentItems.length <= 1) return;
      if (activeDrag) {
        teardownActiveDrag({ revert: false });
      }

      const startY = Number(e?.clientY ?? 0);
      const startItems = [...currentItems];
      let dragIdx = initialRowIdx;
      let hasMoved = false;

      const onPointerMove = (ev) => {
        if (!activeDrag) return;
        const clientY = Number(ev?.clientY ?? startY);
        if (!hasMoved) {
          if (Math.abs(clientY - startY) < 4) return;
          hasMoved = true;
          activeDrag.hasMoved = true;
          for (let k = 0; k < currentItems.length; k += 1) {
            rowPool[k]?.selectComp?.close?.();
          }
          patchClasses(listEl, { 'is-dragging-list': true });
          if (rowPool[dragIdx]) {
            patchClasses(rowPool[dragIdx].rowEl, { 'is-dragging': true });
          }
        }
        ev?.preventDefault?.();

        let targetIdx = dragIdx;
        const count = currentItems.length;
        for (let i = 0; i < dragIdx; i += 1) {
          const rect = rowPool[i]?.rowEl?.getBoundingClientRect?.();
          if (rect && rect.height > 0 && clientY < rect.top + rect.height * 0.5) {
            targetIdx = i;
            break;
          }
        }
        if (targetIdx === dragIdx) {
          for (let i = count - 1; i > dragIdx; i -= 1) {
            const rect = rowPool[i]?.rowEl?.getBoundingClientRect?.();
            if (rect && rect.height > 0 && clientY > rect.top + rect.height * 0.5) {
              targetIdx = i;
              break;
            }
          }
        }

        if (targetIdx !== dragIdx) {
          if (rowPool[dragIdx]) {
            patchClasses(rowPool[dragIdx].rowEl, { 'is-dragging': false });
          }
          const next = [...currentItems];
          const [moved] = next.splice(dragIdx, 1);
          next.splice(targetIdx, 0, moved);
          dragIdx = targetIdx;
          activeDrag.dragIdx = dragIdx;
          currentItems = next;
          syncRows();
          if (rowPool[dragIdx]) {
            patchClasses(rowPool[dragIdx].rowEl, { 'is-dragging': true });
          }
          if (typeof props.onPreview === 'function') {
            props.onPreview([...currentItems]);
          }
        }
      };

      const onPointerUp = () => {
        if (!activeDrag) return;
        const moved = activeDrag.hasMoved;
        const changed = !areSlotListsEqual(startItems, currentItems);
        teardownActiveDrag({ revert: false });
        if (moved && changed) {
          emitChange([...currentItems]);
        }
      };

      const onPointerCancel = () => {
        teardownActiveDrag({ revert: true });
      };

      const onKeyDown = (ev) => {
        if (ev?.key === 'Escape') {
          teardownActiveDrag({ revert: true });
        }
      };

      const docTarget =
        typeof document !== 'undefined' && typeof document.addEventListener === 'function'
          ? document
          : null;

      if (docTarget) {
        docTarget.addEventListener('pointermove', onPointerMove);
        docTarget.addEventListener('pointerup', onPointerUp);
        docTarget.addEventListener('pointercancel', onPointerCancel);
        docTarget.addEventListener('keydown', onKeyDown);
      }

      activeDrag = {
        startItems,
        dragIdx,
        hasMoved: false,
        cleanupListeners: () => {
          if (docTarget && typeof docTarget.removeEventListener === 'function') {
            docTarget.removeEventListener('pointermove', onPointerMove);
            docTarget.removeEventListener('pointerup', onPointerUp);
            docTarget.removeEventListener('pointercancel', onPointerCancel);
            docTarget.removeEventListener('keydown', onKeyDown);
          }
        },
      };
    }

    function createSlotRow() {
      let rowIndex = 0;
      const dragHandle = h(
        'span',
        {
          className: 'slot-drag-handle',
          'aria-hidden': 'true',
          onPointerdown: (e) => {
            e.preventDefault?.();
            e.stopPropagation?.();
            startPointerDrag(e, rowIndex);
          },
        },
        [createSvgIcon('grip', { size: 12 })]
      );
      const indexBadge = h('span', { className: 'slot-index-badge text-mono', text: '1' });
      const selectComp = CustomSelect({
        modelValue: '',
        options: [],
        onUpdateModelValue: (nextVal) => {
          if (!nextVal || currentItems[rowIndex] === nextVal) return;
          if (currentItems.some((v, idx) => idx !== rowIndex && v === nextVal)) return;
          const next = [...currentItems];
          next[rowIndex] = nextVal;
          emitChange(next);
        },
      });

      const upBtn = h(
        'button',
        {
          type: 'button',
          className: 'slot-move-btn',
          onClick: (e) => {
            e.stopPropagation();
            if (rowIndex <= 0) return;
            const next = [...currentItems];
            const tmp = next[rowIndex - 1];
            next[rowIndex - 1] = next[rowIndex];
            next[rowIndex] = tmp;
            emitChange(next);
          },
        },
        [createSvgIcon('chevron-up', { size: 12 })]
      );

      const downBtn = h(
        'button',
        {
          type: 'button',
          className: 'slot-move-btn',
          onClick: (e) => {
            e.stopPropagation();
            if (rowIndex >= currentItems.length - 1) return;
            const next = [...currentItems];
            const tmp = next[rowIndex + 1];
            next[rowIndex + 1] = next[rowIndex];
            next[rowIndex] = tmp;
            emitChange(next);
          },
        },
        [createSvgIcon('chevron-down', { size: 12 })]
      );

      const removeBtn = h(
        'button',
        {
          type: 'button',
          className: 'slot-move-btn slot-remove-btn',
          onClick: (e) => {
            e.stopPropagation();
            if (currentItems.length <= minItems) return;
            const next = currentItems.filter((_, idx) => idx !== rowIndex);
            emitChange(next);
          },
        },
        [createSvgIcon('minus', { size: 12 })]
      );

      const orderBtnsEl = h('span', { className: 'slot-order-btns' }, [upBtn, downBtn, removeBtn]);

      const rowEl = h(
        'div',
        {
          className: 'editable-slot-row',
          onPointerdown: (e) => {
            if (isNodeWithin(e?.target, selectComp.el) || isNodeWithin(e?.target, orderBtnsEl)) {
              return;
            }
            startPointerDrag(e, rowIndex);
          },
        },
        [dragHandle, indexBadge, selectComp.el, orderBtnsEl]
      );

      return {
        rowEl,
        dragHandle,
        indexBadge,
        selectComp,
        upBtn,
        downBtn,
        removeBtn,
        setIndex(idx) {
          rowIndex = idx;
        },
      };
    }

    function syncRows() {
      const count = currentItems.length;
      patchAttr(emptyEl, 'hidden', count > 0 || !emptyHintText);
      if (emptyHintText) {
        patchText(emptyEl, emptyHintText);
      }
      patchAttr(listEl, 'hidden', count === 0);

      while (rowPool.length < count) {
        rowPool.push(createSlotRow());
      }

      while (listEl.children && listEl.children.length > count) {
        const tailIdx = listEl.children.length - 1;
        const tailChild = listEl.children[tailIdx];
        tailChild?.remove?.();
      }

      const canDrag = count > 1;
      const dragTitle = canDrag ? t('settings.slot.dragHint') : '';
      const canRemove = count > minItems;
      const removeTitle = canRemove
        ? t('settings.slot.remove')
        : t('settings.slot.minReached', { min: minItems });

      for (let i = 0; i < count; i += 1) {
        const entry = rowPool[i];
        const itemVal = currentItems[i];
        entry.setIndex(i);
        patchAttr(entry.rowEl, 'data-slot-row', String(i));
        patchText(entry.indexBadge, String(i + 1));
        patchClasses(entry.dragHandle, { 'is-disabled': !canDrag });
        patchAttr(entry.dragHandle, 'title', dragTitle || null);

        const otherUsed = new Set(currentItems.filter((_, idx) => idx !== i));
        const rowOpts = currentOptions.map((opt) => {
          const isTaken = otherUsed.has(opt.value);
          return isTaken
            ? {
                ...opt,
                disabled: true,
                meta: t('settings.slot.alreadyAdded'),
              }
            : opt;
        });

        entry.selectComp.setProps({
          modelValue: itemVal,
          options: rowOpts,
        });

        patchAttr(entry.upBtn, 'disabled', i === 0);
        patchAttr(entry.upBtn, 'title', t('settings.slot.moveUp'));
        patchAttr(entry.upBtn, 'aria-label', t('settings.slot.moveUp'));

        patchAttr(entry.downBtn, 'disabled', i === count - 1);
        patchAttr(entry.downBtn, 'title', t('settings.slot.moveDown'));
        patchAttr(entry.downBtn, 'aria-label', t('settings.slot.moveDown'));

        patchAttr(entry.removeBtn, 'disabled', !canRemove);
        patchAttr(entry.removeBtn, 'title', removeTitle);
        patchAttr(entry.removeBtn, 'aria-label', removeTitle);

        if (!listEl.children || listEl.children[i] !== entry.rowEl) {
          listEl.appendChild(entry.rowEl);
        }
      }

      // Close any hidden pooled selects
      for (let j = count; j < rowPool.length; j += 1) {
        rowPool[j].selectComp.close();
      }

      const usedAll = new Set(currentItems);
      const hasAvailableOption = currentOptions.some((opt) => !usedAll.has(opt.value));
      const disableAdd = count >= maxItems || !hasAvailableOption;
      patchAttr(addBtn, 'disabled', disableAdd);
      const addLabel = addBtnTextFn
        ? addBtnTextFn(count, maxItems)
        : `+ (${count}/${maxItems})`;
      patchText(addBtnLabel, addLabel);
    }

    function setProps(next = {}) {
      if (!activeDrag && Array.isArray(next.items)) {
        currentItems = [...next.items];
      }
      if (Array.isArray(next.options)) {
        currentOptions = [...next.options];
      }
      if (next.emptyHintText !== undefined) {
        emptyHintText = String(next.emptyHintText || '');
      }
      if (typeof next.addBtnTextFn === 'function') {
        addBtnTextFn = next.addBtnTextFn;
      }
      syncRows();
    }

    syncRows();

    onCleanup(() => {
      teardownActiveDrag({ revert: false });
      for (const entry of rowPool) {
        entry.selectComp.destroy();
      }
      rowPool.length = 0;
    });

    return {
      el: rootEl,
      refs: {
        listEl,
        addBtn,
        emptyEl,
        setProps,
        getItems: () => [...currentItems],
        getSelects: () => rowPool.slice(0, currentItems.length).map((r) => r.selectComp),
      },
    };
  },
});
