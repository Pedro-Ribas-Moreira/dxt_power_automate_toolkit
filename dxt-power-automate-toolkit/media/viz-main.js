// ── Visualizer panel boot ───────────────────────────────────────────────────
// Wires the verbatim-ported VIZ (media/visualizer.js) into the VS Code webview:
// reads the flow identity from <body data-*>, opens the flow, and refreshes on
// host file-watch pushes — but never while an editor is open, because a blind
// re-render destroys open edit panels (the reason dxt-bridge dropped polling).
(function () {
  var body = document.body;
  var solution = body.dataset.solution || '';
  var flowFile = body.dataset.flowFile || '';
  var flowName = body.dataset.flowName || '';

  function editorOpen() {
    if (document.getElementById('viz-json-editor')) return true;   // raw-JSON edit mode
    var panels = document.querySelectorAll('[id^="vep_"]');        // per-card edit panels
    for (var i = 0; i < panels.length; i++) {
      if (panels[i].style.display !== 'none' && panels[i].style.display !== '') return true;
    }
    return false;
  }

  window.bridge.onPush('update', function () {
    if (editorOpen()) return;
    if (window.VIZ) window.VIZ.refresh();
  });

  if (window.VIZ) {
    window.VIZ.open(solution, flowFile, flowName);
  } else {
    document.getElementById('viz-panel').textContent = 'Visualizer failed to load.';
  }
})();
