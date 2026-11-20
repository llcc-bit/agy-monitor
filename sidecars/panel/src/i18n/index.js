/**
 * @fileoverview Reactive lightweight i18n engine (`zh-CN` / `en-US` / `auto`).
 * Default language is `'zh-CN'` so out-of-the-box UI matches existing behavior 100%.
 */

import { createReactiveStore } from '../core/reactive.js';
import { normalizeLanguageSetting } from '../../shared/settings-normalization.mjs';
import { I18N_MESSAGES_ZH_CN } from './zh-CN.js';
import { I18N_MESSAGES_EN_US } from './en-US.js';

export const I18N_DICTIONARIES = Object.freeze({
  'zh-CN': I18N_MESSAGES_ZH_CN,
  'en-US': I18N_MESSAGES_EN_US,
});

export function normalizeI18nLanguage(raw) {
  return normalizeLanguageSetting(raw);
}

export function detectHostSystemLocale() {
  try {
    if (typeof navigator !== 'undefined' && navigator.language) {
      return String(navigator.language).toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
    }
  } catch {
    // Ignore environment navigator read errors
  }
  return 'zh-CN';
}

export const i18nStore = createReactiveStore({
  language: 'zh-CN',
  locale: 'zh-CN',
});

export function setI18nLanguage(rawLang) {
  const language = normalizeI18nLanguage(rawLang);
  const locale = language === 'auto' ? detectHostSystemLocale() : language;
  const cur = i18nStore.getState();
  if (cur.language !== language || cur.locale !== locale) {
    i18nStore.setState({ language, locale });
  }
  return locale;
}

export function getEffectiveLocale() {
  return i18nStore.getState().locale || 'zh-CN';
}

export function isEnglishLocale() {
  return getEffectiveLocale() === 'en-US';
}

/**
 * Translate a message key with optional `{name}` variable interpolation.
 *
 * @param {string} key
 * @param {Record<string, string | number>} [vars]
 * @returns {string}
 */
export function t(key, vars = undefined) {
  const locale = getEffectiveLocale();
  const dict = I18N_DICTIONARIES[locale] || I18N_MESSAGES_ZH_CN;
  const template = dict[key] ?? I18N_MESSAGES_ZH_CN[key] ?? key;
  if (!vars || typeof template !== 'string') return template;
  return template.replace(/\{(\w+)\}/g, (_, k) =>
    vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''
  );
}
