/** @fileoverview Saved account credentials and the host's active account quota. */

import { defineComponent } from '../../core/component.js';
import { h, patchAttr, patchKeyedList, patchText } from '../../core/domPatch.js';
import { callSidecarApi } from '../../core/httpClient.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';
import { fetchTelemetry } from '../../store/telemetryStore.js';

const key = (name) => `settings.account.${name}`;
const errors = new Set([
  'unsupported', 'invalidEmail', 'invalidCredential', 'credentialTooLarge', 'notFound',
  'noCurrentCredential', 'busy', 'storeFailed', 'rollbackFailed', 'credentialAccessDenied',
  'credentialChanged', 'credentialRejected', 'identityMismatch', 'oauthClientUnavailable',
  'oauthUnavailable', 'quotaUnavailable',
]);

function renderQuotaRows(container, quotaPools) {
  const locale = getEffectiveLocale();
  const pools = quotaPools.filter((pool) => Number.isFinite(pool.remainingPct) || Number.isFinite(pool.weeklyRemainingPct));
  patchKeyedList(container, pools, {
    keyFn: (pool) => pool.poolKey || pool.poolLabel,
    sigFn: (pool) => JSON.stringify([locale, pool.poolLabel, pool.remainingPct, pool.weeklyRemainingPct]),
    createRow: () => {
      const label = h('span');
      const remaining = h('span', { className: 'settings-account-quota' });
      return { el: h('div', { className: 'settings-action-block' }, [label, remaining]), refs: { label, remaining } };
    },
    updateRow: ({ label, remaining }, pool) => {
      patchText(label, pool.poolLabel || pool.poolKey);
      const values = [];
      if (Number.isFinite(pool.remainingPct)) values.push(t(key('quota5h'), { percent: pool.remainingPct }));
      if (Number.isFinite(pool.weeklyRemainingPct)) values.push(t(key('quotaWeekly'), { percent: pool.weeklyRemainingPct }));
      patchText(remaining, values.join(' · '));
    },
  });
  return pools.length;
}

export const SettingsAccountTab = defineComponent({
  name: 'SettingsAccountTab',
  setup({ props, onCleanup }) {
    let account = null;
    let quotas = null;
    let accounts = [];
    let selectedEmail = '';
    let supported = null;
    let operation = '';
    let status = '';
    let disposed = false;
    const savedQuotas = new Map();

    const title = h('span', { className: 'panel-title' });
    const identityLabel = h('div', { className: 'settings-action-title' });
    const identity = h('div', { className: 'settings-action-desc settings-account-identity' });
    const plan = h('div', { className: 'settings-action-desc' });
    const quotaTitle = h('div', { className: 'settings-action-title' });
    const quotaRows = h('div', { className: 'settings-account-list' });
    const quotaMessage = h('div', { className: 'settings-action-desc' });
    const savedTitle = h('span', { className: 'panel-title' });
    const savedRows = h('div', { className: 'settings-account-list' });
    const savedMessage = h('div', { className: 'settings-action-desc' });
    const pending = h('div', { className: 'settings-action-desc', role: 'status' });
    const feedback = h('div', { className: 'settings-action-desc', role: 'status' });
    const capture = h('button', { type: 'button', className: 'btn-secondary', onClick: () => request('capture') });
    const reload = h('button', { type: 'button', className: 'btn-secondary', onClick: () => request('list') });
    const credentialLabel = h('span');
    const importHint = h('div', { className: 'settings-action-desc' });
    const credential = h('input', { type: 'password', required: true, autocomplete: 'off', spellcheck: 'false', maxlength: 16384 });
    const save = h('button', { type: 'submit', className: 'btn-secondary' });
    const form = h('form', { className: 'settings-account-form', autocomplete: 'off', onSubmit: importCredential }, [
      h('label', {}, [credentialLabel, credential]),
      importHint,
      save,
    ]);

    function render() {
      const signedIn = account?.status === 'signedIn';
      const activeEmail = signedIn ? account.email?.trim().toLowerCase() : '';
      const canWrite = supported === true && !operation;
      const locale = getEffectiveLocale();
      patchText(title, t(key('current')));
      patchText(identityLabel, t(key('email')));
      patchText(identity, signedIn ? account.email || account.name :
        t(key(account?.status === 'signedOut' ? 'signedOut' : 'unknown')));
      patchText(plan, signedIn ? account.tierName || account.planName || '' : '');
      patchAttr(plan, 'hidden', !plan.textContent);

      patchText(quotaTitle, t(key('quota')));
      const poolCount = renderQuotaRows(quotaRows, signedIn ? quotas?.pools || [] : []);
      patchText(quotaMessage, t(key(poolCount ? 'quotaStale' : 'noQuota')));
      patchAttr(quotaMessage, 'hidden', poolCount > 0 && !quotas?.meta?.isStale);

      patchText(savedTitle, t(key('savedCredentials')));
      patchText(capture, t(key('capture')));
      patchText(reload, t(key('reload')));
      patchText(save, t(key('save')));
      patchText(credentialLabel, t(key('credential')));
      patchText(importHint, t(key('importHint')));
      patchAttr(capture, 'disabled', !canWrite || !activeEmail);
      patchAttr(reload, 'disabled', Boolean(operation));
      patchAttr(form, 'hidden', supported === false);
      patchAttr(save, 'disabled', !canWrite);
      patchAttr(credential, 'disabled', !canWrite);
      patchText(savedMessage, t(key(supported === null ? 'loading' : 'empty')));
      patchAttr(savedMessage, 'hidden', accounts.length > 0 || supported === false || Boolean(status));
      const message = status || (operation === 'switch' ? 'switching' : operation === 'quota' ? 'loadingQuota' :
        operation === 'save' || operation === 'capture' ? 'verifying' : '');
      patchText(feedback, message ? t(key(message)) : '');
      patchAttr(feedback, 'hidden', !message);
      const waiting = selectedEmail && activeEmail !== selectedEmail;
      patchText(pending, waiting ? t(key('pending'), { email: selectedEmail }) : '');
      patchAttr(pending, 'hidden', !waiting);

      patchKeyedList(savedRows, accounts, {
        keyFn: (addr) => addr,
        sigFn: (addr) => JSON.stringify([locale, activeEmail, selectedEmail, canWrite, savedQuotas.get(addr)]),
        createRow: (addr) => {
          const state = h('div', { className: 'settings-action-desc' });
          const select = h('button', {
            type: 'button', className: 'btn-secondary settings-account-switch', onClick: () => request('switch', { email: addr }),
          });
          const remove = h('button', {
            type: 'button', className: 'btn-secondary', onClick: () => request('remove', { email: addr }),
          });
          const loadQuota = h('button', {
            type: 'button', className: 'btn-secondary settings-account-load-quota', onClick: () => request('quota', { email: addr }),
          });
          const rows = h('div', { className: 'settings-account-list' });
          const empty = h('div', { className: 'settings-action-desc' });
          return {
            el: h('div', { className: 'settings-account-entry' }, [
              h('div', { className: 'settings-action-block' }, [
                h('div', { className: 'settings-action-info' }, [h('div', { className: 'settings-account-identity', text: addr }), state]),
                h('div', { className: 'settings-account-buttons' }, [loadQuota, select, remove]),
              ]), rows, empty,
            ]),
            refs: { state, select, remove, loadQuota, rows, empty },
          };
        },
        updateRow: (row, addr) => {
          const active = addr === activeEmail;
          const written = addr === selectedEmail && !active;
          patchText(row.state, active ? t(key('active')) : written ? t(key('written')) : '');
          patchAttr(row.state, 'hidden', !active && !written);
          patchText(row.select, t(key('switch')));
          patchText(row.remove, t(key('remove')));
          patchText(row.loadQuota, t(key('loadQuota')));
          patchAttr(row.select, 'disabled', !canWrite);
          patchAttr(row.remove, 'disabled', !canWrite);
          patchAttr(row.loadQuota, 'disabled', !canWrite);
          const cached = savedQuotas.get(addr);
          const count = renderQuotaRows(row.rows, cached || []);
          patchText(row.empty, t(key('emptyCredentialQuota')));
          patchAttr(row.empty, 'hidden', !cached || count > 0);
        },
      });
      props.onLayoutChange?.();
    }

    async function request(action, fields) {
      if (operation) return;
      operation = action;
      status = '';
      render();
      try {
        const result = action === 'list'
          ? await callSidecarApi('/api/accounts')
          : await callSidecarApi('/api/accounts/update', { method: 'POST', body: { action, ...fields }, cdpTimeoutMs: 40000 });
        if (disposed) return;
        if (result?.error) {
          if (result.error === 'unsupported') supported = false;
          status = errors.has(result.error) ? result.error : 'storeFailed';
          return;
        }
        if (action === 'quota') {
          savedQuotas.set(result.email, result.pools);
          return;
        }
        supported = result?.supported === true;
        accounts = result?.accounts || [];
        selectedEmail = result?.selectedEmail || '';
        if (action === 'save' || action === 'capture') status = 'saved';
        if (action === 'remove') {
          savedQuotas.delete(fields.email);
          status = 'removed';
        }
        if (action === 'switch') {
          status = result.confirmed ? 'switched' : '';
          void fetchTelemetry({ force: true }).catch(() => {});
        }
      } catch {
        status = 'storeFailed';
      } finally {
        operation = '';
        if (!disposed) render();
      }
    }

    function importCredential(event) {
      event.preventDefault();
      if (operation) return;
      const input = credential.value;
      credential.value = '';
      void request('save', { credential: input });
    }

    function renderAccount(value, quotaData) {
      if (account === value && quotas === quotaData) return;
      account = value;
      quotas = quotaData;
      render();
    }

    const root = h('div', { className: 'settings-tab-stack' }, [
      h('section', { className: 'panel' }, [
        h('div', { className: 'panel-header' }, [title]),
        h('div', { className: 'settings-action-block' }, [
          h('div', { className: 'settings-action-info' }, [identityLabel, identity, plan]),
        ]),
        quotaTitle, quotaRows, quotaMessage, pending,
      ]),
      h('section', { className: 'panel' }, [
        h('div', { className: 'panel-header' }, [savedTitle]),
        h('div', { className: 'settings-account-buttons' }, [capture, reload]),
        savedRows, savedMessage, form, feedback,
      ]),
    ]);
    render();
    onCleanup(() => {
      disposed = true;
      credential.value = '';
    });
    return { el: root, refs: { renderAccount, refreshLabels: render, load: () => request('list') } };
  },
});
