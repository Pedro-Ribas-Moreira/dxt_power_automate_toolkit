import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

export function openFlowVisualizer(context: vscode.ExtensionContext, flowPath: string): void {
  const rawName = path.basename(flowPath, '.json');
  const displayName = rawName
    .replace(/-[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/i, '')
    .replace(/-/g, ' ')
    .trim();

  const panel = vscode.window.createWebviewPanel(
    'dxt-flow-visualizer',
    displayName,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  function loadFlow() {
    try {
      const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
      const def = flow.properties?.definition || flow.definition || flow;
      return { name: displayName, triggers: def.triggers || {}, actions: def.actions || {} };
    } catch { return null; }
  }

  const initial = loadFlow();
  panel.webview.html = initial
    ? buildHtml(displayName, initial)
    : `<html><body style="font-family:sans-serif;padding:20px;color:#f88;">Error loading flow.</body></html>`;

  // Real-time file watch
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const watcher = fs.watch(flowPath, () => {
    if (debounce) { clearTimeout(debounce); }
    debounce = setTimeout(() => {
      const data = loadFlow();
      if (data) { panel.webview.postMessage({ type: 'update', data }); }
    }, 300);
  });

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'runFlow') {
      const runnerPath = path.join(context.extensionPath, 'flow-runner.js');
      panel.webview.postMessage({ type: 'runStart' });
      try {
        const results = await runFlowForResults(runnerPath, flowPath);
        panel.webview.postMessage({ type: 'runResults', results });
      } catch (e: any) {
        panel.webview.postMessage({ type: 'runError', message: e.message });
      }
    } else if (msg.type === 'saveAction') {
      try {
        patchActionInFlow(flowPath, msg.actionName, msg.patch);
        panel.webview.postMessage({ type: 'saveOk', actionName: msg.actionName });
      } catch (e: any) {
        panel.webview.postMessage({ type: 'saveError', actionName: msg.actionName, message: e.message });
      }
    } else if (msg.type === 'deleteAction') {
      const confirm = await vscode.window.showWarningMessage(
        `Delete "${msg.actionName}"? Successor actions will be rewired to its predecessor.`,
        { modal: true }, 'Delete'
      );
      if (confirm !== 'Delete') { return; }
      try {
        deleteActionFromFlow(flowPath, msg.actionName);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to delete action: ${e.message}`);
      }
    } else if (msg.type === 'insertAction') {
      const ACTION_PICKS = [
        { label: '$(pencil) Compose',               description: 'Build or transform a value', type: 'Compose' },
        { label: '$(package) Initialize Variable',  description: 'Declare a new variable',     type: 'InitializeVariable' },
        { label: '$(edit) Set Variable',            description: 'Update a variable',           type: 'SetVariable' },
        { label: '$(add) Append to Variable',       description: 'Append to string variable',  type: 'AppendToStringVariable' },
        { label: '$(symbol-numeric) Increment Variable', description: 'Add a number to variable', type: 'IncrementVariable' },
        { label: '$(git-branch) Condition',         description: 'If / else branch',            type: 'If' },
        { label: '$(sync) Apply to each',           description: 'Loop over an array',          type: 'Foreach' },
        { label: '$(globe) HTTP',                   description: 'Make an HTTP request',        type: 'Http' },
        { label: '$(reply) Response',               description: 'Return HTTP response',        type: 'Response' },
        { label: '$(circle-slash) Terminate',       description: 'Stop the flow',               type: 'Terminate' },
      ];
      const pick = await vscode.window.showQuickPick(ACTION_PICKS, {
        title: 'Add action — choose type',
        placeHolder: 'What kind of action do you want to add?'
      });
      if (!pick) { return; }
      try {
        insertActionInFlow(flowPath, msg.predecessorName ?? null, msg.successorName ?? null, pick.type, msg.parentAction ?? undefined, msg.branch ?? undefined);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to insert action: ${e.message}`);
      }
    }
  });

  panel.onDidDispose(() => {
    if (debounce) { clearTimeout(debounce); }
    watcher.close();
  });
}

// ─── Flow patch helpers ───────────────────────────────────────────────────────

function patchActionInFlow(flowPath: string, actionName: string, patch: Record<string, any>): void {
  const raw = fs.readFileSync(flowPath, 'utf8');
  const flowJson = JSON.parse(raw);
  const def = flowJson.properties?.definition || flowJson.definition || flowJson;
  if (!applyPatchToActions(def.actions || {}, actionName, patch)) {
    throw new Error(`Action "${actionName}" not found in flow`);
  }
  fs.writeFileSync(flowPath, JSON.stringify(flowJson, null, 2), 'utf8');
}

function applyPatchToActions(actions: Record<string, any>, name: string, patch: Record<string, any>): boolean {
  if (actions[name]) {
    Object.assign(actions[name], patch);
    return true;
  }
  for (const a of Object.values(actions)) {
    if (a.actions && applyPatchToActions(a.actions, name, patch)) { return true; }
    if (a.else?.actions && applyPatchToActions(a.else.actions, name, patch)) { return true; }
  }
  return false;
}

// ─── Flow insert helpers ──────────────────────────────────────────────────────

function insertActionInFlow(
  flowPath: string,
  predecessorName: string | null,
  successorName: string | null,
  actionType: string,
  parentAction?: string,
  branch?: string
): void {
  const raw = fs.readFileSync(flowPath, 'utf8');
  const flowJson = JSON.parse(raw);
  const def = flowJson.properties?.definition || flowJson.definition || flowJson;

  const allNames = collectAllActionNames(def.actions || {});
  let counter = 1;
  while (allNames.has(`${actionType}_${counter}`)) { counter++; }
  const newName = `${actionType}_${counter}`;

  const runAfter: Record<string, string[]> = predecessorName ? { [predecessorName]: ['Succeeded'] } : {};
  const templates: Record<string, any> = {
    Compose:               { type: 'Compose', inputs: '', runAfter },
    InitializeVariable:    { type: 'InitializeVariable', inputs: { variables: [{ name: 'NewVariable', type: 'String', value: '' }] }, runAfter },
    SetVariable:           { type: 'SetVariable', inputs: { name: '', value: '' }, runAfter },
    AppendToStringVariable:{ type: 'AppendToStringVariable', inputs: { name: '', value: '' }, runAfter },
    IncrementVariable:     { type: 'IncrementVariable', inputs: { name: '', value: 1 }, runAfter },
    If:                    { type: 'If', expression: { equals: ['', ''] }, actions: {}, else: { actions: {} }, runAfter },
    Foreach:               { type: 'Foreach', foreach: '', actions: {}, runAfter },
    Http:                  { type: 'Http', inputs: { method: 'GET', uri: '' }, runAfter },
    Response:              { type: 'Response', kind: 'Http', inputs: { statusCode: 200, body: '' }, runAfter },
    Terminate:             { type: 'Terminate', inputs: { runStatus: 'Succeeded' }, runAfter },
  };
  const newAction = templates[actionType] ?? { type: actionType, inputs: {}, runAfter };

  // Resolve which actions object to insert into
  let scope: Record<string, any> | null = null;

  if (predecessorName || successorName) {
    // Normal case — find scope by looking up the ref action
    scope = findActionScope(def.actions || {}, (successorName ?? predecessorName)!);
  } else if (parentAction && branch) {
    // Empty branch case — navigate directly to the parent action's branch
    const parentScope = findActionScope(def.actions || {}, parentAction);
    const parent = parentScope?.[parentAction];
    if (!parent) { throw new Error(`Parent action "${parentAction}" not found`); }
    if (branch === 'yes' || branch === 'foreach' || branch === 'scope') {
      if (!parent.actions) { parent.actions = {}; }
      scope = parent.actions;
    } else if (branch === 'no') {
      if (!parent.else) { parent.else = { actions: {} }; }
      if (!parent.else.actions) { parent.else.actions = {}; }
      scope = parent.else.actions;
    }
  } else {
    scope = def.actions || {};
  }

  if (!scope) { throw new Error(`Cannot find insertion scope`); }

  scope[newName] = newAction;

  // Redirect successor's runAfter from predecessor → new action
  if (successorName && scope[successorName]) {
    const ra: Record<string, string[]> = scope[successorName].runAfter ?? {};
    if (predecessorName && ra[predecessorName]) {
      ra[newName] = ra[predecessorName];
      delete ra[predecessorName];
    } else if (!predecessorName) {
      ra[newName] = ['Succeeded'];
    }
    scope[successorName].runAfter = ra;
  }

  fs.writeFileSync(flowPath, JSON.stringify(flowJson, null, 2), 'utf8');
}

function deleteActionFromFlow(flowPath: string, actionName: string): void {
  const raw = fs.readFileSync(flowPath, 'utf8');
  const flowJson = JSON.parse(raw);
  const def = flowJson.properties?.definition || flowJson.definition || flowJson;

  const scope = findActionScope(def.actions || {}, actionName);
  if (!scope?.[actionName]) { throw new Error(`Action "${actionName}" not found`); }

  const deletedRunAfter: Record<string, string[]> = scope[actionName].runAfter || {};
  delete scope[actionName];

  // Reconnect any actions that depended on the deleted one
  reconnectRunAfter(def.actions || {}, actionName, deletedRunAfter);
  fs.writeFileSync(flowPath, JSON.stringify(flowJson, null, 2), 'utf8');
}

function reconnectRunAfter(actions: Record<string, any>, deletedName: string, deletedRunAfter: Record<string, string[]>): void {
  for (const action of Object.values(actions) as any[]) {
    if (action.runAfter?.[deletedName]) {
      delete action.runAfter[deletedName];
      // Inherit the deleted action's own predecessors
      for (const [pred, statuses] of Object.entries(deletedRunAfter)) {
        action.runAfter[pred] = statuses as string[];
      }
    }
    if (action.actions) { reconnectRunAfter(action.actions, deletedName, deletedRunAfter); }
    if (action.else?.actions) { reconnectRunAfter(action.else.actions, deletedName, deletedRunAfter); }
  }
}

function collectAllActionNames(actions: Record<string, any>, out = new Set<string>()): Set<string> {
  for (const [name, a] of Object.entries(actions)) {
    out.add(name);
    if (a.actions) { collectAllActionNames(a.actions, out); }
    if (a.else?.actions) { collectAllActionNames(a.else.actions, out); }
  }
  return out;
}

function findActionScope(actions: Record<string, any>, targetName: string): Record<string, any> | null {
  if (actions[targetName]) { return actions; }
  for (const a of Object.values(actions) as any[]) {
    if (a.actions) { const f = findActionScope(a.actions, targetName); if (f) { return f; } }
    if (a.else?.actions) { const f = findActionScope(a.else.actions, targetName); if (f) { return f; } }
  }
  return null;
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

// ─── HTML builder ─────────────────────────────────────────────────────────────

function buildHtml(displayName: string, data: any): string {
  const safeData = JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${CSS}</style>
</head>
<body>
<div id="root"></div>
<script>
let DATA = ${safeData};
${JS}
render(DATA);
</script>
</body>
</html>`;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-font-family, -apple-system, 'Segoe UI', sans-serif);
  font-size: 13px;
  padding: 20px 24px 40px;
}

.header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 28px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--vscode-editorWidget-border, #454545);
}
.header-icon { font-size: 22px; }
.header-title { font-size: 17px; font-weight: 700; flex: 1; }
.header-count {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-editorWidget-border, #454545);
  padding: 2px 10px;
  border-radius: 10px;
}

.canvas {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  max-width: 520px;
  margin: 0 auto;
}

/* ── Connector arrow + insert point ── */
.insert-row {
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
  cursor: default;
}
.arrow {
  width: 2px;
  height: 14px;
  background: var(--vscode-editorWidget-border, #454545);
  position: relative;
  flex-shrink: 0;
}
.arrow.arrow-bottom::after {
  content: '';
  position: absolute;
  bottom: -5px;
  left: 50%;
  transform: translateX(-50%);
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-top: 6px solid var(--vscode-editorWidget-border, #454545);
}
.insert-btn {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 1px solid var(--vscode-editorWidget-border, #454545);
  background: var(--vscode-editorWidget-background, #252526);
  color: var(--vscode-descriptionForeground);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s, background 0.1s;
  flex-shrink: 0;
  padding: 0;
}
.insert-row:hover .insert-btn { opacity: 1; }
.insert-btn:hover {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  border-color: var(--vscode-button-background, #0e639c);
  opacity: 1 !important;
}

/* ── Action card ── */
.card {
  width: 100%;
  border-radius: 6px;
  background: var(--vscode-editorWidget-background, #252526);
  border: 1px solid var(--vscode-editorWidget-border, #454545);
  overflow: hidden;
  transition: box-shadow 0.12s;
}
.card:hover { box-shadow: 0 2px 10px rgba(0,0,0,.35); }

.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 13px;
  border-left: 4px solid;
  user-select: none;
  cursor: pointer;
}
.card-icon { font-size: 17px; width: 22px; text-align: center; flex-shrink: 0; }
.card-name { font-weight: 600; font-size: 13px; flex: 1; }
.card-type {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family, monospace);
  white-space: nowrap;
}
.card-chevron {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  transition: transform 0.15s;
}
.card-chevron.open { transform: rotate(90deg); }

.card-body {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  border-top: 1px solid var(--vscode-editorWidget-border, #454545);
  word-break: break-word;
}

/* ── Edit button in card/loop header ── */
.edit-btn {
  background: none;
  border: 1px solid transparent;
  border-radius: 3px;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 6px;
  opacity: 0;
  transition: opacity 0.15s;
  flex-shrink: 0;
  line-height: 1;
}
.card-head:hover .edit-btn,
.loop-header:hover .edit-btn,
.scope-header:hover .edit-btn { opacity: 1; }
.edit-btn:hover {
  opacity: 1 !important;
  background: var(--vscode-list-hoverBackground, rgba(255,255,255,.06));
  border-color: var(--vscode-editorWidget-border, #454545);
}
.delete-btn {
  background: none;
  border: 1px solid transparent;
  border-radius: 3px;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 6px;
  opacity: 0;
  transition: opacity 0.15s, color 0.1s;
  flex-shrink: 0;
  line-height: 1;
}
.card-head:hover .delete-btn,
.loop-header:hover .delete-btn,
.scope-header:hover .delete-btn { opacity: 1; }
.delete-btn:hover {
  opacity: 1 !important;
  color: #e07070;
  background: rgba(224,112,112,.12);
  border-color: rgba(224,112,112,.35);
}

/* ── Edit panel ── */
.edit-panel {
  display: none;
  border-top: 2px solid var(--vscode-focusBorder, #007fd4);
  padding: 12px 13px 14px;
}
.edit-field { margin-bottom: 10px; }
.edit-label {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 4px;
}
.edit-text, .edit-select {
  width: 100%;
  background: var(--vscode-input-background, #3c3c3c);
  border: 1px solid var(--vscode-input-border, #555);
  color: var(--vscode-input-foreground, #ccc);
  border-radius: 3px;
  padding: 5px 8px;
  font-size: 12px;
  font-family: var(--vscode-editor-font-family, monospace);
}
.edit-expr {
  width: 100%;
  min-height: 60px;
  background: var(--vscode-input-background, #3c3c3c);
  border: 1px solid var(--vscode-input-border, #555);
  color: var(--vscode-input-foreground, #ccc);
  border-radius: 3px;
  padding: 6px 8px;
  font-size: 12px;
  font-family: var(--vscode-editor-font-family, monospace);
  resize: vertical;
  display: block;
}
.edit-text:focus, .edit-select:focus, .edit-expr:focus {
  outline: none;
  border-color: var(--vscode-focusBorder, #007fd4);
}
.edit-actions { display: flex; gap: 8px; margin-top: 12px; }
.edit-save-btn {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  border: none;
  border-radius: 4px;
  padding: 5px 14px;
  font-size: 12px;
  cursor: pointer;
}
.edit-save-btn:hover { filter: brightness(1.15); }
.edit-save-btn:disabled { opacity: 0.5; cursor: default; }
.edit-cancel-btn {
  background: none;
  color: var(--vscode-descriptionForeground);
  border: 1px solid var(--vscode-editorWidget-border, #454545);
  border-radius: 4px;
  padding: 5px 14px;
  font-size: 12px;
  cursor: pointer;
}
.edit-cancel-btn:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,.04)); }

/* ── Dynamic content picker ── */
.dc-picker { margin-top: 5px; display: inline-block; }
.dc-btn {
  background: none;
  border: 1px solid var(--vscode-editorWidget-border, #454545);
  border-radius: 3px;
  color: var(--vscode-button-background, #0e639c);
  cursor: pointer;
  font-size: 11px;
  padding: 3px 8px;
}
.dc-btn:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,.04)); }
.dc-menu {
  position: fixed;
  z-index: 9999;
  background: var(--vscode-dropdown-background, #252526);
  border: 1px solid var(--vscode-editorWidget-border, #454545);
  border-radius: 4px;
  min-width: 320px;
  max-width: 420px;
  max-height: 360px;
  overflow-y: auto;
  display: none;
  box-shadow: 0 6px 24px rgba(0,0,0,.6);
}
.dc-group {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--vscode-descriptionForeground);
  padding: 6px 10px 2px;
  background: var(--vscode-editorWidget-background, #252526);
  position: sticky;
  top: 0;
}
.dc-item {
  font-size: 11px;
  padding: 4px 10px 4px 16px;
  cursor: pointer;
  font-family: var(--vscode-editor-font-family, monospace);
  color: var(--vscode-editor-foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dc-item:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,.08)); }

/* ── Foreach loop container ── */
.loop-box {
  width: 100%;
  border: 2px dashed var(--vscode-editorWidget-border, #454545);
  border-radius: 8px;
  overflow: hidden;
}
.loop-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 13px;
  border-left: 4px solid #00A4EF;
  background: var(--vscode-editorWidget-background);
  cursor: pointer;
  user-select: none;
}
.loop-inner {
  padding: 12px 12px 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  border-top: 2px dashed var(--vscode-editorWidget-border, #454545);
}
.loop-inner.collapsed { display: none; }
.loop-badge {
  font-size: 10px;
  background: #00A4EF22;
  color: #00A4EF;
  border: 1px solid #00A4EF44;
  padding: 1px 7px;
  border-radius: 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 160px;
}

/* ── Condition ── */
.condition-wrap { width: 100%; }
.condition-branches {
  display: flex;
  gap: 12px;
  margin-top: 2px;
}
.branch {
  flex: 1;
  border-radius: 6px;
  border: 1px solid var(--vscode-editorWidget-border, #454545);
  background: var(--vscode-editorWidget-background);
  overflow: hidden;
  min-width: 0;
}
.branch-label {
  font-size: 11px;
  font-weight: 700;
  padding: 5px 10px;
  display: flex;
  align-items: center;
  gap: 5px;
}
.branch-yes .branch-label { background: #107C1018; color: #4EC94E; }
.branch-no  .branch-label { background: #CD2D2D18; color: #E07070; }
.branch-inner {
  padding: 6px 6px 6px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
}
.branch-empty-btn {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  text-align: center;
  padding: 10px 6px;
  margin: 6px;
  cursor: pointer;
  border: 1px dashed var(--vscode-editorWidget-border, #454545);
  border-radius: 4px;
  transition: background 0.1s, color 0.1s;
  font-style: italic;
  user-select: none;
}
.branch-empty-btn:hover {
  background: var(--vscode-list-hoverBackground, rgba(255,255,255,.06));
  color: var(--vscode-editor-foreground);
  border-style: solid;
}

/* ── Search bar ── */
.toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 20px;
  align-items: center;
}
.search-input {
  flex: 1;
  background: var(--vscode-input-background, #3c3c3c);
  border: 1px solid var(--vscode-input-border, #555);
  color: var(--vscode-input-foreground, #ccc);
  border-radius: 4px;
  padding: 5px 10px;
  font-size: 12px;
  outline: none;
}
.search-input:focus { border-color: var(--vscode-focusBorder, #007fd4); }
.run-btn {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  border: none;
  border-radius: 4px;
  padding: 5px 14px;
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}
.run-btn:hover { filter: brightness(1.15); }
.run-btn:disabled { opacity: 0.5; cursor: default; }

/* ── Input / Output tabs ── */
.card-tabs { border-top: 1px solid var(--vscode-editorWidget-border, #454545); }
.tab-bar { display: flex; }
.tab-btn {
  flex: 1;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  padding: 5px 0;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  transition: color 0.1s, border-color 0.1s;
}
.tab-btn:hover { color: var(--vscode-editor-foreground); }
.tab-btn.active {
  color: var(--vscode-editor-foreground);
  border-bottom-color: var(--vscode-button-background, #0e639c);
}
.tab-pane { display: none; padding: 6px 0 4px 0; }
.tab-pane.active { display: block; }

/* ── PA-style field/value table ── */
.pa-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.pa-table td {
  padding: 3px 10px;
  vertical-align: top;
  border-top: 1px solid var(--vscode-editorWidget-border, #333);
  max-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pa-table td:first-child {
  color: var(--vscode-descriptionForeground);
  width: 38%;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10px;
}
.pa-table td:last-child { width: 62%; }
.pa-table tr:hover td { background: var(--vscode-list-hoverBackground, rgba(255,255,255,.04)); }
.pa-copy-btn {
  background: none;
  border: 1px solid var(--vscode-editorWidget-border, #555);
  border-radius: 3px;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  font-size: 9px;
  padding: 1px 5px;
  margin-left: 4px;
  opacity: 0;
  transition: opacity 0.1s;
  vertical-align: middle;
}
.pa-table tr:hover .pa-copy-btn { opacity: 1; }
.pa-section-label {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--vscode-descriptionForeground);
  padding: 5px 10px 2px;
}
.pa-count { font-size: 10px; color: var(--vscode-descriptionForeground); padding: 3px 10px 5px; }

/* ── Run results overlay ── */
.card.result-pass { border-left-color: #4EC94E !important; }
.card.result-fail { border-left-color: #E07070 !important; }
.card.result-skip { border-left-color: #E0C04E !important; }
.result-badge { font-size: 14px; margin-left: 4px; }
.run-summary {
  text-align: center;
  font-size: 12px;
  padding: 10px;
  border-radius: 6px;
  margin-bottom: 16px;
}
.run-summary.pass { background: #107C1018; color: #4EC94E; }
.run-summary.fail { background: #CD2D2D18; color: #E07070; }

/* ── Live update banner ── */
.update-banner {
  position: fixed;
  top: 12px;
  right: 16px;
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  font-size: 11px;
  padding: 4px 12px;
  border-radius: 12px;
  opacity: 0;
  transition: opacity 0.2s;
  pointer-events: none;
  z-index: 100;
}
.update-banner.show { opacity: 1; }

@keyframes flash {
  0%   { background: var(--vscode-editorWidget-background); }
  30%  { background: color-mix(in srgb, var(--vscode-button-background) 15%, var(--vscode-editorWidget-background)); }
  100% { background: var(--vscode-editorWidget-background); }
}
.card.updated { animation: flash 0.6s ease-out; }

/* ── Health check panel ── */
.health-panel {
  margin-bottom: 20px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--vscode-editorWidget-border, #454545);
  width: 100%;
  max-width: 520px;
  margin-left: auto;
  margin-right: auto;
}
.health-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
  font-size: 12px;
  font-weight: 600;
}
.health-ok    .health-header { background: #107C1018; }
.health-error .health-header { background: #CD2D2D18; }
.health-warn  .health-header { background: rgba(224,192,78,.12); }
.health-info  .health-header { background: #0078D418; }
.health-summary { flex: 1; }
.health-chevron {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  transition: transform 0.15s;
}
.health-chevron.open { transform: rotate(90deg); }
.health-body { border-top: 1px solid var(--vscode-editorWidget-border, #454545); }
.health-body.collapsed { display: none; }
.health-item {
  padding: 10px 14px;
  border-left: 3px solid transparent;
  border-bottom: 1px solid var(--vscode-editorWidget-border, #33333355);
  font-size: 12px;
}
.health-item:last-child { border-bottom: none; }
.health-item-error { border-left-color: #E07070; }
.health-item-warn  { border-left-color: #E0C04E; }
.health-item-info  { border-left-color: #4A9CD4; }
.health-item-title {
  font-weight: 600;
  margin-bottom: 4px;
  color: var(--vscode-editor-foreground);
  font-size: 12px;
}
.health-item-detail {
  color: var(--vscode-descriptionForeground);
  line-height: 1.55;
  font-size: 11px;
}

/* ── Scope container ── */
.scope-box {
  width: 100%;
  border: 2px dashed #7B5EA7;
  border-radius: 8px;
  overflow: hidden;
}
.scope-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 13px;
  border-left: 4px solid #7B5EA7;
  background: var(--vscode-editorWidget-background);
  cursor: pointer;
  user-select: none;
}
.scope-inner {
  padding: 12px 12px 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  border-top: 2px dashed #7B5EA7;
}
.scope-inner.collapsed { display: none; }

/* ── Type colour palette ── */
.t-trigger    { border-color: #742774; }
.t-compose    { border-color: #E06C00; }
.t-foreach    { border-color: #00A4EF; }
.t-condition  { border-color: #0078D4; }
.t-scope      { border-color: #7B5EA7; }
.t-variable   { border-color: #9B4F96; }
.t-api        { border-color: #0078D4; }
.t-http       { border-color: #085B99; }
.t-parsejson  { border-color: #00BCD4; }
.t-response   { border-color: #107C10; }
.t-other      { border-color: #5a5a5a; }
`;

// ─── Client-side JS ───────────────────────────────────────────────────────────

const JS = `
// ── Globals ──────────────────────────────────────────────────────────────────
let PREV_MAP = {};
let uid = 0;
function nextId() { return 'n' + (++uid); }

// ── Utilities ─────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escJs(s) {
  return String(s).replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'");
}
function sid(name) { return 'ac_' + name.replace(/[^a-zA-Z0-9]/g, '_'); }
function fmt(name) { return name.replace(/_/g,' '); }

function isEditableType(t) {
  return ['Compose','InitializeVariable','SetVariable','AppendToStringVariable',
          'IncrementVariable','Foreach','If','Http','Response','Terminate',
          'ApiConnection','OpenApiConnection'].indexOf(t) >= 0;
}

function findNestedAction(actions, name) {
  if (!actions) return null;
  if (actions[name]) return actions[name];
  for (var k in actions) {
    var a = actions[k];
    var found = findNestedAction(a.actions, name)
             || findNestedAction(a.else && a.else.actions, name);
    if (found) return found;
  }
  return null;
}

// ── Action type metadata ──────────────────────────────────────────────────────
function typeInfo(t) {
  var m = {
    Request:               { icon:'⚡', cls:'t-trigger',   label:'Trigger'             },
    Recurrence:            { icon:'🕐', cls:'t-trigger',   label:'Scheduled trigger'   },
    Compose:               { icon:'📝', cls:'t-compose',   label:'Compose'             },
    Foreach:               { icon:'🔄', cls:'t-foreach',   label:'Apply to each'       },
    If:                    { icon:'🔀', cls:'t-condition', label:'Condition'           },
    Scope:                 { icon:'🗂️', cls:'t-scope',     label:'Scope'               },
    InitializeVariable:    { icon:'📦', cls:'t-variable',  label:'Initialize variable' },
    SetVariable:           { icon:'✏️',  cls:'t-variable',  label:'Set variable'        },
    AppendToStringVariable:{ icon:'➕', cls:'t-variable',  label:'Append to variable'  },
    IncrementVariable:     { icon:'🔢', cls:'t-variable',  label:'Increment variable'  },
    ApiConnection:         { icon:'🔌', cls:'t-api',       label:'Connector action'    },
    OpenApiConnection:     { icon:'🔌', cls:'t-api',       label:'Connector action'    },
    Http:                  { icon:'🌐', cls:'t-http',      label:'HTTP'                },
    ParseJson:             { icon:'📄', cls:'t-parsejson', label:'Parse JSON'          },
    Response:              { icon:'↩️',  cls:'t-response',  label:'Response'            },
    Terminate:             { icon:'🛑', cls:'t-other',     label:'Terminate'           },
    Delay:                 { icon:'⏱️',  cls:'t-other',     label:'Delay'               },
  };
  return m[t] || { icon:'⚙️', cls:'t-other', label: t };
}

function detail(action) {
  var type = action.type, inputs = action.inputs, fe = action.foreach;
  if (type === 'Compose' && inputs !== undefined) {
    var v = typeof inputs === 'string' ? inputs : JSON.stringify(inputs);
    return 'Input: ' + (v.length > 120 ? v.slice(0,120)+'…' : v);
  }
  if ((type === 'InitializeVariable' || type === 'SetVariable') && inputs) {
    var vr = inputs.variables && inputs.variables[0];
    if (vr) return vr.name + ' (' + vr.type + ')' + (vr.value !== undefined ? ' = ' + JSON.stringify(vr.value) : '');
    return inputs.name ? inputs.name + (inputs.value !== undefined ? ' = ' + JSON.stringify(inputs.value) : '') : null;
  }
  if (type === 'AppendToStringVariable' && inputs) return inputs.name + ' += ' + JSON.stringify(inputs.value);
  if (type === 'Foreach' && fe) return 'Each item in: ' + fe;
  if (type === 'ApiConnection' && inputs) {
    var p = inputs.path || ''; var mm = (inputs.method || 'GET').toUpperCase();
    return (mm + ' ' + p).slice(0, 100);
  }
  if (type === 'Http' && inputs) return ((inputs.method||'GET').toUpperCase() + ' ' + (inputs.uri||'')).slice(0,100);
  if (type === 'Response' && inputs) return 'Status: ' + (inputs.statusCode || 200);
  if (type === 'Terminate' && inputs) return 'Status: ' + (inputs.runStatus || '—') + (inputs.runError && inputs.runError.message ? ' — ' + inputs.runError.message : '');
  return null;
}

// ── Health check engine ───────────────────────────────────────────────────────
function collectAllActionsFlat(actions, out) {
  if (!out) out = [];
  if (!actions) return out;
  for (var n in actions) {
    var a = actions[n];
    out.push({ name: n, action: a });
    collectAllActionsFlat(a.actions, out);
    collectAllActionsFlat(a.else && a.else.actions, out);
  }
  return out;
}

function analyzeFlow(data) {
  var issues = [];
  var triggers = data.triggers || {};
  var actions  = data.actions  || {};
  var all = collectAllActionsFlat(actions);
  var triggerList = Object.keys(triggers).map(function(k) { return triggers[k]; });

  // ── HTTP trigger → APIM ────────────────────────────────────────────────────
  var isHttp = triggerList.some(function(t) { return t.type === 'Request'; });
  if (isHttp) {
    issues.push({ level:'error', icon:'🔒', title:'Register HTTP endpoint in APIM',
      detail:'This flow is triggered by HTTP. The generated URL must be registered in Azure API Management before going live — never expose it directly. Without APIM there is no rate limiting, authentication, or audit trail. Contact the platform team to register this endpoint.' });
  }

  // ── HTTP trigger + no Response action ─────────────────────────────────────
  if (isHttp) {
    var hasResponse = all.some(function(e) { return e.action.type === 'Response'; });
    if (!hasResponse) {
      issues.push({ level:'error', icon:'↩️', title:'Missing Response action',
        detail:'HTTP-triggered flows must return a Response action on every code path (success and failure). Without it callers will hang until they time out (typically 120 s), causing errors on the sending side.' });
    }
  }

  // ── No Try/Catch error handling ────────────────────────────────────────────
  var hasErrHandling = all.some(function(e) {
    var ra = e.action.runAfter || {};
    return Object.keys(ra).some(function(pred) {
      var conds = ra[pred] || [];
      return conds.some(function(c) { return c === 'Failed' || c === 'TimedOut' || c === 'Skipped'; });
    });
  });
  if (!hasErrHandling) {
    issues.push({ level:'error', icon:'🛡️', title:'No error handling (Try/Catch)',
      detail:'Wrap your main logic in a Scope action ("Try"), then add a second Scope set to run after it on Failed/TimedOut ("Catch"). Inside the Catch, at minimum send a Teams or email alert so the team knows immediately when something breaks. Unhandled failures are invisible.' });
  }

  // ── No failure notification ────────────────────────────────────────────────
  var notifKeywords = ['mail','outlook','teams','notification','slack','sms','sendgrid'];
  var hasNotif = all.some(function(e) {
    var a = e.action;
    if (a.type !== 'ApiConnection' && a.type !== 'OpenApiConnection') return false;
    var apiId = (a.inputs && a.inputs.host && a.inputs.host.apiId) || '';
    var opId  = (a.inputs && a.inputs.host && a.inputs.host.operationId) || '';
    var text  = (apiId + ' ' + opId).toLowerCase();
    return notifKeywords.some(function(kw) { return text.indexOf(kw) >= 0; });
  });
  if (!hasNotif) {
    issues.push({ level:'warn', icon:'🔔', title:'No failure notification detected',
      detail:'No Teams, email, or SMS action was found in this flow. Add a notification inside your Catch scope so the team is alerted on failure. Recommended: "Post message in a chat or channel" (Teams) or "Send an email" (Outlook 365).' });
  }

  // ── Empty condition branches ───────────────────────────────────────────────
  all.forEach(function(e) {
    if (e.action.type !== 'If') return;
    var yesEmpty = !e.action.actions || Object.keys(e.action.actions).length === 0;
    var noEmpty  = !e.action.else || !e.action.else.actions || Object.keys(e.action.else.actions).length === 0;
    if (yesEmpty || noEmpty) {
      issues.push({ level:'warn', icon:'🔀', title:'Empty branch in: ' + e.name.replace(/_/g,' '),
        detail: (yesEmpty && noEmpty ? 'Both Yes and No branches are empty.' : yesEmpty ? 'The Yes branch is empty.' : 'The No branch is empty.') + ' An empty branch usually means unfinished logic. Add at least a Compose or Terminate to make the intent explicit.' });
    }
  });

  // ── HTTP action without authentication ────────────────────────────────────
  all.forEach(function(e) {
    if (e.action.type !== 'Http') return;
    var inp = e.action.inputs || {};
    var headersStr = inp.headers ? JSON.stringify(inp.headers).toLowerCase() : '';
    var hasAuth = inp.authentication
      || headersStr.indexOf('authorization') >= 0
      || headersStr.indexOf('api-key') >= 0
      || headersStr.indexOf('ocp-apim') >= 0;
    if (!hasAuth) {
      issues.push({ level:'warn', icon:'🌐', title:'Unauthenticated HTTP call: ' + e.name.replace(/_/g,' '),
        detail:'This HTTP action has no authentication configured. If the endpoint is internal or sensitive, add an Authorization header or use the Authentication field to set up OAuth 2.0, Basic, or Managed Identity.' });
    }
  });

  // ── Foreach without concurrency control ───────────────────────────────────
  all.forEach(function(e) {
    if (e.action.type !== 'Foreach') return;
    var hasConcurrency = e.action.runtimeConfiguration && e.action.runtimeConfiguration.concurrency;
    if (!hasConcurrency) {
      issues.push({ level:'info', icon:'⚡', title:'Foreach without concurrency limit: ' + e.name.replace(/_/g,' '),
        detail:'By default Power Automate runs loop iterations concurrently (up to 50 at once). For connector calls this can hit throttling limits fast. Consider enabling Concurrency Control under the loop Settings and setting a limit of 1 (sequential) or a small number.' });
    }
  });

  return issues;
}

function renderHealthPanel(issues) {
  if (!issues.length) {
    return '<div class="health-panel health-ok">'
      + '<div class="health-header">✅ <span class="health-summary">Flow looks healthy — no issues found</span></div>'
      + '</div>';
  }
  var errors = issues.filter(function(i) { return i.level === 'error'; }).length;
  var warns  = issues.filter(function(i) { return i.level === 'warn';  }).length;
  var infos  = issues.filter(function(i) { return i.level === 'info';  }).length;
  var parts  = [];
  if (errors) parts.push(errors + ' error'   + (errors > 1 ? 's' : ''));
  if (warns)  parts.push(warns  + ' warning' + (warns  > 1 ? 's' : ''));
  if (infos)  parts.push(infos  + ' tip'     + (infos  > 1 ? 's' : ''));
  var topLevel = errors ? 'error' : warns ? 'warn' : 'info';
  var topIcon  = errors ? '🔴' : warns ? '🟡' : '🔵';
  var html = '<div class="health-panel health-' + topLevel + '">'
    + '<div class="health-header" onclick="toggleHealth()">'
    + '<span>' + topIcon + '</span>'
    + '<span class="health-summary">' + escHtml(parts.join(' · ')) + '</span>'
    + '<span class="health-chevron open" id="healthChev">›</span>'
    + '</div>'
    + '<div class="health-body" id="healthBody">';
  issues.forEach(function(issue) {
    html += '<div class="health-item health-item-' + issue.level + '">'
      + '<div class="health-item-title">' + issue.icon + '&nbsp;' + escHtml(issue.title) + '</div>'
      + '<div class="health-item-detail">' + escHtml(issue.detail) + '</div>'
      + '</div>';
  });
  html += '</div></div>';
  return html;
}

function toggleHealth() {
  var body = document.getElementById('healthBody');
  var chev = document.getElementById('healthChev');
  if (body) body.classList.toggle('collapsed');
  if (chev) chev.classList.toggle('open');
}

// ── Static inputs panel (shown on card click) ─────────────────────────────────
function buildStaticInputs(action) {
  var type = action.type, inputs = action.inputs;
  var rows = [];

  if (type === 'ApiConnection' || type === 'OpenApiConnection') {
    var host   = inputs && inputs.host;
    var params = inputs && inputs.parameters;
    if (host) {
      if (host.operationId)          rows.push({ k:'operationId', v: host.operationId });
      if (host.apiId) {
        var seg = String(host.apiId).split('/');
        rows.push({ k:'connector', v: seg[seg.length - 1] });
      }
      if (host.connectionReferenceName) rows.push({ k:'connection', v: host.connectionReferenceName });
    }
    if (params) {
      for (var pk in params) {
        var pv = params[pk];
        rows.push({ k: pk, v: typeof pv === 'object' ? JSON.stringify(pv) : String(pv) });
      }
    }
  } else if (type === 'Compose') {
    var cv = typeof inputs === 'string' ? inputs : (inputs !== undefined ? JSON.stringify(inputs) : '');
    rows.push({ k:'inputs', v: cv });
  } else if (type === 'InitializeVariable') {
    var vr = inputs && inputs.variables && inputs.variables[0];
    if (vr) {
      rows.push({ k:'name', v: String(vr.name || '') });
      rows.push({ k:'type', v: String(vr.type || 'String') });
      if (vr.value !== undefined) rows.push({ k:'value', v: String(vr.value) });
    }
  } else if (type === 'SetVariable' || type === 'AppendToStringVariable') {
    if (inputs) {
      rows.push({ k:'name',  v: String(inputs.name  || '') });
      if (inputs.value !== undefined) rows.push({ k:'value', v: String(inputs.value) });
    }
  } else if (type === 'IncrementVariable') {
    if (inputs) {
      rows.push({ k:'name',  v: String(inputs.name  || '') });
      rows.push({ k:'value', v: String(inputs.value !== undefined ? inputs.value : 1) });
    }
  } else if (type === 'Http') {
    if (inputs) {
      rows.push({ k:'method', v: (inputs.method || 'GET').toUpperCase() });
      rows.push({ k:'uri',    v: String(inputs.uri || '') });
      if (inputs.body    !== undefined) rows.push({ k:'body',    v: typeof inputs.body    === 'string' ? inputs.body    : JSON.stringify(inputs.body) });
      if (inputs.headers !== undefined) rows.push({ k:'headers', v: JSON.stringify(inputs.headers) });
    }
  } else if (type === 'Response') {
    if (inputs) {
      rows.push({ k:'statusCode', v: String(inputs.statusCode || 200) });
      if (inputs.body    !== undefined) rows.push({ k:'body',    v: typeof inputs.body    === 'string' ? inputs.body    : JSON.stringify(inputs.body) });
      if (inputs.headers !== undefined) rows.push({ k:'headers', v: JSON.stringify(inputs.headers) });
    }
  } else if (type === 'Terminate') {
    if (inputs) {
      rows.push({ k:'runStatus', v: String(inputs.runStatus || 'Succeeded') });
      if (inputs.runError && inputs.runError.message) rows.push({ k:'errorMessage', v: String(inputs.runError.message) });
    }
  } else if (type === 'ParseJson') {
    if (inputs && inputs.content !== undefined)
      rows.push({ k:'content', v: typeof inputs.content === 'string' ? inputs.content : JSON.stringify(inputs.content) });
  } else if (inputs && typeof inputs === 'object') {
    for (var ik in inputs) {
      var iv = inputs[ik];
      rows.push({ k: ik, v: typeof iv === 'object' ? JSON.stringify(iv) : String(iv) });
    }
  } else if (inputs !== undefined) {
    rows.push({ k:'inputs', v: String(inputs) });
  }

  if (!rows.length) return '';
  var html = '<div class="pa-section-label">INPUTS</div><table class="pa-table">';
  rows.forEach(function(row) {
    var val = String(row.v);
    var display = val.length > 120 ? val.slice(0, 120) + '…' : val;
    html += '<tr><td>' + escHtml(row.k) + '</td><td title="' + escHtml(val) + '">' + escHtml(display) + '</td></tr>';
  });
  html += '</table>';
  return html;
}

// ── Topological sort ──────────────────────────────────────────────────────────
function topoSort(actions) {
  var visited = {}, order = [];
  function visit(n) {
    if (visited[n]) return;
    visited[n] = true;
    var runAfter = actions[n] && actions[n].runAfter || {};
    for (var d in runAfter) { if (actions[d]) visit(d); }
    order.push(n);
  }
  for (var n in actions) visit(n);
  return order;
}

// Build map of actionName → array of preceding action descriptors
function buildPrevMap(actions, prevAtLevel) {
  if (!prevAtLevel) prevAtLevel = [];
  var order = topoSort(actions);
  var result = {};
  for (var i = 0; i < order.length; i++) {
    var name = order[i];
    var action = actions[name];
    var prevHere = prevAtLevel.concat(order.slice(0, i).map(function(n) {
      return { name: n, type: actions[n].type, inputs: actions[n].inputs };
    }));
    result[name] = prevHere;
    if (action.actions) {
      var nested = buildPrevMap(action.actions, prevHere);
      for (var k in nested) result[k] = nested[k];
    }
    if (action.else && action.else.actions) {
      var nested2 = buildPrevMap(action.else.actions, prevHere);
      for (var k2 in nested2) result[k2] = nested2[k2];
    }
  }
  return result;
}

// ── Dynamic content picker ────────────────────────────────────────────────────
function buildDynamicContent(taId, prevActions) {
  if (!prevActions || !prevActions.length) return '';
  var menuId = 'dcm_' + taId;
  var items = '<div class="dc-group">⚡ Trigger</div>'
    + '<div class="dc-item" data-ta="'+taId+'" data-expr="@{triggerBody()}" onclick="insertFromData(this,event)">@{triggerBody()}</div>'
    + '<div class="dc-item" data-ta="'+taId+'" data-expr="@{triggerOutputs()}" onclick="insertFromData(this,event)">@{triggerOutputs()}</div>';

  for (var pi = 0; pi < prevActions.length; pi++) {
    var pa = prevActions[pi];
    items += '<div class="dc-group">'+escHtml(pa.name.replace(/_/g,' '))+' <span style="font-size:9px;opacity:.5">'+escHtml(pa.type)+'</span></div>';

    if (pa.type === 'InitializeVariable' || pa.type === 'SetVariable'
        || pa.type === 'AppendToStringVariable' || pa.type === 'IncrementVariable') {
      var vname = (pa.inputs && pa.inputs.variables && pa.inputs.variables[0] && pa.inputs.variables[0].name)
               || (pa.inputs && pa.inputs.name) || pa.name;
      var vexpr = "@{variables('" + vname + "')}";
      items += '<div class="dc-item" data-ta="'+taId+'" data-expr="'+escHtml(vexpr)+'" onclick="insertFromData(this,event)">'+escHtml(vexpr)+'</div>';
    } else if (pa.type === 'Compose') {
      var co1 = "@{outputs('"+pa.name+"')}";
      var co2 = "@{outputs('"+pa.name+"')?['body']}";
      items += '<div class="dc-item" data-ta="'+taId+'" data-expr="'+escHtml(co1)+'" onclick="insertFromData(this,event)">'+escHtml(co1)+'</div>'
             + '<div class="dc-item" data-ta="'+taId+'" data-expr="'+escHtml(co2)+'" onclick="insertFromData(this,event)">'+escHtml(co2)+'</div>';
    } else if (pa.type === 'ParseJson') {
      var pj1 = "@{body('"+pa.name+"')}";
      items += '<div class="dc-item" data-ta="'+taId+'" data-expr="'+escHtml(pj1)+'" onclick="insertFromData(this,event)">'+escHtml(pj1)+'</div>';
    } else {
      var ae1 = "@{body('"+pa.name+"')}";
      var ae2 = "@{body('"+pa.name+"')?['value']}";
      var ae3 = "@{body('"+pa.name+"')?['value'][0]?['Id']}";
      items += '<div class="dc-item" data-ta="'+taId+'" data-expr="'+escHtml(ae1)+'" onclick="insertFromData(this,event)">'+escHtml(ae1)+'</div>'
             + '<div class="dc-item" data-ta="'+taId+'" data-expr="'+escHtml(ae2)+'" onclick="insertFromData(this,event)">'+escHtml(ae2)+'</div>'
             + '<div class="dc-item" data-ta="'+taId+'" data-expr="'+escHtml(ae3)+'" onclick="insertFromData(this,event)">'+escHtml(ae3)+'</div>';
    }
  }

  return '<div class="dc-picker">'
    + '<button class="dc-btn" onclick="toggleDc(\\\''+escJs(menuId)+'\\\',event)">⚡ Dynamic content ▾</button>'
    + '<div class="dc-menu" id="'+menuId+'">'+items+'</div>'
    + '</div>';
}

// ── Edit panel builder ────────────────────────────────────────────────────────
function buildEditPanel(name, action) {
  var s = sid(name);
  var prev = PREV_MAP[name] || [];
  var fieldsHtml = '';

  if (action.type === 'Compose') {
    var cval = typeof action.inputs === 'string' ? action.inputs
             : action.inputs !== undefined ? JSON.stringify(action.inputs, null, 2) : '';
    var ctaId = 'ef_'+s+'_inputs';
    fieldsHtml = '<div class="edit-field"><div class="edit-label">Value / Expression</div>'
      + '<textarea class="edit-expr" id="'+ctaId+'">'+escHtml(cval)+'</textarea>'
      + buildDynamicContent(ctaId, prev) + '</div>';

  } else if (action.type === 'InitializeVariable') {
    var iv = (action.inputs && action.inputs.variables && action.inputs.variables[0]) || {};
    var ivTypes = ['String','Integer','Float','Boolean','Array','Object'];
    var ivOpts = ivTypes.map(function(t) { return '<option value="'+t+'"'+(iv.type===t?' selected':'')+'>'+t+'</option>'; }).join('');
    var ivValId = 'ef_'+s+'_varvalue';
    fieldsHtml = '<div class="edit-field"><div class="edit-label">Variable name</div>'
      + '<input class="edit-text" id="ef_'+s+'_varname" value="'+escHtml(iv.name||'')+'"></div>'
      + '<div class="edit-field"><div class="edit-label">Type</div>'
      + '<select class="edit-select" style="width:auto" id="ef_'+s+'_vartype">'+ivOpts+'</select></div>'
      + '<div class="edit-field"><div class="edit-label">Initial value</div>'
      + '<textarea class="edit-expr" id="'+ivValId+'">'+escHtml(iv.value !== undefined ? String(iv.value) : '')+'</textarea>'
      + buildDynamicContent(ivValId, prev) + '</div>';

  } else if (action.type === 'SetVariable' || action.type === 'AppendToStringVariable') {
    var svValId = 'ef_'+s+'_varvalue';
    fieldsHtml = '<div class="edit-field"><div class="edit-label">Variable name</div>'
      + '<input class="edit-text" id="ef_'+s+'_varname" value="'+escHtml((action.inputs && action.inputs.name)||'')+'"></div>'
      + '<div class="edit-field"><div class="edit-label">Value</div>'
      + '<textarea class="edit-expr" id="'+svValId+'">'+escHtml(action.inputs && action.inputs.value !== undefined ? String(action.inputs.value) : '')+'</textarea>'
      + buildDynamicContent(svValId, prev) + '</div>';

  } else if (action.type === 'IncrementVariable') {
    fieldsHtml = '<div class="edit-field"><div class="edit-label">Variable name</div>'
      + '<input class="edit-text" id="ef_'+s+'_varname" value="'+escHtml((action.inputs && action.inputs.name)||'')+'"></div>'
      + '<div class="edit-field"><div class="edit-label">Value</div>'
      + '<input class="edit-text" id="ef_'+s+'_varvalue" style="width:100px" value="'+escHtml(action.inputs && action.inputs.value !== undefined ? String(action.inputs.value) : '1')+'"></div>';

  } else if (action.type === 'Foreach') {
    var feId = 'ef_'+s+'_foreach';
    fieldsHtml = '<div class="edit-field"><div class="edit-label">Array to iterate</div>'
      + '<textarea class="edit-expr" style="min-height:36px" id="'+feId+'">'+escHtml(action.foreach||'')+'</textarea>'
      + buildDynamicContent(feId, prev) + '</div>';

  } else if (action.type === 'If') {
    var condId = 'ef_'+s+'_expression';
    fieldsHtml = '<div class="edit-field"><div class="edit-label">Condition expression (JSON)</div>'
      + '<textarea class="edit-expr" style="min-height:100px" id="'+condId+'">'+escHtml(JSON.stringify(action.expression||{},null,2))+'</textarea>'
      + buildDynamicContent(condId, prev) + '</div>';

  } else if (action.type === 'Http') {
    var httpMethods = ['GET','POST','PUT','PATCH','DELETE'];
    var httpCurM = ((action.inputs && action.inputs.method) || 'GET').toUpperCase();
    var httpMethodOpts = httpMethods.map(function(m) { return '<option'+(httpCurM===m?' selected':'')+'>'+m+'</option>'; }).join('');
    var httpBodyRaw = action.inputs && action.inputs.body;
    var httpBodyStr = httpBodyRaw ? (typeof httpBodyRaw === 'string' ? httpBodyRaw : JSON.stringify(httpBodyRaw,null,2)) : '';
    var httpUriId = 'ef_'+s+'_uri';
    fieldsHtml = '<div class="edit-field"><div class="edit-label">Method</div>'
      + '<select class="edit-select" style="width:auto" id="ef_'+s+'_method">'+httpMethodOpts+'</select></div>'
      + '<div class="edit-field"><div class="edit-label">URI</div>'
      + '<textarea class="edit-expr" style="min-height:36px" id="'+httpUriId+'">'+escHtml((action.inputs && action.inputs.uri)||'')+'</textarea>'
      + buildDynamicContent(httpUriId, prev) + '</div>'
      + '<div class="edit-field"><div class="edit-label">Body (optional JSON)</div>'
      + '<textarea class="edit-expr" id="ef_'+s+'_body">'+escHtml(httpBodyStr)+'</textarea></div>';

  } else if (action.type === 'Response') {
    var respBodyRaw2 = action.inputs && action.inputs.body;
    var respBodyStr = respBodyRaw2 ? (typeof respBodyRaw2 === 'string' ? respBodyRaw2 : JSON.stringify(respBodyRaw2,null,2)) : '';
    var respBodyId = 'ef_'+s+'_body';
    fieldsHtml = '<div class="edit-field"><div class="edit-label">Status code</div>'
      + '<input class="edit-text" style="width:80px" id="ef_'+s+'_status" value="'+escHtml(String((action.inputs && action.inputs.statusCode)||200))+'"></div>'
      + '<div class="edit-field"><div class="edit-label">Body</div>'
      + '<textarea class="edit-expr" id="'+respBodyId+'">'+escHtml(respBodyStr)+'</textarea>'
      + buildDynamicContent(respBodyId, prev) + '</div>';

  } else if (action.type === 'Terminate') {
    var termStatuses = ['Succeeded','Failed','Cancelled'];
    var termCur = (action.inputs && action.inputs.runStatus) || 'Succeeded';
    var termOpts = termStatuses.map(function(st) { return '<option'+(termCur===st?' selected':'')+'>'+st+'</option>'; }).join('');
    fieldsHtml = '<div class="edit-field"><div class="edit-label">Run status</div>'
      + '<select class="edit-select" style="width:auto" id="ef_'+s+'_runstatus">'+termOpts+'</select></div>'
      + '<div class="edit-field"><div class="edit-label">Error message (optional)</div>'
      + '<textarea class="edit-expr" style="min-height:36px" id="ef_'+s+'_errmsg">'+escHtml((action.inputs && action.inputs.runError && action.inputs.runError.message)||'')+'</textarea></div>';

  } else {
    // ApiConnection / OpenApiConnection / generic
    var genId = 'ef_'+s+'_inputs_json';
    fieldsHtml = '<div class="edit-field"><div class="edit-label">Inputs (JSON)</div>'
      + '<textarea class="edit-expr" style="min-height:120px" id="'+genId+'">'+escHtml(JSON.stringify(action.inputs||{},null,2))+'</textarea>'
      + buildDynamicContent(genId, prev) + '</div>';
  }

  var safeName = escJs(name);
  return fieldsHtml
    + '<div class="edit-actions">'
    + '<button class="edit-save-btn" id="esave_'+s+'" onclick="doSaveAction(\\\''+safeName+'\\\')">💾 Save</button>'
    + '<button class="edit-cancel-btn" onclick="cancelEdit(\\\''+safeName+'\\\')">Cancel</button>'
    + '</div>';
}

// ── Edit interaction ──────────────────────────────────────────────────────────
function openEdit(name, event) {
  event.stopPropagation();
  var s = sid(name);
  var body = document.getElementById('cb_' + s);
  var ep   = document.getElementById('ep_' + s);
  var chev = document.getElementById('chev_' + s);
  if (body) body.style.display = 'none';
  if (chev) chev.style.display = 'none';
  if (ep)   ep.style.display   = 'block';
}

function cancelEdit(name) {
  var s = sid(name);
  var ep   = document.getElementById('ep_' + s);
  var chev = document.getElementById('chev_' + s);
  if (ep)   ep.style.display   = 'none';
  if (chev) chev.style.display = '';
}

function toggleDc(menuId, event) {
  event.stopPropagation();
  document.querySelectorAll('.dc-menu').forEach(function(m) {
    if (m.id !== menuId) m.style.display = 'none';
  });
  var menu = document.getElementById(menuId);
  if (!menu) return;
  if (menu.style.display === 'block') { menu.style.display = 'none'; return; }

  // Position the fixed menu relative to the button that was clicked
  var btn = event.currentTarget || event.target;
  var rect = btn.getBoundingClientRect();
  menu.style.top  = (rect.bottom + 4) + 'px';
  menu.style.left = rect.left + 'px';
  menu.style.display = 'block';

  // Nudge back into viewport if it overflows
  var mr = menu.getBoundingClientRect();
  if (mr.right > window.innerWidth - 8) {
    menu.style.left = Math.max(8, window.innerWidth - mr.width - 8) + 'px';
  }
  if (mr.bottom > window.innerHeight - 8) {
    menu.style.top = Math.max(8, rect.top - mr.height - 4) + 'px';
  }
}

function insertFromData(el, event) {
  event.stopPropagation();
  var taId = el.dataset.ta;
  var expr = el.dataset.expr;
  var ta = document.getElementById(taId);
  if (ta) {
    var start = ta.selectionStart || 0;
    var end   = ta.selectionEnd   || start;
    ta.value = ta.value.substring(0, start) + expr + ta.value.substring(end);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = start + expr.length;
  }
  var menu = el.closest('.dc-menu');
  if (menu) menu.style.display = 'none';
}

function doSaveAction(name) {
  var s = sid(name);
  var action = (DATA.actions && DATA.actions[name]) || findNestedAction(DATA.actions, name);
  if (!action) return;

  var patch = null;
  var el = function(id) { return document.getElementById(id) || {}; };

  if (action.type === 'Compose') {
    var raw = el('ef_'+s+'_inputs').value || '';
    var parsed = raw;
    try { parsed = JSON.parse(raw); } catch(e) {}
    patch = { inputs: parsed };

  } else if (action.type === 'InitializeVariable') {
    var vn = el('ef_'+s+'_varname').value || '';
    var vt = el('ef_'+s+'_vartype').value || 'String';
    var vv = el('ef_'+s+'_varvalue').value || '';
    if (vt !== 'String') { try { vv = JSON.parse(vv); } catch(e) {} }
    patch = { inputs: { variables: [{ name: vn, type: vt, value: vv }] } };

  } else if (action.type === 'SetVariable' || action.type === 'AppendToStringVariable') {
    var svn = el('ef_'+s+'_varname').value || '';
    var svv = el('ef_'+s+'_varvalue').value || '';
    try { svv = JSON.parse(svv); } catch(e) {}
    patch = { inputs: { name: svn, value: svv } };

  } else if (action.type === 'IncrementVariable') {
    var ivn = el('ef_'+s+'_varname').value || '';
    var ivv = el('ef_'+s+'_varvalue').value || '1';
    var ivNum = Number(ivv);
    patch = { inputs: { name: ivn, value: isNaN(ivNum) ? ivv : ivNum } };

  } else if (action.type === 'Foreach') {
    patch = { foreach: el('ef_'+s+'_foreach').value || '' };

  } else if (action.type === 'If') {
    var condStr = el('ef_'+s+'_expression').value || '{}';
    try { patch = { expression: JSON.parse(condStr) }; }
    catch(e) { alert('Invalid JSON for condition expression'); return; }

  } else if (action.type === 'Http') {
    var hm = el('ef_'+s+'_method').value || 'GET';
    var hu = el('ef_'+s+'_uri').value || '';
    var hbStr = el('ef_'+s+'_body').value || '';
    var hbParsed = hbStr;
    try { hbParsed = JSON.parse(hbStr); } catch(e) {}
    patch = { inputs: Object.assign({}, action.inputs || {}, { method: hm, uri: hu, body: hbParsed || undefined }) };

  } else if (action.type === 'Response') {
    var rs = parseInt(el('ef_'+s+'_status').value || '200', 10);
    var rbStr = el('ef_'+s+'_body').value || '';
    var rbParsed = rbStr;
    try { rbParsed = JSON.parse(rbStr); } catch(e) {}
    patch = { inputs: Object.assign({}, action.inputs || {}, { statusCode: rs, body: rbParsed }) };

  } else if (action.type === 'Terminate') {
    var tst = el('ef_'+s+'_runstatus').value || 'Succeeded';
    var terr = el('ef_'+s+'_errmsg').value || '';
    patch = { inputs: Object.assign({}, action.inputs || {}, {
      runStatus: tst,
      runError: terr ? { message: terr } : undefined
    }) };

  } else {
    var jsonStr = el('ef_'+s+'_inputs_json').value || '{}';
    try { patch = { inputs: JSON.parse(jsonStr) }; }
    catch(e) { alert('Invalid JSON'); return; }
  }

  if (!patch) return;
  var saveBtn = document.getElementById('esave_' + s);
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '⏳ Saving…'; }
  vscode.postMessage({ type: 'saveAction', actionName: name, patch: patch });
}

// ── Card / loop / condition renderers ─────────────────────────────────────────
function card(name, action) {
  var info = typeInfo(action.type);
  var s = sid(name);
  var editable = isEditableType(action.type);
  var safeName = escJs(name);
  var bodyHtml = buildStaticInputs(action);

  return '<div class="card" data-action="'+escHtml(name)+'">'
    + '<div class="card-head ' + info.cls + '" onclick="toggleCard(\\\''+s+'\\\')">'
    + '<span class="card-icon">'+info.icon+'</span>'
    + '<span class="card-name">'+fmt(name)+'</span>'
    + '<span class="card-type">'+info.label+'</span>'
    + (bodyHtml ? '<span class="card-chevron" id="chev_'+s+'">›</span>' : '')
    + (editable ? '<button class="edit-btn" onclick="openEdit(\\\''+safeName+'\\\',event)" title="Edit">✏</button>' : '')
    + '<button class="delete-btn" onclick="requestDelete(\\\''+safeName+'\\\',event)" title="Delete action">🗑</button>'
    + '</div>'
    + (bodyHtml ? '<div class="card-body" id="cb_'+s+'" style="display:none">'+bodyHtml+'</div>' : '<div class="card-body" id="cb_'+s+'" style="display:none"></div>')
    + (editable ? '<div class="edit-panel" id="ep_'+s+'" onclick="event.stopPropagation()">'+buildEditPanel(name, action)+'</div>' : '')
    + '</div>';
}

function foreach(name, action) {
  var fe = action.foreach || '';
  var innerId = nextId();
  var chevId  = nextId();
  var s = sid(name);
  var safeName = escJs(name);
  var inner = renderActions(action.actions || {});
  return '<div class="loop-box" data-action="'+escHtml(name)+'">'
    + '<div class="loop-header" onclick="toggleLoop(\\\''+innerId+'\\\',\\\''+chevId+'\\\')">'
    + '<span class="card-icon">🔄</span>'
    + '<span class="card-name">'+fmt(name)+'</span>'
    + '<span class="loop-badge" title="'+escHtml(fe)+'">'+escHtml(fe)+'</span>'
    + '<span class="card-chevron open" id="'+chevId+'">›</span>'
    + '<button class="edit-btn" onclick="openEdit(\\\''+safeName+'\\\',event)" title="Edit">✏</button>'
    + '<button class="delete-btn" onclick="requestDelete(\\\''+safeName+'\\\',event)" title="Delete loop">🗑</button>'
    + '</div>'
    + '<div class="edit-panel" id="ep_'+s+'" onclick="event.stopPropagation()">'+buildEditPanel(name, action)+'</div>'
    + '<div class="loop-inner" id="'+innerId+'">'
    + (inner || emptyBranchBtn(name, 'foreach'))
    + '</div>'
    + '</div>';
}

function scope(name, action) {
  var innerId = nextId();
  var chevId  = nextId();
  var safeName = escJs(name);
  var inner = renderActions(action.actions || {});
  return '<div class="scope-box" data-action="'+escHtml(name)+'">'
    + '<div class="scope-header" onclick="toggleLoop(\\\''+innerId+'\\\',\\\''+chevId+'\\\')">'
    + '<span class="card-icon">🗂️</span>'
    + '<span class="card-name">'+fmt(name)+'</span>'
    + '<span class="card-type">Scope</span>'
    + '<span class="card-chevron open" id="'+chevId+'">›</span>'
    + '<button class="delete-btn" onclick="requestDelete(\\\''+safeName+'\\\',event)" title="Delete scope">🗑</button>'
    + '</div>'
    + '<div class="scope-inner" id="'+innerId+'">'
    + (inner || emptyBranchBtn(name, 'scope'))
    + '</div>'
    + '</div>';
}

function condition(name, action) {
  var trueHtml  = renderActions(action.actions || {});
  var falseHtml = renderActions((action.else && action.else.actions) || {});
  var info = typeInfo('If');
  var s = sid(name);
  var safeName = escJs(name);
  return '<div class="condition-wrap">'
    + '<div class="card" data-action="'+escHtml(name)+'">'
    + '<div class="card-head ' + info.cls + '">'
    + '<span class="card-icon">'+info.icon+'</span>'
    + '<span class="card-name">'+fmt(name)+'</span>'
    + '<span class="card-type">Condition</span>'
    + '<button class="edit-btn" onclick="openEdit(\\\''+safeName+'\\\',event)" title="Edit condition">✏</button>'
    + '<button class="delete-btn" onclick="requestDelete(\\\''+safeName+'\\\',event)" title="Delete condition">🗑</button>'
    + '</div>'
    + '<div class="edit-panel" id="ep_'+s+'" onclick="event.stopPropagation()">'+buildEditPanel(name, action)+'</div>'
    + '</div>'
    + '<div class="condition-branches">'
    + '<div class="branch branch-yes"><div class="branch-label">✓ Yes</div><div class="branch-inner">'
    + (trueHtml  || emptyBranchBtn(name, 'yes')) + '</div></div>'
    + '<div class="branch branch-no"><div class="branch-label">✗ No</div><div class="branch-inner">'
    + (falseHtml || emptyBranchBtn(name, 'no')) + '</div></div>'
    + '</div></div>';
}

function insertArrow(predName, succName) {
  var predAttr = predName ? ' data-pred="'+escHtml(predName)+'"' : '';
  var succAttr = succName ? ' data-succ="'+escHtml(succName)+'"' : '';
  return '<div class="insert-row"'+predAttr+succAttr+'>'
    + '<div class="arrow"></div>'
    + '<button class="insert-btn" onclick="requestInsert(this,event)" title="Add action here">+</button>'
    + '<div class="arrow arrow-bottom"></div>'
    + '</div>';
}

function requestInsert(btn, event) {
  event.stopPropagation();
  var row = btn.closest('.insert-row');
  var pred = row ? (row.dataset.pred || null) : null;
  var succ = row ? (row.dataset.succ || null) : null;
  vscode.postMessage({ type: 'insertAction', predecessorName: pred, successorName: succ });
}

function requestDelete(name, event) {
  event.stopPropagation();
  vscode.postMessage({ type: 'deleteAction', actionName: name });
}

function requestInsertInBranch(el, event) {
  event.stopPropagation();
  vscode.postMessage({
    type: 'insertAction',
    predecessorName: null,
    successorName: null,
    parentAction: el.dataset.parent,
    branch: el.dataset.branch
  });
}

function emptyBranchBtn(parentName, branch) {
  return '<div class="branch-empty-btn" data-parent="'+escHtml(parentName)+'" data-branch="'+escHtml(branch)+'" onclick="requestInsertInBranch(this,event)">+ Add action</div>';
}

function renderActions(actions) {
  if (!actions || !Object.keys(actions).length) return '';
  var order = topoSort(actions);
  var parts = [];
  for (var i = 0; i < order.length; i++) {
    var name = order[i], a = actions[name];
    var prev = i > 0 ? order[i - 1] : null;
    parts.push(insertArrow(prev, name));
    if (a.type === 'Foreach') parts.push(foreach(name, a));
    else if (a.type === 'If') parts.push(condition(name, a));
    else if (a.type === 'Scope') parts.push(scope(name, a));
    else parts.push(card(name, a));
  }
  // trailing insert point (after last action)
  if (order.length > 0) { parts.push(insertArrow(order[order.length - 1], null)); }
  return parts.join('');
}

// ── Card toggle ───────────────────────────────────────────────────────────────
function toggleCard(s) {
  var ep = document.getElementById('ep_' + s);
  if (ep && ep.style.display !== 'none') return; // edit panel open — don't collapse
  var body = document.getElementById('cb_' + s);
  var chev = document.getElementById('chev_' + s);
  if (body) body.style.display = body.style.display === 'none' ? 'block' : 'none';
  if (chev) chev.classList.toggle('open');
}

function toggleLoop(innerId, chevId) {
  var el = document.getElementById(innerId);
  var ch = document.getElementById(chevId);
  if (el) el.classList.toggle('collapsed');
  if (ch) ch.classList.toggle('open');
}

// ── Search ────────────────────────────────────────────────────────────────────
function filterActions(query) {
  var q = query.toLowerCase().trim();
  document.querySelectorAll('.card').forEach(function(c) {
    var nm = ((c.querySelector('.card-name') || {}).textContent || '');
    c.style.opacity = (!q || nm.toLowerCase().includes(q)) ? '1' : '0.2';
  });
}

// ── Render ────────────────────────────────────────────────────────────────────
function render(data) {
  uid = 0;
  var name = data.name, triggers = data.triggers, actions = data.actions;
  PREV_MAP = buildPrevMap(actions);
  var count = Object.keys(actions).length;
  var trigEntry = Object.entries(triggers)[0] || ['manual',{type:'Request',kind:'Button'}];
  var tName = trigEntry[0], tDef = trigEntry[1];
  var tInfo = typeInfo(tDef.type);

  var triggerCard = '<div class="card">'
    + '<div class="card-head ' + tInfo.cls + '">'
    + '<span class="card-icon">'+tInfo.icon+'</span>'
    + '<span class="card-name">'+fmt(tName)+'</span>'
    + '<span class="card-type">'+escHtml(tDef.type+(tDef.kind?'/'+tDef.kind:''))+'</span>'
    + '</div></div>';

  var actionsHtml = renderActions(actions);
  var healthHtml  = renderHealthPanel(analyzeFlow(data));

  document.getElementById('root').innerHTML =
    '<div class="update-banner" id="banner">✓ Flow updated</div>'
    + '<div class="header">'
    + '<span class="header-icon">⚡</span>'
    + '<span class="header-title">'+escHtml(name)+'</span>'
    + '<span class="header-count">'+count+' actions</span>'
    + '</div>'
    + '<div class="toolbar">'
    + '<input class="search-input" type="text" placeholder="🔍 Search actions…" oninput="filterActions(this.value)">'
    + '<button class="run-btn" id="runBtn" onclick="runInVisualizer()">▶ Run</button>'
    + '</div>'
    + healthHtml
    + '<div class="canvas">'
    + triggerCard
    + actionsHtml
    + '</div>';
}

// ── Run in visualizer ─────────────────────────────────────────────────────────
var vscode = acquireVsCodeApi();
function runInVisualizer() {
  var btn = document.getElementById('runBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Running…'; }
  document.getElementById('runSummary') && document.getElementById('runSummary').remove();
  document.querySelectorAll('.card').forEach(function(c) {
    c.classList.remove('result-pass','result-fail','result-skip');
    var rb = c.querySelector('.result-badge'); if (rb) rb.remove();
  });
  vscode.postMessage({ type: 'runFlow' });
}

// ── Tab switcher ──────────────────────────────────────────────────────────────
function switchTab(btn, paneId) {
  var tabs = btn.closest('.card-tabs');
  tabs.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
  tabs.querySelectorAll('.tab-pane').forEach(function(p) { p.classList.remove('active'); });
  btn.classList.add('active');
  var pane = document.getElementById(paneId);
  if (pane) pane.classList.add('active');
  event.stopPropagation();
}

// ── PA-style output tables ────────────────────────────────────────────────────
function flattenObj(obj, prefix, depth) {
  if (depth === undefined) depth = 0;
  if (prefix === undefined) prefix = '';
  var rows = [];
  if (obj === null || obj === undefined) return rows;
  if (Array.isArray(obj)) {
    rows.push({ key: prefix + '.length', val: obj.length });
    if (obj.length && typeof obj[0] === 'object') {
      flattenObj(obj[0], prefix + '[0]', depth + 1).forEach(function(r) { rows.push(r); });
    }
    return rows;
  }
  if (typeof obj === 'object') {
    for (var k in obj) {
      var fullKey = prefix ? prefix + '.' + k : k;
      var v = obj[k];
      if (k.startsWith('@odata') || k.startsWith('{')) continue;
      if (depth < 2 && v && typeof v === 'object' && !Array.isArray(v)) {
        flattenObj(v, fullKey, depth + 1).forEach(function(r) { rows.push(r); });
      } else if (depth < 1 && Array.isArray(v)) {
        flattenObj(v, fullKey, depth + 1).forEach(function(r) { rows.push(r); });
      } else {
        rows.push({ key: fullKey, val: v });
      }
    }
    return rows;
  }
  rows.push({ key: prefix, val: obj });
  return rows;
}

function paTable(rows, actionName, isOutput) {
  if (!rows.length) return '<div class="pa-count">No data</div>';
  var html = '<table class="pa-table">';
  var shown = rows.slice(0, 20);
  shown.forEach(function(row) {
    var valStr = row.val === null ? 'null'
      : typeof row.val === 'object' ? JSON.stringify(row.val)
      : String(row.val);
    var expr = isOutput && actionName
      ? "@{body('" + actionName + "')" + (row.key.startsWith('body') ? row.key.slice(4) : "?['" + row.key + "']") + "}"
      : '';
    html += '<tr><td>' + escHtml(row.key) + '</td><td>'
      + escHtml(valStr.length > 80 ? valStr.slice(0,80) + '…' : valStr)
      + (expr ? '<button class="pa-copy-btn" onclick="navigator.clipboard.writeText(\\\''+escJs(expr)+'\\\');event.stopPropagation()">copy expr</button>' : '')
      + '</td></tr>';
  });
  html += '</table>';
  if (rows.length > 20) html += '<div class="pa-count">Showing 20 of ' + rows.length + ' fields</div>';
  return html;
}

function renderInputTable(rawInput, resolvedInput, actionName) {
  if (rawInput === undefined && resolvedInput === undefined) return '<div class="pa-count">—</div>';
  var src = resolvedInput || rawInput;
  var host   = src && src.host;
  var params = src && (src.parameters || (src.inputs && src.inputs.parameters));
  var simpleVal = typeof src !== 'object' ? src : null;
  if (simpleVal !== null && simpleVal !== undefined) {
    return '<table class="pa-table"><tr><td>value</td><td>' + escHtml(String(simpleVal)) + '</td></tr></table>';
  }
  var html = '';
  if (host)   { html += '<div class="pa-section-label">host</div>'       + paTable(flattenObj(host),   null, false); }
  if (params) { html += '<div class="pa-section-label">parameters</div>' + paTable(flattenObj(params), null, false); }
  if (!host && !params) {
    var flat = flattenObj(src);
    html += flat.length ? paTable(flat, null, false) : '<div class="pa-count">—</div>';
  }
  return html;
}

function applyResults(results) {
  var btn = document.getElementById('runBtn');
  if (btn) { btn.disabled = false; btn.textContent = '▶ Run'; }

  // Close any open edit panels so results are visible
  document.querySelectorAll('.edit-panel').forEach(function(ep) { ep.style.display = 'none'; });

  var statusMap = results.actions || {};

  document.querySelectorAll('[data-action]').forEach(function(el) {
    var actionName = el.getAttribute('data-action');
    var r = statusMap[actionName];
    if (!r) return;

    var isCard = el.classList.contains('card');
    var cls = r.status === 'Succeeded' ? 'result-pass' : r.status === 'Skipped' ? 'result-skip' : 'result-fail';
    if (isCard) el.classList.add(cls);

    var head = el.querySelector('.card-head, .loop-header, .scope-header');
    if (head && !head.querySelector('.result-badge')) {
      var badge = document.createElement('span');
      badge.className = 'result-badge';
      badge.textContent = r.status === 'Succeeded' ? '✅' : r.status === 'Skipped' ? '⊘' : '❌';
      head.appendChild(badge);
    }

    if (!isCard) return;

    var body = el.querySelector('.card-body');
    if (!body) { body = document.createElement('div'); body.className = 'card-body'; }
    var ep = el.querySelector('.edit-panel');
    if (ep && ep.parentNode === el) el.insertBefore(body, ep); else el.appendChild(body);
    body.style.display = 'block';

    var actionDef = DATA.actions && DATA.actions[actionName];
    var rawInput     = actionDef ? (actionDef.inputs !== undefined ? actionDef.inputs : actionDef.foreach) : undefined;
    var resolvedInput = r.inputs;
    var outputRows = r.output !== null && r.output !== undefined
      ? flattenObj(typeof r.output === 'object' ? r.output : { value: r.output })
      : [];

    var inId  = nextId();
    var outId = nextId();

    body.innerHTML =
      '<div class="card-tabs">'
      + '<div class="tab-bar">'
      + '<button class="tab-btn active" onclick="switchTab(this,\\\''+inId+'\\\')">Inputs</button>'
      + '<button class="tab-btn" onclick="switchTab(this,\\\''+outId+'\\\')">Outputs</button>'
      + '</div>'
      + '<div class="tab-pane active" id="'+inId+'">' + renderInputTable(rawInput, resolvedInput, actionName) + '</div>'
      + '<div class="tab-pane" id="'+outId+'">'
      + (r.error ? '<div class="pa-count" style="color:#e07070">❌ ' + escHtml(r.error) + '</div>' : '')
      + (outputRows.length ? paTable(outputRows, actionName, true) : '<div class="pa-count">—</div>')
      + '</div>'
      + '</div>';
  });

  document.getElementById('runSummary') && document.getElementById('runSummary').remove();
  var canvas = document.querySelector('.canvas');
  if (canvas) {
    var summary = document.createElement('div');
    summary.id = 'runSummary';
    summary.className = 'run-summary ' + (results.failed > 0 ? 'fail' : 'pass');
    summary.textContent = results.failed > 0
      ? '❌ ' + results.failed + ' failed · ' + results.passed + ' passed · ' + results.skipped + ' skipped'
      : '✅ All ' + results.passed + ' actions passed in ' + results.duration + 'ms';
    canvas.insertAdjacentElement('beforebegin', summary);
  }
}

// ── Close dynamic content menus on outside click ──────────────────────────────
document.addEventListener('click', function() {
  document.querySelectorAll('.dc-menu').forEach(function(m) { m.style.display = 'none'; });
});

// ── Message handler ───────────────────────────────────────────────────────────
window.addEventListener('message', function(event) {
  var msg = event.data;
  if (msg.type === 'update') {
    DATA = msg.data;
    render(DATA);
    var banner = document.getElementById('banner');
    if (banner) { banner.classList.add('show'); setTimeout(function() { banner.classList.remove('show'); }, 2000); }
  } else if (msg.type === 'runResults') {
    applyResults(msg.results);
  } else if (msg.type === 'runError') {
    var btn = document.getElementById('runBtn');
    if (btn) { btn.disabled = false; btn.textContent = '▶ Run'; }
    alert('Run failed: ' + msg.message);
  } else if (msg.type === 'saveOk') {
    cancelEdit(msg.actionName);
    // fs.watch will trigger re-render with updated data
  } else if (msg.type === 'saveError') {
    var s = sid(msg.actionName);
    var sb = document.getElementById('esave_' + s);
    if (sb) { sb.disabled = false; sb.textContent = '💾 Save'; }
    alert('Save failed: ' + msg.message);
  }
});
`;
