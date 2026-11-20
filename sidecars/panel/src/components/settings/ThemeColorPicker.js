/**
 * @fileoverview Host-aware Theme Accent Swatch Picker (`ThemeColorPicker.js`).
 * Provides the default "跟随宿主" (`host`) pill plus 6 curated color swatches.
 */

import { defineComponent } from '../../core/component.js';
import {
  THEME_ACCENT_PRESETS,
  normalizeClientThemeAccent,
} from '../../core/appearance.js';
import { h, patchAttr, patchClasses, patchStyleVar, patchText } from '../../core/domPatch.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { t } from '../../i18n/index.js';

export const ThemeColorPicker = defineComponent({
  name: 'ThemeColorPicker',
  setup({ props }) {
    let currentKey = normalizeClientThemeAccent(props.modelValue);

    const hostLabelEl = h('span', { text: t('settings.gen.accentHost') });
    const hostBtn = h(
      'button',
      {
        type: 'button',
        className: 'theme-host-chip',
        'data-accent-key': 'host',
        onClick: () => selectAccent('host'),
      },
      [hostLabelEl]
    );

    const swatchPresets = THEME_ACCENT_PRESETS.filter((p) => p.key !== 'host');
    const swatchEntries = swatchPresets.map((preset) => {
      const checkIcon = createSvgIcon('check', { size: 11 });
      const btn = h(
        'button',
        {
          type: 'button',
          className: 'theme-swatch-btn',
          'data-accent-key': preset.key,
          title: t(preset.labelKey),
          'aria-label': t(preset.labelKey),
          onClick: () => selectAccent(preset.key),
        },
        [checkIcon]
      );
      patchStyleVar(btn, '--swatch-color', preset.cssColor);
      return { preset, btn, checkIcon };
    });

    const swatchGroup = h(
      'span',
      { className: 'theme-swatch-group' },
      swatchEntries.map((s) => s.btn)
    );

    const rootEl = h('div', { className: 'theme-color-picker' }, [hostBtn, swatchGroup]);

    function syncVisuals() {
      const isHost = currentKey === 'host';
      patchClasses(hostBtn, { 'is-active': isHost });
      patchAttr(hostBtn, 'aria-pressed', isHost ? 'true' : 'false');
      for (const entry of swatchEntries) {
        const active = entry.preset.key === currentKey;
        patchClasses(entry.btn, { 'is-active': active });
        patchAttr(entry.btn, 'aria-pressed', active ? 'true' : 'false');
        patchAttr(entry.checkIcon, 'hidden', !active);
      }
    }

    function refreshLabels() {
      patchText(hostLabelEl, t('settings.gen.accentHost'));
      for (const entry of swatchEntries) {
        const label = t(entry.preset.labelKey);
        patchAttr(entry.btn, 'title', label);
        patchAttr(entry.btn, 'aria-label', label);
      }
    }

    function selectAccent(nextRaw) {
      const normalized = normalizeClientThemeAccent(nextRaw);
      if (normalized === currentKey) return;
      currentKey = normalized;
      syncVisuals();
      if (typeof props.onUpdateModelValue === 'function') {
        props.onUpdateModelValue(currentKey);
      }
    }

    function setValue(nextRaw) {
      currentKey = normalizeClientThemeAccent(nextRaw);
      syncVisuals();
    }

    syncVisuals();

    return {
      el: rootEl,
      refs: {
        hostBtn,
        swatchEntries,
        setValue,
        refreshLabels,
        getValue: () => currentKey,
      },
    };
  },
});
