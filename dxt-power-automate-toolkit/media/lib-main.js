// ── Library Search panel boot ───────────────────────────────────────────────
// Boots the verbatim-ported LIB (media/library.js) inside the VS Code webview
// and adds two panel-only affordances via event delegation (no edits to the
// ported render functions):
//   • click a flow row (By Action / By Trigger modes) → open it in the visualizer
//   • click an example snippet → copy it to the clipboard
(function () {
  document.addEventListener('click', function (ev) {
    var target = ev.target;
    if (!target || !target.closest) return;

    // Open flow: rows inside "By Action" (lra_*) and "By Trigger" (lrt_*)
    // cards are flow usages — .lib-rf-name = flow, .lib-rf-sol = solution.
    // ("By Flow" card rows are connectors, not flows — excluded by the id check.)
    var row = target.closest('.lib-result-flow');
    if (row) {
      var card = row.closest('.lib-result-card');
      var id = card ? card.id || '' : '';
      if (id.indexOf('lra_') === 0 || id.indexOf('lrt_') === 0) {
        var nameEl = row.querySelector('.lib-rf-name');
        var solEl = row.querySelector('.lib-rf-sol');
        if (nameEl && solEl) {
          window.bridge.request('/pac/open-flow', {
            solution: solEl.textContent.trim(),
            flow: nameEl.textContent.trim()
          }).then(function (reply) {
            if (!reply.ok) {
              if (typeof toast === 'function') toast('Could not open flow: ' + (reply.error || 'not found'), 'err');
            }
          });
        }
      }
      return;
    }

    // Copy example snippet
    var code = target.closest('.lib-example-code');
    if (code) {
      window.bridge.request('/pac/copy-text', { text: code.textContent || '' }).then(function (reply) {
        if (reply.ok && typeof toast === 'function') toast('Snippet copied to clipboard', 'ok');
      });
    }
  });

  if (typeof applyDataIcons === 'function') applyDataIcons();

  if (window.LIB) {
    window.LIB.open();
  } else {
    var body = document.getElementById('lib-body');
    if (body) body.textContent = 'Library failed to load.';
  }
})();
