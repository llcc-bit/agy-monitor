/**
 * @fileoverview Shared lightweight W3C-compatible Mock DOM for Node `vm` UI & overlay tests.
 * Replaces 6 separate copy-pasted inline mock DOM classes across `window-bridge.test.mjs`.
 */

const ATTR_TOKEN_RE = /\[\s*([a-zA-Z0-9_:-]+)\s*(?:([*^$~|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\s*\]/g;

function matchCompoundSelector(node, rawCompound) {
  if (!node || !node.tagName || String(node.tagName).startsWith('#')) return false;
  let rem = String(rawCompound || '').trim();
  if (!rem) return false;
  if (rem === '*') return true;

  // Match attribute clauses `[attr]`, `[attr="v"]`, `[attr^="v"]`, `[attr*="v"]`, `[attr$="v"]`
  const attrs = [];
  rem = rem.replace(ATTR_TOKEN_RE, (_m, name, op, dq, sq, bare) => {
    attrs.push({ name, op: op || '', val: dq ?? sq ?? (bare ? bare.trim() : '') });
    return '';
  });

  for (const a of attrs) {
    if (!a.op) {
      if (!node.hasAttribute(a.name)) return false;
      continue;
    }
    const actual = node.getAttribute(a.name);
    if (actual === null || actual === undefined) return false;
    const str = String(actual);
    if (a.op === '=' && str !== a.val) return false;
    if (a.op === '^=' && !str.startsWith(a.val)) return false;
    if (a.op === '*=' && !str.includes(a.val)) return false;
    if (a.op === '$=' && !str.endsWith(a.val)) return false;
    if (a.op === '~=' && !str.split(/\s+/).includes(a.val)) return false;
  }

  // Extract `#id` and `.class` tokens
  let idReq = '';
  const classReqs = [];
  rem = rem.replace(/#([a-zA-Z0-9_-]+)/g, (_m, id) => {
    idReq = id;
    return '';
  });
  rem = rem.replace(/\.([a-zA-Z0-9_@/-]+)/g, (_m, cls) => {
    classReqs.push(cls);
    return '';
  });

  if (idReq && node.id !== idReq) return false;
  for (const cls of classReqs) {
    if (!node.classList.contains(cls)) return false;
  }

  const tag = rem.trim();
  if (tag && node.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  return true;
}

function splitTopLevelCommas(selector) {
  const out = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  const s = String(selector || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote && s[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']') {
      depth = Math.max(0, depth - 1);
    } else if (ch === ',' && depth === 0) {
      const part = s.slice(start, i).trim();
      if (part) out.push(part);
      start = i + 1;
    }
  }
  const tail = s.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function tokenizeCombinators(singleSelector) {
  const tokens = [];
  let depth = 0;
  let quote = '';
  let buf = '';
  let pendingDirect = false;
  const s = String(singleSelector || '').trim();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      buf += ch;
      if (ch === quote && s[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '[') {
      depth++;
      buf += ch;
      continue;
    }
    if (ch === ']') {
      depth = Math.max(0, depth - 1);
      buf += ch;
      continue;
    }
    if (depth === 0 && (ch === '>' || /\s/.test(ch))) {
      if (buf) {
        tokens.push({ compound: buf, combinator: pendingDirect ? '>' : ' ' });
        buf = '';
        pendingDirect = false;
      }
      if (ch === '>') pendingDirect = true;
      continue;
    }
    buf += ch;
  }
  if (buf) {
    tokens.push({ compound: buf, combinator: pendingDirect ? '>' : ' ' });
  }
  return tokens;
}

function matchChainFromScope(node, scopeRoot, tokens, idx) {
  const step = tokens[idx];
  if (step.compound === ':scope') {
    return node === scopeRoot;
  }
  if (!matchCompoundSelector(node, step.compound)) return false;
  if (idx === 0) return true;

  if (step.combinator === '>') {
    const p = node.parentNode;
    if (!p) return false;
    return matchChainFromScope(p, scopeRoot, tokens, idx - 1);
  }

  let p = node.parentNode;
  while (p) {
    if (matchChainFromScope(p, scopeRoot, tokens, idx - 1)) return true;
    if (p === scopeRoot) break;
    p = p.parentNode;
  }
  return false;
}

export class MockMutationObserver {
  constructor(cb, registry = null) {
    this.cb = cb;
    this.targets = [];
    if (Array.isArray(registry)) registry.push(this);
  }
  observe(target, options) {
    this.targets.push({ target, options });
  }
  disconnect() {
    this.targets = [];
  }
}

export class MockDomNode {
  constructor(tag = 'div', rect = null, domOptions = null) {
    this._domOptions = domOptions || null;
    this.tagName = String(tag || 'div').toUpperCase();
    this.nodeName = this.tagName;
    this.nodeType = this.tagName === '#TEXT' ? 3 : 1;
    this.id = '';
    this.value = '';
    this._text = '';
    this._rect = null;
    this._ownRect = rect || null;
    this.offsetWidth = 0;
    this.offsetHeight = 0;
    this.clientWidth = 0;
    this.scrollWidth = 0;
    this.dataset = {};
    this.attributes = new Map();
    this._classes = new Set();
    this.children = [];
    this.parentNode = null;
    this.shadowRoot = null;
    this._listeners = new Map();

    const styleVars = new Map();
    this.style = {
      width: '',
      height: '',
      maxHeight: '',
      marginLeft: '',
      top: '',
      left: '',
      right: '',
      display: '',
      visibility: '',
      opacity: '',
      _vars: styleVars,
      setProperty(k, v) {
        const s = String(v ?? '');
        styleVars.set(k, s);
        this[k] = s;
      },
      getPropertyValue(k) {
        return styleVars.get(k) || this[k] || '';
      },
      removeProperty(k) {
        styleVars.delete(k);
        delete this[k];
      },
    };

    const self = this;
    this.classList = {
      add(...tokens) {
        for (const t of tokens) if (t) self._classes.add(t);
        self._syncClassAttr();
      },
      remove(...tokens) {
        for (const t of tokens) self._classes.delete(t);
        self._syncClassAttr();
      },
      contains(tok) {
        return self._classes.has(tok);
      },
      toggle(tok, force) {
        const should = force === undefined ? !self._classes.has(tok) : Boolean(force);
        if (should) self._classes.add(tok);
        else self._classes.delete(tok);
        self._syncClassAttr();
        return should;
      },
    };
  }

  _syncClassAttr() {
    const joined = [...this._classes].join(' ');
    if (joined) this.attributes.set('class', joined);
    else this.attributes.delete('class');
  }

  get className() {
    return [...this._classes].join(' ');
  }

  set className(v) {
    this._classes.clear();
    for (const part of String(v || '').split(/\s+/)) {
      if (part) this._classes.add(part);
    }
    this._syncClassAttr();
  }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map((c) => c.textContent ?? '').join('');
  }

  set textContent(v) {
    for (const c of this.children) {
      if (c) c.parentNode = null;
    }
    this.children = [];
    this._text = String(v ?? '');
  }

  get parentElement() {
    return this.parentNode;
  }

  set parentElement(v) {
    this.parentNode = v;
  }

  get firstChild() {
    return this.children[0] || null;
  }

  get lastChild() {
    return this.children[this.children.length - 1] || null;
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  get lastElementChild() {
    return this.children[this.children.length - 1] || null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.children.indexOf(this);
    return idx >= 0 ? this.parentNode.children[idx + 1] || null : null;
  }

  get nextElementSibling() {
    return this.nextSibling;
  }

  get isConnected() {
    let cur = this;
    while (cur) {
      if (cur.isDocumentRoot) return true;
      cur = cur.parentNode || cur.host || null;
    }
    return false;
  }

  setAttribute(k, v) {
    const s = String(v);
    if (k === 'class') {
      this.className = s;
      return;
    }
    this.attributes.set(k, s);
    if (k === 'id') this.id = s;
  }

  getAttribute(k) {
    if (k === 'class') return this.attributes.has('class') ? this.className : null;
    return this.attributes.has(k) ? this.attributes.get(k) : null;
  }

  hasAttribute(k) {
    return this.attributes.has(k);
  }

  removeAttribute(k) {
    if (k === 'class') {
      this._classes.clear();
    }
    this.attributes.delete(k);
  }

  appendChild(child) {
    if (!child) return child;
    if (child.parentNode?.removeChild) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(node, refNode) {
    if (!refNode) return this.appendChild(node);
    if (node.parentNode?.removeChild) node.parentNode.removeChild(node);
    const idx = this.children.indexOf(refNode);
    node.parentNode = this;
    if (idx < 0) this.children.push(node);
    else this.children.splice(idx, 0, node);
    return node;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  remove() {
    if (this.parentNode?.removeChild) this.parentNode.removeChild(this);
  }

  attachShadow() {
    const sr = new MockDomNode('#shadow-root', null, this._domOptions);
    sr.host = this;
    this.shadowRoot = sr;
    return sr;
  }

  contains(other) {
    let cur = other;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  closest(sel) {
    let cur = this;
    while (cur && cur.nodeType === 1) {
      if (cur.matches(sel)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const arr = this._listeners.get(type);
    if (!arr) return;
    const idx = arr.indexOf(fn);
    if (idx >= 0) arr.splice(idx, 1);
  }

  dispatchEvent(ev) {
    for (const fn of [...(this._listeners.get(ev.type) || [])]) fn(ev);
  }

  setRect(rect) {
    this._ownRect = rect;
  }

  getBoundingClientRect() {
    if (typeof this._domOptions?.resolveRect === 'function') {
      const custom = this._domOptions.resolveRect(this);
      if (custom) return custom;
    }
    if (this._ownRect) return this._ownRect;
    if (this._rect) return this._rect;
    if (this._domOptions?.inheritAncestorRect) {
      let cur = this.parentNode || this.host || null;
      while (cur) {
        if (cur._ownRect) return cur._ownRect;
        if (cur._rect) return cur._rect;
        cur = cur.parentNode || cur.host || null;
      }
    }
    return (
      this._domOptions?.defaultRect || {
        left: 900,
        right: 1080,
        top: 6,
        bottom: 32,
        width: 180,
        height: 26,
      }
    );
  }

  matches(selector) {
    const groups = splitTopLevelCommas(selector);
    if (groups.length === 0) return false;
    return groups.some((g) => {
      const tokens = tokenizeCombinators(g);
      if (tokens.length === 0) return false;
      return matchChainFromScope(this, null, tokens, tokens.length - 1);
    });
  }

  querySelectorAll(selector) {
    const groups = splitTopLevelCommas(selector);
    if (groups.length === 0) return [];
    const parsedGroups = groups.map(tokenizeCombinators).filter((t) => t.length > 0);
    if (parsedGroups.length === 0) return [];

    const out = [];
    const walk = (root) => {
      for (const child of root.children || []) {
        if (
          parsedGroups.some((tokens) =>
            matchChainFromScope(child, this, tokens, tokens.length - 1)
          )
        ) {
          out.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  _find(pred) {
    for (const c of this.children) {
      if (pred(c)) return c;
      const hit = c._find?.(pred);
      if (hit) return hit;
    }
    return null;
  }
}

export function createMockDom({
  rootRect = null,
  defaultRect = null,
  inheritAncestorRect = false,
  resolveRect = null,
  onCreateElement = null,
} = {}) {
  const domOptions = { defaultRect, inheritAncestorRect, resolveRect };
  const makeElement = (tag, rect = null) => {
    const node = new MockDomNode(tag, rect, domOptions);
    if (typeof onCreateElement === 'function') onCreateElement(node, tag);
    return node;
  };

  const docRoot = makeElement('html', rootRect);
  docRoot.isDocumentRoot = true;
  const head = makeElement('head');
  const body = makeElement('body', rootRect);
  docRoot.appendChild(head);
  docRoot.appendChild(body);

  const docListeners = new Map();
  const document = {
    readyState: 'complete',
    hidden: false,
    activeElement: null,
    documentElement: docRoot,
    head,
    body,
    createElement: (tag) => makeElement(tag),
    createElementNS: (_ns, tag) => makeElement(tag),
    createTextNode: (txt) => {
      const t = new MockDomNode('#text', null, domOptions);
      t.textContent = String(txt ?? '');
      return t;
    },
    getElementById: (id) => docRoot._find((n) => n.id === id),
    querySelector: (sel) => docRoot.querySelector(sel),
    querySelectorAll: (sel) => docRoot.querySelectorAll(sel),
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = docListeners.get(type);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    dispatchEvent(ev) {
      for (const fn of [...(docListeners.get(ev.type) || [])]) fn(ev);
    },
  };

  return { docRoot, head, body, document, docListeners, makeElement };
}
