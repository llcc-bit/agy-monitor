/**
 * @fileoverview Theme accent palette & panel font-scale appearance engine.
 * Applies CSS custom properties cleanly to Sidebar `:root` and Shadow DOM hosts,
 * while strictly isolating `#ag-usage-monitor-capsule` from font scaling.
 */

export const THEME_ACCENT_PRESETS = Object.freeze([
  { key: 'host', labelKey: 'settings.gen.accentHost', cssColor: '' },
  { key: 'blue', labelKey: 'settings.gen.accentBlue', cssColor: 'hsl(217 84% 53%)' },
  { key: 'emerald', labelKey: 'settings.gen.accentEmerald', cssColor: 'hsl(152 66% 39%)' },
  { key: 'amber', labelKey: 'settings.gen.accentAmber', cssColor: 'hsl(34 88% 46%)' },
  { key: 'violet', labelKey: 'settings.gen.accentViolet', cssColor: 'hsl(262 76% 58%)' },
  { key: 'cyan', labelKey: 'settings.gen.accentCyan', cssColor: 'hsl(191 82% 41%)' },
  { key: 'rose', labelKey: 'settings.gen.accentRose', cssColor: 'hsl(346 78% 54%)' },
]);

export const FONT_SCALE_FACTORS = Object.freeze({
  sm: 0.92,
  md: 1,
  lg: 1.14,
  xl: 1.28,
});

export const PANEL_SCALE_FACTORS = Object.freeze({
  sm: 1,
  md: 1,
  lg: 1.09,
  xl: 1.18,
});

export function normalizeClientThemeAccent(raw) {
  const val = String(raw ?? '').trim().toLowerCase();
  return THEME_ACCENT_PRESETS.some((p) => p.key === val) ? val : 'host';
}

export function normalizeClientFontScale(raw) {
  const val = String(raw ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(FONT_SCALE_FACTORS, val) ? val : 'md';
}

export function normalizeClientModernUi(raw) {
  if (typeof raw === 'string') {
    const lower = raw.trim().toLowerCase();
    return lower === 'true' || lower === '1' || lower === 'on';
  }
  return Boolean(raw);
}

/**
 * Check whether `el` (or its Shadow DOM host / document root) is currently under `[data-modern-ui="true"]`.
 *
 * @param {Node | null | undefined} el
 * @returns {boolean}
 */
export function isModernUiActiveForElement(el) {
  let cur = el || null;
  while (cur) {
    if (typeof cur.getAttribute === 'function' && cur.getAttribute('data-modern-ui') === 'true') {
      return true;
    }
    if (cur.parentNode) {
      cur = cur.parentNode;
    } else if (cur.host) {
      cur = cur.host;
    } else {
      break;
    }
  }
  if (typeof document !== 'undefined' && document.documentElement) {
    return document.documentElement.getAttribute?.('data-modern-ui') === 'true';
  }
  return false;
}

const LIGHT_THEME_CLASSES = new Set([
  'light',
  'vs-light',
  'vscode-light',
  'hc-light',
  'vscode-high-contrast-light',
]);

const DARK_THEME_CLASSES = new Set([
  'dark',
  'vs-dark',
  'vscode-dark',
  'hc-black',
  'vscode-high-contrast',
]);

function hslToRgb(hDeg, sPct, lPct) {
  const h = (((hDeg % 360) + 360) % 360) / 360;
  const s = Math.max(0, Math.min(1, sPct / 100));
  const l = Math.max(0, Math.min(1, lPct / 100));
  if (s === 0) {
    const v = l * 255;
    return [v, v, v];
  }
  const hue2rgb = (p, q, t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    hue2rgb(p, q, h + 1 / 3) * 255,
    hue2rgb(p, q, h) * 255,
    hue2rgb(p, q, h - 1 / 3) * 255,
  ];
}

function parseAlphaToken(rawAlpha) {
  if (rawAlpha == null || rawAlpha === '') return 1;
  const str = String(rawAlpha).trim();
  if (!str) return 1;
  if (str.endsWith('%')) {
    const pct = parseFloat(str);
    return Number.isFinite(pct) ? pct / 100 : 1;
  }
  const num = parseFloat(str);
  return Number.isFinite(num) ? num : 1;
}

/**
 * Parse `#hex`, `rgb()/rgba()`, or `hsl()/hsla()` into perceptual luminance `[0, 1]`.
 * Returns `null` when transparent (`alpha <= 0.15`) or unparseable.
 *
 * @param {string | null | undefined} rawColor
 * @returns {number | null}
 */
export function parseCssColorLuminance(rawColor) {
  const str = String(rawColor ?? '').trim().toLowerCase();
  if (!str || str === 'transparent' || str === 'none' || str === 'inherit' || str === 'initial') {
    return null;
  }

  if (str.startsWith('#')) {
    const hex = str.slice(1);
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 1;
    if (hex.length === 3 || hex.length === 4) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
      if (hex.length === 4) a = parseInt(hex[3] + hex[3], 16) / 255;
    } else if (hex.length === 6 || hex.length === 8) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
      if (hex.length === 8) a = parseInt(hex.slice(6, 8), 16) / 255;
    } else {
      return null;
    }
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || a <= 0.15) {
      return null;
    }
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  const rgbMatch = str.match(/^rgba?\(([^)]+)\)$/);
  if (rgbMatch) {
    const body = rgbMatch[1].trim();
    const [channelsPart, slashAlpha] = body.split('/');
    const parts = channelsPart
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean);
    if (parts.length < 3) return null;
    const parseChan = (tok) =>
      tok.endsWith('%') ? (parseFloat(tok) / 100) * 255 : parseFloat(tok);
    const r = parseChan(parts[0]);
    const g = parseChan(parts[1]);
    const b = parseChan(parts[2]);
    const a = slashAlpha !== undefined ? parseAlphaToken(slashAlpha) : parseAlphaToken(parts[3]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || a <= 0.15) {
      return null;
    }
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  const hslMatch = str.match(/^hsla?\(([^)]+)\)$/);
  if (hslMatch) {
    const body = hslMatch[1].trim();
    const [channelsPart, slashAlpha] = body.split('/');
    const parts = channelsPart
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean);
    if (parts.length < 3) return null;
    const h = parseFloat(parts[0]);
    const s = parseFloat(parts[1]);
    const l = parseFloat(parts[2]);
    const a = slashAlpha !== undefined ? parseAlphaToken(slashAlpha) : parseAlphaToken(parts[3]);
    if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l) || a <= 0.15) {
      return null;
    }
    const [r, g, b] = hslToRgb(h, s, l);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  return null;
}

function readStyleProp(el, cs, prop) {
  if (prop.startsWith('--')) {
    const inlineVal =
      typeof el?.style?.getPropertyValue === 'function'
        ? el.style.getPropertyValue(prop)
        : el?.style?.[prop];
    if (inlineVal && String(inlineVal).trim()) return String(inlineVal).trim();
    const compVal = cs?.getPropertyValue?.(prop);
    return compVal ? String(compVal).trim() : '';
  }
  const inlineVal = el?.style?.[prop];
  if (inlineVal && String(inlineVal).trim()) return String(inlineVal).trim();
  const compVal = cs?.[prop];
  return compVal ? String(compVal).trim() : '';
}

/**
 * Detect whether the active host surface is `'light'` or `'dark'`.
 * Inspects explicit Antigravity / VS Code theme classes & attributes first,
 * then actual computed surface/text luminance, then `prefers-color-scheme`.
 *
 * @param {HTMLElement | null | undefined} [targetEl]
 * @returns {'light' | 'dark'}
 */
export function detectHostColorScheme(targetEl = null) {
  const doc = typeof document !== 'undefined' ? document : null;
  const win = typeof window !== 'undefined' ? window : null;
  let workbenchEl = null;
  try {
    workbenchEl =
      typeof doc?.querySelector === 'function' ? doc.querySelector('.monaco-workbench') : null;
  } catch {
    workbenchEl = null;
  }

  const candidates = [];
  for (const el of [doc?.body, doc?.documentElement, workbenchEl, targetEl]) {
    if (el && !candidates.includes(el)) {
      candidates.push(el);
    }
  }

  // 1. Explicit host theme attributes & class tokens (never read our own data-color-scheme)
  for (const el of candidates) {
    const vscodeKind = String(el.getAttribute?.('data-vscode-theme-kind') || '')
      .trim()
      .toLowerCase();
    if (vscodeKind) {
      if (vscodeKind.includes('light')) return 'light';
      if (vscodeKind.includes('dark') || vscodeKind.includes('high-contrast')) return 'dark';
    }
    const dataTheme = String(
      el.getAttribute?.('data-theme') || el.getAttribute?.('data-color-mode') || ''
    )
      .trim()
      .toLowerCase();
    if (dataTheme === 'light' || dataTheme.endsWith('-light')) return 'light';
    if (dataTheme === 'dark' || dataTheme.endsWith('-dark')) return 'dark';

    const rawCls = typeof el.className === 'string' ? el.className : '';
    if (rawCls) {
      const tokens = rawCls.trim().toLowerCase().split(/\s+/);
      for (const tok of tokens) {
        if (LIGHT_THEME_CLASSES.has(tok)) return 'light';
        if (DARK_THEME_CLASSES.has(tok)) return 'dark';
      }
    }
  }

  // 2. Computed / inline surface background luminance
  const bgTargets = [];
  for (const el of [targetEl, doc?.body, doc?.documentElement, workbenchEl]) {
    if (el && !bgTargets.includes(el)) {
      bgTargets.push(el);
    }
  }
  const bgProps = [
    '--background',
    '--card',
    '--vscode-sideBar-background',
    '--vscode-editor-background',
    'backgroundColor',
  ];
  for (const el of bgTargets) {
    let cs = null;
    try {
      cs = typeof win?.getComputedStyle === 'function' ? win.getComputedStyle(el) : null;
    } catch {
      cs = null;
    }
    for (const prop of bgProps) {
      const lum = parseCssColorLuminance(readStyleProp(el, cs, prop));
      if (lum !== null) {
        return lum > 0.52 ? 'light' : 'dark';
      }
    }
  }

  // 3. Computed / inline foreground text luminance
  const fgProps = ['--foreground', '--vscode-foreground', '--vscode-editor-foreground', 'color'];
  for (const el of bgTargets) {
    let cs = null;
    try {
      cs = typeof win?.getComputedStyle === 'function' ? win.getComputedStyle(el) : null;
    } catch {
      cs = null;
    }
    for (const prop of fgProps) {
      const lum = parseCssColorLuminance(readStyleProp(el, cs, prop));
      if (lum !== null) {
        return lum < 0.48 ? 'light' : 'dark';
      }
    }
  }

  // 4. OS media query fallback
  try {
    if (win?.matchMedia?.('(prefers-color-scheme: dark)')?.matches) {
      return 'dark';
    }
  } catch {
    // ignore matchMedia errors
  }

  return 'light';
}

function setAttrIfChanged(el, name, value) {
  if (!el || typeof el.setAttribute !== 'function') return;
  if (typeof el.getAttribute === 'function' && el.getAttribute(name) === value) return;
  el.setAttribute(name, value);
}

function removeAttrIfPresent(el, name) {
  if (!el || typeof el.removeAttribute !== 'function') return;
  if (typeof el.hasAttribute === 'function' && !el.hasAttribute(name)) return;
  el.removeAttribute(name);
}

function setOrClearStyleVar(el, propName, value) {
  if (!el || !el.style) return;
  const cur =
    typeof el.style.getPropertyValue === 'function'
      ? el.style.getPropertyValue(propName)
      : el.style[propName] || '';
  if (value) {
    if (cur === value) return;
    if (typeof el.style.setProperty === 'function') {
      el.style.setProperty(propName, value);
    } else {
      el.style[propName] = value;
    }
  } else if (cur) {
    if (typeof el.style.removeProperty === 'function') {
      el.style.removeProperty(propName);
    } else if (typeof el.style.setProperty === 'function') {
      el.style.setProperty(propName, '');
    } else {
      el.style[propName] = '';
    }
  }
}

/**
 * Synchronize theme accent, host color scheme polarity, and (optionally) font scale tokens
 * onto a root/host element.
 *
 * @param {HTMLElement | null | undefined} targetEl
 * @param {object | null | undefined} settings
 * @param {{ includeFontScale?: boolean }} [options]
 */
export function applyAppearanceToRoot(targetEl, settings, { includeFontScale = true } = {}) {
  if (!targetEl || !targetEl.style) return;
  const accentKey = normalizeClientThemeAccent(settings?.themeAccent);
  const preset = THEME_ACCENT_PRESETS.find((p) => p.key === accentKey) || THEME_ACCENT_PRESETS[0];

  if (preset.key !== 'host' && preset.cssColor) {
    setOrClearStyleVar(targetEl, '--user-accent-primary', preset.cssColor);
    setOrClearStyleVar(targetEl, '--user-accent-contrast', '#ffffff');
  } else {
    setOrClearStyleVar(targetEl, '--user-accent-primary', '');
    setOrClearStyleVar(targetEl, '--user-accent-contrast', '');
  }
  setAttrIfChanged(targetEl, 'data-accent', preset.key);

  const colorScheme = detectHostColorScheme(targetEl);
  setAttrIfChanged(targetEl, 'data-color-scheme', colorScheme);

  const isModernUi = normalizeClientModernUi(settings?.experimentalModernUi);
  if (isModernUi) {
    setAttrIfChanged(targetEl, 'data-modern-ui', 'true');
  } else {
    removeAttrIfPresent(targetEl, 'data-modern-ui');
  }

  if (includeFontScale) {
    const scaleKey = normalizeClientFontScale(settings?.fontScale);
    const factor = FONT_SCALE_FACTORS[scaleKey] ?? 1;
    const panelFactor = PANEL_SCALE_FACTORS[scaleKey] ?? 1;
    setOrClearStyleVar(targetEl, '--ui-font-scale', factor === 1 ? '' : String(factor));
    setOrClearStyleVar(targetEl, '--ui-panel-scale', panelFactor === 1 ? '' : String(panelFactor));
    setAttrIfChanged(targetEl, 'data-font-scale', scaleKey);
  } else {
    setOrClearStyleVar(targetEl, '--ui-font-scale', '');
    setOrClearStyleVar(targetEl, '--ui-panel-scale', '');
    removeAttrIfPresent(targetEl, 'data-font-scale');
  }
}
