// Flow visualizer host. The UI is the dxt-bridge visualizer ported verbatim
// (media/visualizer.js + media/visualizer.css); this module only creates the
// panel, serves the flow file, and executes edits via flowSurgery. The bridge
// handlers are keyed by the original dxt-bridge URL paths — see webviewHost.ts.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { buildWebviewHtml, createBridgedPanel } from './webviewHost';
import {
  copyActionInFlow,
  deleteActionFromFlow,
  flowDisplayName,
  insertActionInFlow,
  patchActionInFlow,
  saveFlowJson,
} from './flowSurgery';

export function openFlowVisualizer(context: vscode.ExtensionContext, flowPath: string): void {
  const displayName = flowDisplayName(flowPath);
  const solutionName = path.basename(path.dirname(path.dirname(flowPath)));

  const { panel, bridge } = createBridgedPanel(
    'dxt-flow-visualizer',
    displayName,
    context.extensionUri,
    vscode.ViewColumn.Beside
  );

  panel.webview.html = buildWebviewHtml(panel.webview, context.extensionUri, {
    title: displayName,
    bodyHtml: SHELL_HTML,
    styles: ['theme.css', 'visualizer.css'],
    scripts: ['vscode-shim.js', 'icons.js', 'toast.js', 'visualizer.js', 'viz-main.js'],
    bodyAttrs: {
      'data-solution': solutionName,
      'data-flow-file': path.basename(flowPath),
      'data-flow-name': displayName,
    },
  });

  function loadFlow(): { name: string; triggers: any; actions: any } {
    const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
    const def = flow.properties?.definition || flow.definition || flow;
    return { name: displayName, triggers: def.triggers || {}, actions: def.actions || {} };
  }

  bridge.on('/pac/flow-json', () => loadFlow());

  bridge.on('/pac/save-action', (p) => {
    try {
      patchActionInFlow(flowPath, p.actionName, p.patch);
      return { ok: true, actionName: p.actionName };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  });

  bridge.on('/pac/delete-action', async (p) => {
    // The webview's confirm() is stubbed to true — the real confirmation is here.
    const confirm = await vscode.window.showWarningMessage(
      `Delete "${p.actionName}"? Successor actions will be rewired to its predecessor.`,
      { modal: true }, 'Delete'
    );
    if (confirm !== 'Delete') { return { ok: false, error: 'Cancelled' }; }
    try {
      deleteActionFromFlow(flowPath, p.actionName);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  });

  bridge.on('/pac/insert-action', (p) => {
    try {
      const newName = insertActionInFlow(
        flowPath,
        p.predecessorName ?? null,
        p.successorName ?? null,
        p.actionType,
        p.parentAction ?? undefined,
        p.branch ?? undefined,
        p.customName ?? undefined
      );
      return { ok: true, newName };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  });

  bridge.on('/pac/copy-action', (p) => {
    try {
      const newName = copyActionInFlow(
        flowPath,
        p.sourceName,
        p.predecessorName ?? null,
        p.successorName ?? null,
        p.parentAction ?? undefined,
        p.branch ?? undefined
      );
      return { ok: true, newName };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  });

  bridge.on('/pac/save-flow-json', (p) => {
    try {
      saveFlowJson(flowPath, p.triggers, p.actions);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  });

  bridge.on('/pac/run-flow', async () => {
    const runnerPath = path.join(context.extensionPath, 'flow-runner.js');
    try {
      const results = await runFlowForResults(runnerPath, flowPath);
      return { ok: true, results };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  });

  // The "Save & Upload" button is hidden in the shell CSS; keep a helpful
  // error in case a future visualizer version re-exposes it.
  bridge.on('/pac/import', () => ({
    ok: false,
    error: 'Use "Pack & Import Solution" from the Environments tree view',
  }));

  // Real-time file watch → push (viz-main.js skips refresh while editing)
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const watcher = fs.watch(flowPath, () => {
    if (debounce) { clearTimeout(debounce); }
    debounce = setTimeout(() => bridge.push('update'), 300);
  });

  panel.onDidDispose(() => {
    if (debounce) { clearTimeout(debounce); }
    watcher.close();
  });
}

// ─── Flow runner ─────────────────────────────────────────────────────────────

function runFlowForResults(runnerPath: string, flowPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [runnerPath, flowPath, '--output-json'], { windowsHide: true });
    let stdout = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.on('close', () => {
      const match = stdout.match(/__PA_RESULTS__(.+)/);
      if (match) {
        try { resolve(JSON.parse(match[1])); }
        catch { reject(new Error('Failed to parse runner output')); }
      } else {
        reject(new Error('Flow runner did not output results. Check flow-runner.js supports --output-json.'));
      }
    });
    proc.on('error', reject);
  });
}

// ─── Webview shell ────────────────────────────────────────────────────────────
// The ported visualizer expects the dxt-bridge app shell's DOM: the real
// containers (#flow-workspace/#viz-panel and the add-action modal, from
// dxt-bridge index.html) plus a set of app-chrome elements that VIZ.open()/
// close() touch unguarded. The chrome elements are stubs, force-hidden with
// !important because open()/close() set inline display on them.

const SHELL_HTML = `
  <style>
    #content, #action-bar, #empty-state, #main-title, #main-ver,
    #btn-pa, #btn-viz-back { display: none !important; }
    .viz-json-upload-btn { display: none !important; } /* pac import not wired in the panel (v1) */
  </style>
  <div id="content"></div>
  <div id="action-bar"></div>
  <div id="empty-state"></div>
  <div id="main-title"></div>
  <div id="main-ver"></div>
  <button id="btn-pa"></button>
  <button id="btn-viz-back"></button>
  <div id="flow-workspace">
    <div class="viz-panel" id="viz-panel"></div>
  </div>
  <div id="viz-modal-overlay" class="viz-modal-overlay" onclick="VIZ._closeModal(event)">
    <div class="viz-modal" role="dialog" aria-modal="true" aria-label="Add action">
      <div class="viz-modal-header"><span>Add action</span>
        <button class="viz-modal-close" onclick="document.getElementById('viz-modal-overlay').classList.remove('open')">&#x2715;</button>
      </div>
      <div class="viz-modal-list" id="viz-modal-list"></div>
    </div>
  </div>
`;
