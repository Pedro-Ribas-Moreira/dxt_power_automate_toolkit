// ── Toast notifications ─────────────────────────────────────────────────────
// window.toast(message, type, opts)
//   type: 'ok' | 'err' | 'warn' | 'info'   (default 'info')
//   opts: { duration: ms }                 (errors linger longer by default)
// Replaces blocking alert() calls and scattered inline status text.
(function () {
  function ensureContainer() {
    var c = document.getElementById('toast-container');
    if (!c) {
      c = document.createElement('div');
      c.id = 'toast-container';
      c.setAttribute('role', 'status');
      c.setAttribute('aria-live', 'polite');
      document.body.appendChild(c);
    }
    return c;
  }

  var ICONS = { ok: '✓', err: '✕', warn: '▲', info: 'ℹ' };

  window.toast = function (message, type, opts) {
    type = ICONS[type] ? type : 'info';
    opts = opts || {};
    var c = ensureContainer();
    var el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.innerHTML =
      '<span class="toast-icon" aria-hidden="true">' + ICONS[type] + '</span>' +
      '<span class="toast-msg"></span>' +
      '<button class="toast-close" aria-label="Dismiss notification">✕</button>';
    el.querySelector('.toast-msg').textContent = String(message);

    var removed = false;
    var remove = function () {
      if (removed) return;
      removed = true;
      el.classList.add('toast-out');
      setTimeout(function () { el.remove(); }, 250);
    };
    el.querySelector('.toast-close').onclick = remove;
    c.appendChild(el);
    while (c.children.length > 5) c.firstChild.remove(); // cap the stack

    setTimeout(remove, opts.duration || (type === 'err' ? 8000 : 4000));
    return el;
  };
})();
