// BridgeDeck's scriptlets: small pieces of code that run in a page before its own scripts, to
// defuse ad and anti-ad-blocker code (the same names and arguments as uBlock Origin's, so its lists
// work). Called as __bdScriptlets([[name, arg, ...], ...]).
var __bdScriptlets = (function () {
  'use strict';
  var noop = function () {};
  // A string or /regex/ to look for; '!' in front means "not". Empty matches everything.
  function needle(text) {
    text = text == null ? '' : String(text);
    var not = text.charAt(0) === '!' && text.length > 1;
    if (not) text = text.slice(1);
    var test;
    if (text === '' || text === '*') test = function () { return true; };
    else if (/^\/.+\/[gimsu]*$/.test(text)) {
      var end = text.lastIndexOf('/');
      try { var re = new RegExp(text.slice(1, end), text.slice(end + 1)); test = function (s) { return re.test(String(s)); }; }
      catch (e) { test = function () { return false; }; }
    } else test = function (s) { return String(s).indexOf(text) !== -1; };
    return not ? function (s) { return !test(s); } : test;
  }
  var NOVALUE = {};
  function constant(raw, trusted) {
    switch (raw) {
      case 'undefined': return undefined;
      case 'false': return false;
      case 'true': return true;
      case 'null': return null;
      case "''": case '': case 'emptyStr': return '';
      case 'noopFunc': return function () {};
      case 'trueFunc': return function () { return true; };
      case 'falseFunc': return function () { return false; };
      case 'throwFunc': return function () { throw new Error(); };
      case 'emptyArr': case '[]': return [];
      case 'emptyObj': case '{}': return {};
      case 'noopPromiseResolve': return function () { return Promise.resolve(); };
      case 'noopPromiseReject': return function () { return Promise.reject(); };
      case 'yes': case 'no': case 'on': case 'off': return raw;
    }
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    if (trusted) { try { return JSON.parse(raw); } catch (e) { return raw; } }
    return NOVALUE;
  }
  // Defines `chain` (a.b.c) on `owner`, waiting for the objects along the way to be set.
  function trap(owner, chain, descriptor) {
    var dot = chain.indexOf('.');
    var prop = dot < 0 ? chain : chain.slice(0, dot);
    if (dot < 0) {
      try { Object.defineProperty(owner, prop, Object.assign({ configurable: true }, descriptor)); } catch (e) {}
      return;
    }
    var rest = chain.slice(dot + 1);
    var current = owner[prop];
    if (current instanceof Object || (typeof current === 'object' && current !== null)) { trap(current, rest, descriptor); return; }
    var inner = current;
    try {
      Object.defineProperty(owner, prop, {
        configurable: true,
        get: function () { return inner; },
        set: function (value) { inner = value; if (value instanceof Object) trap(value, rest, descriptor); },
      });
    } catch (e) {}
  }
  function setConstant(chain, raw, trusted) {
    if (!chain) return;
    var value = constant(raw, trusted);
    if (value === NOVALUE) return;
    trap(window, chain, { get: function () { return value; }, set: noop });
  }
  function abortOnRead(chain) {
    if (!chain) return;
    trap(window, chain, { get: function () { throw new ReferenceError('blocked'); }, set: noop });
  }
  function abortOnWrite(chain) {
    if (!chain) return;
    trap(window, chain, { get: function () { return undefined; }, set: function () { throw new ReferenceError('blocked'); } });
  }
  function abortCurrentScript(chain, find) {
    if (!chain) return;
    var match = needle(find);
    var dot = chain.lastIndexOf('.');
    var owner = window, prop = chain;
    if (dot >= 0) {
      var path = chain.slice(0, dot).split('.');
      for (var i = 0; i < path.length && owner; i++) owner = owner[path[i]];
      prop = chain.slice(dot + 1);
      if (!(owner instanceof Object)) return;
    }
    var desc = Object.getOwnPropertyDescriptor(owner, prop);
    var value = owner[prop];
    var check = function () {
      var script = document.currentScript;
      if (script && script instanceof HTMLScriptElement && match(script.src || script.textContent)) throw new ReferenceError('blocked');
    };
    try {
      Object.defineProperty(owner, prop, {
        configurable: true,
        get: function () { check(); return desc && desc.get ? desc.get.call(this) : value; },
        set: function (v) { check(); if (desc && desc.set) desc.set.call(this, v); else value = v; },
      });
    } catch (e) {}
  }
  function preventListener(type, find) {
    var typeMatch = needle(type), handlerMatch = needle(find);
    var add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (t, handler) {
      try {
        if (typeMatch(t) && handlerMatch(handler == null ? '' : String(handler.handleEvent || handler))) return;
      } catch (e) {}
      return add.apply(this, arguments);
    };
  }
  function delayMatches(spec, delay) {
    if (spec === undefined || spec === '') return true;
    var not = spec.charAt(0) === '!';
    var n = Number(not ? spec.slice(1) : spec);
    return not ? Number(delay) !== n : Number(delay) === n;
  }
  function preventTimer(name, find, delay) {
    var match = needle(find), original = window[name];
    window[name] = function (callback, ms) {
      if (match(String(callback)) && delayMatches(delay, ms)) return original.call(this, noop, ms);
      return original.apply(this, arguments);
    };
  }
  function adjustTimer(name, find, delay, boost) {
    var match = needle(find), original = window[name];
    var wanted = delay === undefined || delay === '' ? 1000 : Number(delay);
    var factor = boost === undefined || boost === '' ? 0.05 : Number(boost);
    if (!(factor > 0 && factor < 50)) factor = 0.05;
    window[name] = function (callback, ms) {
      if (match(String(callback)) && (wanted === '*' || Number(ms) === wanted)) arguments[1] = Number(ms) * factor;
      return original.apply(this, arguments);
    };
  }
  function preventWindowOpen(find) {
    var match = needle(find), open = window.open;
    window.open = function (url) {
      if (match(url == null ? '' : String(url))) return null;
      return open.apply(this, arguments);
    };
  }
  // "url:/ads method:POST" or a plain needle for the address.
  function requestMatcher(spec) {
    spec = spec || '';
    var parts = {};
    if (/^\w+:/.test(spec)) spec.split(/\s+/).forEach(function (p) { var i = p.indexOf(':'); if (i > 0) parts[p.slice(0, i)] = p.slice(i + 1); });
    else parts.url = spec;
    var url = needle(parts.url || ''), method = parts.method ? String(parts.method).toUpperCase() : '';
    return function (u, m) { return url(u) && (!method || String(m || 'GET').toUpperCase() === method); };
  }
  function preventFetch(spec) {
    var match = requestMatcher(spec), original = window.fetch;
    if (!original) return;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : input && input.url;
      var method = (init && init.method) || (input && input.method);
      if (match(url || '', method)) return Promise.resolve(new Response('', { status: 200, statusText: 'OK' }));
      return original.apply(this, arguments);
    };
  }
  function preventXhr(spec) {
    var match = requestMatcher(spec), proto = XMLHttpRequest.prototype, open = proto.open, send = proto.send;
    var blocked = new WeakSet();
    proto.open = function (method, url) { if (match(String(url), method)) blocked.add(this); return open.apply(this, arguments); };
    proto.send = function () {
      if (!blocked.has(this)) return send.apply(this, arguments);
      var xhr = this;
      ['readyState', 'status', 'responseText', 'response'].forEach(function (k) {
        Object.defineProperty(xhr, k, { configurable: true, value: k === 'readyState' ? 4 : k === 'status' ? 200 : '' });
      });
      setTimeout(function () {
        ['readystatechange', 'load', 'loadend'].forEach(function (t) { xhr.dispatchEvent(new Event(t)); });
      }, 1);
    };
  }
  // Runs `fn` now and whenever the page changes (until it's done, if it says so).
  function whenever(fn) {
    var run = function () { try { fn(); } catch (e) {} };
    var start = function () { run(); new MutationObserver(run).observe(document.documentElement, { childList: true, subtree: true, attributes: false }); };
    if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
  }
  function removeAttr(attrs, selector) {
    var names = String(attrs || '').split(/\s*\|\s*/).filter(Boolean);
    if (!names.length) return;
    var sel = selector || names.map(function (n) { return '[' + n + ']'; }).join(',');
    whenever(function () {
      document.querySelectorAll(sel).forEach(function (el) { names.forEach(function (n) { el.removeAttribute(n); }); });
    });
  }
  function removeClass(classes, selector) {
    var names = String(classes || '').split(/\s*\|\s*/).filter(Boolean);
    if (!names.length) return;
    var sel = selector || names.map(function (n) { return '.' + n; }).join(',');
    whenever(function () {
      document.querySelectorAll(sel).forEach(function (el) { names.forEach(function (n) { el.classList.remove(n); }); });
    });
  }
  function nodeText(nodeName, find, replacement) {
    var name = String(nodeName || '').toLowerCase(), match = needle(find);
    var pattern = null;
    if (replacement !== undefined && /^\/.+\/[gimsu]*$/.test(find)) { var end = find.lastIndexOf('/'); try { pattern = new RegExp(find.slice(1, end), find.slice(end + 1)); } catch (e) {} }
    var fix = function (node) {
      if (node.nodeName.toLowerCase() !== name) return;
      var text = node.textContent;
      if (!text || !match(text)) return;
      node.textContent = replacement === undefined ? '' : pattern ? text.replace(pattern, replacement) : text.split(find).join(replacement);
    };
    var observer = new MutationObserver(function (records) {
      records.forEach(function (r) { r.addedNodes.forEach(function (n) { fix(n); if (n.nodeType === 1 && name !== '#text') n.querySelectorAll(name).forEach(fix); }); });
    });
    observer.observe(document, { childList: true, subtree: true });
    if (document.readyState === 'complete') observer.disconnect(); else window.addEventListener('load', function () { setTimeout(function () { observer.disconnect(); }, 5000); });
  }
  function noEval(find) {
    var match = needle(find), original = window.eval;
    window.eval = new Proxy(original, { apply: function (target, self, args) { if (find === undefined || match(String(args[0]))) return undefined; return Reflect.apply(target, self, args); } });
  }
  function setCookie(name, value, path, trusted, offset) {
    if (!name) return;
    var v = value;
    if (!trusted) {
      if (!/^(true|false|yes|no|y|n|ok|on|off|accept|accepted|reject|rejected|allow|allowed|deny|denied|necessary|essential|nonessential|hide|hidden|dismiss|dismissed|-?\d+)$/i.test(v || '')) return;
    } else {
      v = String(v || '').replace('$now$', String(Date.now())).replace('$currentDate$', new Date().toUTCString()).replace('$currentISODate$', new Date().toISOString());
    }
    var cookie = encodeURIComponent(name) + '=' + encodeURIComponent(v) + '; path=' + (path === 'none' ? '/' : path || '/');
    if (trusted && offset) { var ms = /^\d+$/.test(offset) ? Number(offset) * 1000 : /^1year$/.test(offset) ? 31536e6 : /^1day$/.test(offset) ? 864e5 : 0; if (ms) cookie += '; expires=' + new Date(Date.now() + ms).toUTCString(); }
    try { document.cookie = cookie; } catch (e) {}
  }
  function removeCookie(find) {
    var match = needle(find);
    var clear = function () {
      document.cookie.split(';').forEach(function (c) {
        var name = c.split('=')[0].trim();
        if (!name || !match(name)) return;
        var parts = location.hostname.split('.');
        for (var i = 0; i < parts.length; i++) {
          var domain = parts.slice(i).join('.');
          document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=' + domain;
        }
        document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
      });
    };
    clear();
    window.addEventListener('beforeunload', clear);
  }
  function setStorage(storage, key, value, trusted) {
    if (!key) return;
    try {
      var store = window[storage];
      if (value === '$remove$') { store.removeItem(key); return; }
      var v = constant(value, trusted);
      if (v === NOVALUE) return;
      if (trusted && typeof value === 'string') v = value.replace('$now$', String(Date.now())).replace('$currentDate$', new Date().toUTCString()).replace('$currentISODate$', new Date().toISOString());
      store.setItem(key, typeof v === 'string' ? v : JSON.stringify(v));
    } catch (e) {}
  }
  function clickElement(selectors, extra, delay) {
    var list = String(selectors || '').split(/\s*,\s*/).filter(Boolean);
    if (!list.length) return;
    var wait = Number(delay) || 0, deadline = Date.now() + 10000, index = 0;
    var step = function () {
      if (index >= list.length || Date.now() > deadline) return true;
      var el = document.querySelector(list[index]);
      if (!el) return false;
      setTimeout(function (e) { try { e.click(); } catch (x) {} }, wait, el);
      index++;
      return index >= list.length;
    };
    var start = function () {
      if (step()) return;
      var observer = new MutationObserver(function () { if (step()) observer.disconnect(); });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(function () { observer.disconnect(); }, 10000);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  }
  // Deletes "a.b.c" style paths from an object; `[]` steps into every array item, `*` every key.
  function prunePath(obj, path) {
    if (!obj || typeof obj !== 'object') return false;
    var dot = path.indexOf('.');
    var key = dot < 0 ? path : path.slice(0, dot), rest = dot < 0 ? '' : path.slice(dot + 1);
    var found = false;
    var keys = key === '[]' || key === '*' ? Object.keys(obj) : [key];
    keys.forEach(function (k) {
      if (!(k in obj)) return;
      if (!rest) { delete obj[k]; found = true; } else if (prunePath(obj[k], rest)) found = true;
    });
    return found;
  }
  function hasPath(obj, path) {
    if (!path) return true;
    var parts = path.split('.'), cur = obj;
    for (var i = 0; i < parts.length; i++) { if (!cur || typeof cur !== 'object' || !(parts[i] in cur)) return false; cur = cur[parts[i]]; }
    return true;
  }
  function pruner(props, required) {
    var paths = String(props || '').split(/\s+/).filter(Boolean), needs = String(required || '').split(/\s+/).filter(Boolean);
    return function (obj) {
      if (!paths.length || !needs.every(function (n) { return hasPath(obj, n); })) return obj;
      paths.forEach(function (p) { prunePath(obj, p); });
      return obj;
    };
  }
  function jsonPrune(props, required) {
    var prune = pruner(props, required), parse = JSON.parse;
    JSON.parse = function () { var out = parse.apply(this, arguments); try { return prune(out); } catch (e) { return out; } };
    var json = Response.prototype.json;
    Response.prototype.json = function () { return json.apply(this, arguments).then(function (o) { try { return prune(o); } catch (e) { return o; } }); };
  }
  // Rewrites the text of matching fetch and XHR responses with `change(text)`.
  function rewriteResponses(spec, change, fetches, xhrs) {
    var match = requestMatcher(spec);
    if (fetches && window.fetch) {
      var original = window.fetch;
      window.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : input && input.url;
        var method = (init && init.method) || (input && input.method);
        var pending = original.apply(this, arguments);
        if (!match(url || '', method)) return pending;
        return pending.then(function (response) {
          return response.clone().text().then(function (text) {
            var changed = change(text);
            if (changed === text) return response;
            var copy = new Response(changed, { status: response.status, statusText: response.statusText, headers: response.headers });
            Object.defineProperty(copy, 'url', { value: response.url });
            return copy;
          }).catch(function () { return response; });
        });
      };
    }
    if (xhrs) {
      var proto = XMLHttpRequest.prototype, open = proto.open;
      var urls = new WeakMap(), cache = new WeakMap();
      proto.open = function (method, url) { if (match(String(url), method)) urls.set(this, true); return open.apply(this, arguments); };
      ['responseText', 'response'].forEach(function (key) {
        var desc = Object.getOwnPropertyDescriptor(proto, key);
        if (!desc || !desc.get) return;
        Object.defineProperty(proto, key, {
          configurable: true,
          get: function () {
            var value = desc.get.call(this);
            if (!urls.has(this) || this.readyState !== 4 || typeof value !== 'string') return value;
            if (!cache.has(this)) cache.set(this, change(value));
            return cache.get(this);
          },
        });
      });
    }
  }
  function pruneResponses(props, required, rest, fetches, xhrs) {
    var spec = '';
    for (var i = 0; i + 1 < rest.length; i += 2) if (rest[i] === 'propsToMatch') spec = rest[i + 1];
    var prune = pruner(props, required);
    rewriteResponses(spec, function (text) {
      try { var o = JSON.parse(text); prune(o); return JSON.stringify(o); } catch (e) { return text; }
    }, fetches, xhrs);
  }
  function replaceResponses(find, replacement, spec, fetches, xhrs) {
    if (!find) return;
    var pattern = /^\/.+\/[gimsu]*$/.test(find) ? (function () { var end = find.lastIndexOf('/'); try { return new RegExp(find.slice(1, end), find.slice(end + 1)); } catch (e) { return null; } })() : null;
    rewriteResponses(spec, function (text) {
      if (find === '*') return replacement || '';
      return pattern ? text.replace(pattern, replacement || '') : text.split(find).join(replacement || '');
    }, fetches, xhrs);
  }
  function noWebRtc() {
    var Real = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (!Real) return;
    var Fake = function () { this.close = noop; this.createDataChannel = noop; this.createOffer = function () { return Promise.reject(new Error('blocked')); }; this.setLocalDescription = noop; this.addEventListener = noop; };
    window.RTCPeerConnection = Fake;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Fake;
  }
  function dummies(kind) {
    if (kind === 'popads') { setConstant('PopAds', '{}', true); setConstant('popns', '{}', true); return; }
    // FuckAdBlock / BlockAdBlock: an object that never finds an ad blocker.
    var Fake = function () {};
    Fake.prototype.check = noop; Fake.prototype.clearEvent = noop; Fake.prototype.emitEvent = noop;
    Fake.prototype.on = function (detected, fn) { if (!detected && typeof fn === 'function') setTimeout(fn, 1); return this; };
    Fake.prototype.onDetected = function () { return this; };
    Fake.prototype.onNotDetected = function (fn) { if (typeof fn === 'function') setTimeout(fn, 1); return this; };
    Fake.prototype.setOption = function () { return this; };
    var instance = new Fake();
    var names = kind === 'nobab' ? ['blockAdBlock', 'BlockAdBlock'] : ['fuckAdBlock', 'FuckAdBlock', 'sniffAdBlock'];
    names.forEach(function (n, i) { try { Object.defineProperty(window, n, { configurable: true, value: i % 2 ? Fake : instance }); } catch (e) {} });
  }

  var table = {
    'set-constant': function (a) { setConstant(a[0], a[1], false); },
    'trusted-set-constant': function (a) { setConstant(a[0], a[1], true); },
    'trusted-set': function (a) { setConstant(a[0], a[1], true); },
    'abort-on-property-read': function (a) { abortOnRead(a[0]); },
    'abort-on-property-write': function (a) { abortOnWrite(a[0]); },
    'abort-current-script': function (a) { abortCurrentScript(a[0], a[1]); },
    'prevent-addEventListener': function (a) { preventListener(a[0], a[1]); },
    'prevent-setTimeout': function (a) { preventTimer('setTimeout', a[0], a[1]); },
    'prevent-setInterval': function (a) { preventTimer('setInterval', a[0], a[1]); },
    'adjust-setTimeout': function (a) { adjustTimer('setTimeout', a[0], a[1], a[2]); },
    'adjust-setInterval': function (a) { adjustTimer('setInterval', a[0], a[1], a[2]); },
    'prevent-window-open': function (a) { preventWindowOpen(a[0]); },
    'prevent-fetch': function (a) { preventFetch(a[0]); },
    'prevent-xhr': function (a) { preventXhr(a[0]); },
    'remove-attr': function (a) { removeAttr(a[0], a[1]); },
    'remove-class': function (a) { removeClass(a[0], a[1]); },
    'remove-node-text': function (a) { nodeText(a[0], a[1]); },
    'rpnt': function (a) { nodeText(a[0], a[1], a[2] || ''); },
    'replace-node-text': function (a) { nodeText(a[0], a[1], a[2] || ''); },
    'trusted-rpnt': function (a) { nodeText(a[0], a[1], a[2] || ''); },
    'noeval': function () { noEval(); },
    'noeval-if': function (a) { noEval(a[0] || ''); },
    'set-cookie': function (a) { setCookie(a[0], a[1], a[2], false); },
    'trusted-set-cookie': function (a) { setCookie(a[0], a[1], a[3], true, a[2]); },
    'remove-cookie': function (a) { removeCookie(a[0]); },
    'cookie-remover': function (a) { removeCookie(a[0]); },
    'set-local-storage-item': function (a) { setStorage('localStorage', a[0], a[1], false); },
    'trusted-set-local-storage-item': function (a) { setStorage('localStorage', a[0], a[1], true); },
    'set-session-storage-item': function (a) { setStorage('sessionStorage', a[0], a[1], false); },
    'trusted-set-session-storage-item': function (a) { setStorage('sessionStorage', a[0], a[1], true); },
    'trusted-click-element': function (a) { clickElement(a[0], a[1], a[2]); },
    'json-prune': function (a) { jsonPrune(a[0], a[1]); },
    'json-prune-fetch-response': function (a) { pruneResponses(a[0], a[1], a.slice(2), true, false); },
    'json-prune-xhr-response': function (a) { pruneResponses(a[0], a[1], a.slice(2), false, true); },
    'trusted-replace-fetch-response': function (a) { replaceResponses(a[0], a[1], a[2], true, false); },
    'trusted-rpfr': function (a) { replaceResponses(a[0], a[1], a[2], true, false); },
    'trusted-replace-xhr-response': function (a) { replaceResponses(a[0], a[1], a[2], false, true); },
    'nowebrtc': function () { noWebRtc(); },
    'nobab': function () { dummies('nobab'); },
    'nofab': function () { dummies('nofab'); },
    'popads-dummy': function () { dummies('popads'); },
  };
  return function (calls) {
    calls.forEach(function (call) {
      var run = table[call[0]];
      if (run) { try { run(call.slice(1)); } catch (e) {} }
    });
  };
})();
