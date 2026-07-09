// ── VS Code webview shim for ported dxt-bridge UI code ─────────────────────
// Provides:
//   window.bridge   – request/response + push channel over postMessage
//   window.fetch    – shim mapping fetch('/pac/...?a=b', {body}) onto bridge
//   app-shell stubs – APP / log / escHtml / showSolutionPanel / confirm
// Must be loaded BEFORE any ported dxt-bridge script.
(function () {
  var vscodeApi = acquireVsCodeApi();
  var pending = {};
  var nextId = 1;
  var pushHandlers = {};

  window.addEventListener('message', function (ev) {
    var msg = ev.data;
    if (!msg) return;
    if (msg.id !== undefined && pending[msg.id]) {
      var p = pending[msg.id];
      delete pending[msg.id];
      p(msg);
    } else if (msg.type && pushHandlers[msg.type]) {
      for (var i = 0; i < pushHandlers[msg.type].length; i++) {
        try { pushHandlers[msg.type][i](msg); } catch (e) { console.error(e); }
      }
    }
  });

  window.bridge = {
    request: function (cmd, payload) {
      return new Promise(function (resolve) {
        var id = nextId++;
        pending[id] = resolve;
        vscodeApi.postMessage({ id: id, cmd: cmd, payload: payload || {} });
      });
    },
    onPush: function (type, fn) {
      (pushHandlers[type] = pushHandlers[type] || []).push(fn);
    }
  };

  // fetch() shim. Ported code only ever inspects r.ok / r.status and calls
  // r.json() (occasionally r.text()), so a minimal fake Response suffices.
  // Query-string params and a JSON body are merged into one payload object.
  window.fetch = function (url, opts) {
    var s = String(url);
    var qIdx = s.indexOf('?');
    var path = qIdx === -1 ? s : s.slice(0, qIdx);
    var payload = {};
    if (qIdx !== -1) {
      var params = new URLSearchParams(s.slice(qIdx + 1));
      params.forEach(function (v, k) { payload[k] = v; });
    }
    if (opts && opts.body) {
      try {
        var body = JSON.parse(opts.body);
        if (body && typeof body === 'object') {
          for (var k in body) payload[k] = body[k];
        }
      } catch (e) { /* non-JSON body — nothing to merge */ }
    }
    return window.bridge.request(path, payload).then(function (reply) {
      var ok = !!reply.ok;
      var data = ok ? reply.data : { ok: false, error: reply.error || 'Request failed' };
      return {
        ok: ok,
        status: ok ? 200 : 500,
        json: function () { return Promise.resolve(data); },
        text: function () {
          return Promise.resolve(typeof data === 'string' ? data : JSON.stringify(data));
        }
      };
    });
  };

  // ── App-shell stubs (globals dxt-bridge code expects from app.js et al.) ──
  window.APP = window.APP || { selected: null };
  window.log = window.log || function (msg, tag) {
    console.log('[' + (tag || 'log') + ']', msg);
  };
  window.escHtml = window.escHtml || function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  window.showSolutionPanel = window.showSolutionPanel || function () {};
  // Native confirm() is silently blocked in VS Code webviews (always returns
  // false) — destructive actions are confirmed host-side instead.
  window.confirm = function () { return true; };
})();
