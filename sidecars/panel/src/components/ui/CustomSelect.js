/**
 * @fileoverview Bespoke CustomSelect dropdown component replacing native <select> / <option>.
 * Supports both single-select and multi-select (`multiple: true`) modes, with incremental
 * option patching while open without losing focus or closing the menu.
 */

import { defineComponent } from '../../core/component.js';
import {
  h,
  isEventInside,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchText,
  positionAnchoredPopup,
} from '../../core/domPatch.js';
import { isEnglishLocale, t } from '../../i18n/index.js';
import { createSvgIcon, patchSvgIcon } from '../../icons/SvgIcon.js';

function normalizeMultiSelection(rawValue, options = [], allValue = '') {
  const arr = Array.isArray(rawValue)
    ? rawValue
    : rawValue !== undefined && rawValue !== null && rawValue !== ''
      ? [rawValue]
      : [];
  const clean = [];
  const seen = new Set();
  for (const item of arr) {
    const str = String(item ?? '');
    if (!str || seen.has(str)) continue;
    seen.add(str);
    clean.push(str);
  }
  if (allValue && (clean.length === 0 || clean.includes(allValue))) {
    return [allValue];
  }
  if (options.length > 0) {
    const validSet = new Set(options.map((o) => String(o.value)));
    const filtered = clean.filter((v) => validSet.has(v));
    if (filtered.length > 0) return filtered;
    return allValue ? [allValue] : [];
  }
  return clean;
}

function sameStringArray(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export const CustomSelect = defineComponent({
  name: 'CustomSelect',
  setup({ getProps, setProps, emit, onCleanup }) {
    let isOpen = false;
    let focusedIndex = -1;

    const initialIcon = getProps().icon;
    const leadIcon = createSvgIcon(initialIcon || 'bolt', { size: 13 });
    patchAttr(leadIcon, 'hidden', !initialIcon);
    const triggerLabel = h('span', { className: 'select-label' });
    const chevronIcon = createSvgIcon('chevron-down', { size: 13 });

    const triggerBtn = h(
      'button',
      {
        type: 'button',
        className: 'select-trigger',
        role: 'combobox',
        'aria-expanded': 'false',
        'aria-haspopup': 'listbox',
        onClick: (e) => {
          e.stopPropagation();
          toggleOpen(!isOpen);
        },
        onKeydown: handleKeydown,
      },
      [leadIcon, triggerLabel, chevronIcon]
    );

    const menuEl = h('div', {
      className: 'select-menu',
      role: 'listbox',
      hidden: true,
    });

    const initialClass = [
      'custom-select',
      getProps().multiple ? 'is-multi' : '',
      getProps().className,
    ]
      .filter(Boolean)
      .join(' ');
    const rootEl = h('div', { className: initialClass }, [triggerBtn, menuEl]);

    function getSelectedSet() {
      const { multiple, modelValue, options = [], allValue = '' } = getProps();
      if (!multiple) {
        return new Set(modelValue !== undefined && modelValue !== null ? [modelValue] : []);
      }
      return new Set(normalizeMultiSelection(modelValue, options, allValue));
    }

    function positionMenu() {
      if (!isOpen) return;
      positionAnchoredPopup(rootEl, triggerBtn, menuEl, {
        margin: 6,
        gap: 4,
        maxHeight: 220,
        minFlipSpace: 140,
      });
    }

    let boundReposition = false;
    function handleViewportChange(e) {
      if (!isOpen) return;
      if (e?.type === 'scroll' && e.target === menuEl) return;
      positionMenu();
    }

    function setRepositionListeners(active) {
      if (active === boundReposition) return;
      boundReposition = active;
      if (typeof window !== 'undefined' && window.addEventListener) {
        if (active) {
          window.addEventListener('resize', handleViewportChange, { passive: true });
          window.addEventListener('scroll', handleViewportChange, true);
        } else {
          window.removeEventListener('resize', handleViewportChange);
          window.removeEventListener('scroll', handleViewportChange, true);
        }
      }
    }

    function toggleOpen(nextOpen) {
      isOpen = Boolean(nextOpen);
      if (isOpen) {
        const opts = getProps().options || [];
        const selSet = getSelectedSet();
        focusedIndex = Math.max(
          0,
          opts.findIndex((o) => selSet.has(o.value))
        );
        renderMenuOptions();
      }
      patchClasses(rootEl, { 'is-open': isOpen });
      patchAttr(triggerBtn, 'aria-expanded', isOpen ? 'true' : 'false');
      patchAttr(menuEl, 'hidden', !isOpen);
      patchSvgIcon(chevronIcon, isOpen ? 'chevron-up' : 'chevron-down');
      setRepositionListeners(isOpen);
      if (isOpen) {
        positionMenu();
      }
    }

    function chooseOption(option) {
      if (!option) return;
      if (option.disabled && !getSelectedSet().has(option.value)) return;
      const { multiple, options = [], allValue = '', collapseAll = false } = getProps();
      if (!multiple) {
        const prevVal = getProps().modelValue;
        toggleOpen(false);
        if (option.value !== prevVal) {
          setProps({ modelValue: option.value });
          emit('update:modelValue', option.value);
        }
        return;
      }

      const prevList = normalizeMultiSelection(getProps().modelValue, options, allValue);
      const val = String(option.value);
      let nextList;
      if (allValue && val === allValue) {
        nextList = [allValue];
      } else {
        const base = prevList.filter((v) => v !== allValue);
        if (base.includes(val)) {
          const rest = base.filter((v) => v !== val);
          nextList = rest.length > 0 ? rest : allValue ? [allValue] : [val];
        } else {
          const addedSet = new Set([...base, val]);
          const ordered = options
            .filter((o) => String(o.value) !== allValue && addedSet.has(String(o.value)))
            .map((o) => String(o.value));
          nextList = ordered.length > 0 ? ordered : [...base, val];
          if (collapseAll && allValue) {
            const nonAllTotal = options.filter((o) => String(o.value) !== allValue).length;
            if (nonAllTotal > 0 && nextList.length >= nonAllTotal) {
              nextList = [allValue];
            }
          }
        }
      }

      if (!sameStringArray(prevList, nextList)) {
        setProps({ modelValue: nextList });
        emit('update:modelValue', nextList);
      } else {
        renderMenuOptions();
      }
    }

    function handleKeydown(e) {
      const opts = getProps().options || [];
      if (!opts.length) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!isOpen) {
          toggleOpen(true);
        } else {
          focusedIndex = (focusedIndex + 1) % opts.length;
          renderMenuOptions();
          menuEl.children[focusedIndex]?.scrollIntoView?.({ block: 'nearest' });
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!isOpen) {
          toggleOpen(true);
        } else {
          focusedIndex = (focusedIndex - 1 + opts.length) % opts.length;
          renderMenuOptions();
          menuEl.children[focusedIndex]?.scrollIntoView?.({ block: 'nearest' });
        }
      } else if ((e.key === 'Enter' || (e.key === ' ' && isOpen && getProps().multiple)) && isOpen) {
        e.preventDefault();
        const target = opts[focusedIndex];
        if (target) chooseOption(target);
      } else if (e.key === 'Escape' && isOpen) {
        e.preventDefault();
        toggleOpen(false);
      }
    }

    function renderMenuOptions() {
      const { options = [], multiple = false } = getProps();
      const selSet = getSelectedSet();
      patchAttr(menuEl, 'aria-multiselectable', multiple ? 'true' : null);
      patchKeyedList(menuEl, options, {
        keyFn: (opt) => opt.value,
        sigFn: (opt, idx) =>
          `${multiple}::${opt.value}::${opt.label}::${opt.meta || ''}::${Boolean(opt.disabled)}::${selSet.has(opt.value)}::${idx === focusedIndex}`,
        createRow: (opt) => {
          const checkboxIcon = createSvgIcon('check', { size: 10 });
          const checkboxBox = h('span', { className: 'select-checkbox', hidden: true }, [
            checkboxIcon,
          ]);
          const textSpan = h('span', { className: 'select-option-text' });
          const metaSpan = h('span', { className: 'text-muted select-option-meta' });
          const checkIcon = createSvgIcon('check', { size: 12 });
          const btn = h(
            'button',
            {
              type: 'button',
              role: 'option',
              className: 'select-option',
              onClick: (e) => {
                e.stopPropagation();
                const latestOpt =
                  (getProps().options || []).find((o) => o.value === opt.value) || opt;
                chooseOption(latestOpt);
              },
            },
            [checkboxBox, textSpan, metaSpan, checkIcon]
          );
          return { el: btn, refs: { checkboxBox, checkboxIcon, textSpan, metaSpan, checkIcon } };
        },
        updateRow: (refs, opt, idx, el) => {
          const isMulti = Boolean(getProps().multiple);
          const selected = selSet.has(opt.value);
          const focused = idx === focusedIndex;
          const isDisabled = Boolean(opt.disabled && !selected);
          patchAttr(refs.checkboxBox, 'hidden', !isMulti);
          patchClasses(refs.checkboxBox, { 'is-checked': selected });
          patchAttr(refs.checkboxIcon, 'hidden', !selected);
          patchText(refs.textSpan, opt.label);
          patchText(refs.metaSpan, opt.meta || '');
          patchAttr(refs.metaSpan, 'hidden', !opt.meta);
          patchAttr(refs.checkIcon, 'hidden', isMulti || !selected);
          patchClasses(el, {
            'is-selected': selected,
            'is-focused': focused,
            'is-disabled': isDisabled,
          });
          patchAttr(el, 'disabled', isDisabled);
          patchAttr(el, 'aria-disabled', isDisabled ? 'true' : null);
          patchAttr(el, 'aria-selected', selected ? 'true' : 'false');
          patchAttr(el, 'data-value', opt.value);
        },
      });
    }

    function syncTriggerAndMenu() {
      const {
        options = [],
        modelValue,
        placeholder = t('fmt.selectPlaceholder'),
        icon,
        multiple = false,
        allValue = '',
        multiUnit = isEnglishLocale() ? 'items' : '项',
      } = getProps();
      patchClasses(rootEl, { 'is-multi': Boolean(multiple) });
      patchAttr(leadIcon, 'hidden', !icon);
      if (icon) {
        patchSvgIcon(leadIcon, icon);
      }

      let labelText = placeholder;
      let titleText = placeholder;

      if (multiple) {
        const vals = normalizeMultiSelection(modelValue, options, allValue);
        if ((allValue && vals.includes(allValue)) || vals.length === 0) {
          const allOpt = options.find((o) => String(o.value) === allValue);
          labelText = allOpt ? allOpt.label : placeholder;
          titleText = labelText;
        } else if (vals.length === 1) {
          const singleOpt = options.find((o) => String(o.value) === vals[0]);
          labelText = singleOpt ? singleOpt.label : vals[0];
          titleText = labelText;
        } else {
          const names = vals.map((v) => options.find((o) => String(o.value) === v)?.label || v);
          labelText = t('fmt.selectedCount', { count: vals.length, unit: multiUnit });
          titleText = t('fmt.selectedListTitle', {
            count: vals.length,
            names: names.join(isEnglishLocale() ? ', ' : '、'),
          });
        }
      } else {
        const matchedOpt = options.find((o) => o.value === modelValue);
        const selectedOpt = matchedOpt || (!modelValue ? options[0] : undefined);
        const fallbackText = modelValue
          ? `${placeholder} (${String(modelValue).slice(0, 8)})`
          : placeholder;
        labelText = selectedOpt ? selectedOpt.label : fallbackText;
        titleText = labelText;
      }

      patchText(triggerLabel, labelText);
      patchAttr(triggerBtn, 'title', titleText);
      if (isOpen) {
        renderMenuOptions();
        positionMenu();
      }
    }

    const handleDocClick = (e) => {
      if (isOpen && !isEventInside(e, rootEl)) {
        toggleOpen(false);
      }
    };

    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('click', handleDocClick, true);
      onCleanup(() => {
        setRepositionListeners(false);
        document.removeEventListener('click', handleDocClick, true);
      });
    } else {
      onCleanup(() => setRepositionListeners(false));
    }

    syncTriggerAndMenu();

    return {
      el: rootEl,
      refs: { triggerBtn, triggerLabel, menuEl },
      onPropsChange: syncTriggerAndMenu,
      methods: {
        close: () => toggleOpen(false),
      },
    };
  },
});
