// Library Search panel host. The UI is the dxt-bridge library page ported
// verbatim (media/library.js + media/library.css); this module serves the
// index and handles panel-only affordances (open flow, copy, CSV export).
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { buildWebviewHtml, createBridgedPanel } from './webviewHost';
import { buildLibrary, loadLibrary, saveLibrary } from './libraryBuilder';
import { flowDisplayName } from './flowSurgery';
import { openFlowVisualizer } from './flowVisualizer';

let currentPanel: vscode.WebviewPanel | undefined;

export function openLibraryPanel(context: vscode.ExtensionContext, solutionsRoot: string): void {
  if (currentPanel) {
    currentPanel.reveal();
    return;
  }

  const { panel, bridge } = createBridgedPanel(
    'dxt-library-search',
    'Library Search',
    context.extensionUri,
    vscode.ViewColumn.Active
  );
  currentPanel = panel;
  panel.onDidDispose(() => { currentPanel = undefined; });

  panel.webview.html = buildWebviewHtml(panel.webview, context.extensionUri, {
    title: 'Library Search',
    bodyHtml: SHELL_HTML,
    styles: ['theme.css', 'library.css'],
    scripts: ['vscode-shim.js', 'icons.js', 'toast.js', 'library.js', 'lib-main.js'],
  });

  bridge.on('/pac/library', () => {
    let lib = loadLibrary(solutionsRoot);
    if (!lib) {
      lib = buildLibrary(solutionsRoot);
      try { saveLibrary(lib, solutionsRoot); } catch { /* read-only workspace — serve unsaved */ }
    }
    return lib;
  });

  bridge.on('/pac/open-flow', (p) => {
    const wanted = String(p.flow ?? '').trim().toLowerCase();
    const wfDir = path.join(solutionsRoot, String(p.solution ?? ''), 'Workflows');
    if (!fs.existsSync(wfDir)) {
      return { ok: false, error: `Solution "${p.solution}" is not exported locally` };
    }
    const match = fs.readdirSync(wfDir)
      .filter(f => f.endsWith('.json'))
      .find(f => flowDisplayName(f).toLowerCase() === wanted);
    if (!match) {
      return { ok: false, error: `Flow "${p.flow}" not found in ${p.solution}` };
    }
    openFlowVisualizer(context, path.join(wfDir, match));
    return { ok: true };
  });

  bridge.on('/pac/copy-text', async (p) => {
    await vscode.env.clipboard.writeText(String(p.text ?? ''));
    return { ok: true };
  });

  bridge.on('/pac/save-csv', async (p) => {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(solutionsRoot, String(p.filename ?? 'library.csv'))),
      filters: { CSV: ['csv'] },
    });
    if (!uri) { return { cancelled: true }; }
    fs.writeFileSync(uri.fsPath, '﻿' + String(p.csv ?? ''), 'utf8');
    return { saved: true };
  });
}

// The ported library page expects the dxt-bridge app shell: #library-view with
// its header (from dxt-bridge index.html) plus the chrome elements showView()
// touches unguarded — stubs, force-hidden because showView() sets inline
// display on them. No lib-nav-* buttons → the dxt-bridge-server-specific
// Context/SharePoint sub-views are unreachable (all their lookups are guarded).
const SHELL_HTML = `
  <style>
    #content, #action-bar, #empty-state, #solution-view, #new-sol-view,
    #main-title, #main-ver, #btn-pa, #btn-viz-back { display: none !important; }
    #library-view { display: flex; flex-direction: column; }
    .lib-result-flow { cursor: pointer; }
    .lib-example-code { cursor: copy; }
  </style>
  <div id="content"></div>
  <div id="action-bar"></div>
  <div id="empty-state"></div>
  <div id="solution-view"></div>
  <div id="new-sol-view"></div>
  <div id="main-title"></div>
  <div id="main-ver"></div>
  <button id="btn-pa"></button>
  <button id="btn-viz-back"></button>
  <div id="library-view">
    <div class="lib-header">
      <div class="lib-header-left">
        <h3 id="lib-title" data-icon="book-open">Actions Library</h3>
        <div class="lib-status" id="lib-status">Not loaded</div>
      </div>
    </div>
    <div class="lib-body" id="lib-body"></div>
  </div>
`;
