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

  // #1 — Handle "Run in Visualizer" from the webview
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
    }
  });

  panel.onDidDispose(() => {
    if (debounce) { clearTimeout(debounce); }
    watcher.close();
  });
}

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
const DATA = ${safeData};
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

/* ── Connector arrow ── */
.arrow {
  width: 2px;
  height: 28px;
  background: var(--vscode-editorWidget-border, #454545);
  position: relative;
  flex-shrink: 0;
}
.arrow::after {
  content: '';
  position: absolute;
  bottom: -5px;
  left: 50%;
  transform: translateX(-50%);
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-top: 6px solid var(--vscode-editorWidget-border, #454545);
}

/* ── Action card ── */
.card {
  width: 100%;
  border-radius: 6px;
  background: var(--vscode-editorWidget-background, #252526);
  border: 1px solid var(--vscode-editorWidget-border, #454545);
  overflow: hidden;
  cursor: pointer;
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
  padding: 7px 13px 9px 49px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  border-top: 1px solid var(--vscode-editorWidget-border, #454545);
  display: none;
  word-break: break-word;
}
.card-body.open { display: block; }

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
.branch-empty {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  text-align: center;
  padding: 10px 6px;
  font-style: italic;
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
.tab-pane { display: none; padding: 8px 13px 10px 13px; }
.tab-pane.active { display: block; }
.tab-pre {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
  max-height: 120px;
  overflow-y: auto;
  color: var(--vscode-editor-foreground);
  line-height: 1.5;
}

/* ── Run results overlay ── */
.card.result-pass { border-left-color: #4EC94E !important; }
.card.result-fail { border-left-color: #E07070 !important; }
.card.result-skip { border-left-color: #E0C04E !important; }
.result-badge {
  font-size: 14px;
  margin-left: 4px;
}
.result-output {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin-top: 4px;
  font-family: var(--vscode-editor-font-family, monospace);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 80px;
  overflow: auto;
}
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

/* ── Type colour palette ── */
.t-trigger    { border-color: #742774; }
.t-compose    { border-color: #E06C00; }
.t-foreach    { border-color: #00A4EF; }
.t-condition  { border-color: #0078D4; }
.t-variable   { border-color: #9B4F96; }
.t-api        { border-color: #0078D4; }
.t-http       { border-color: #085B99; }
.t-parsejson  { border-color: #00BCD4; }
.t-response   { border-color: #107C10; }
.t-other      { border-color: #5a5a5a; }
`;

// ─── Client-side JS ───────────────────────────────────────────────────────────

const JS = `
function typeInfo(t) {
  const m = {
    Request:               { icon:'⚡', cls:'t-trigger',   label:'Trigger'             },
    Recurrence:            { icon:'🕐', cls:'t-trigger',   label:'Scheduled trigger'   },
    Compose:               { icon:'📝', cls:'t-compose',   label:'Compose'             },
    Foreach:               { icon:'🔄', cls:'t-foreach',   label:'Apply to each'       },
    If:                    { icon:'🔀', cls:'t-condition', label:'Condition'           },
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

function fmt(name) { return name.replace(/_/g,' '); }

function detail(action) {
  const { type, inputs, foreach: fe } = action;
  if (type === 'Compose' && inputs !== undefined) {
    const v = typeof inputs === 'string' ? inputs : JSON.stringify(inputs);
    return 'Input: ' + (v.length > 120 ? v.slice(0,120)+'…' : v);
  }
  if ((type === 'InitializeVariable' || type === 'SetVariable') && inputs) {
    const v = inputs.variables?.[0];
    if (v) return v.name + ' (' + v.type + ')' + (v.value !== undefined ? ' = ' + JSON.stringify(v.value) : '');
    return inputs.name ? inputs.name + (inputs.value !== undefined ? ' = ' + JSON.stringify(inputs.value) : '') : null;
  }
  if (type === 'AppendToStringVariable' && inputs) return inputs.name + ' += ' + JSON.stringify(inputs.value);
  if (type === 'Foreach' && fe) return 'Each item in: ' + fe;
  if (type === 'ApiConnection' && inputs) {
    const p = inputs.path || ''; const m = (inputs.method || 'GET').toUpperCase();
    return (m + ' ' + p).slice(0, 100);
  }
  if (type === 'Http' && inputs) return ((inputs.method||'GET').toUpperCase() + ' ' + (inputs.uri||'')).slice(0,100);
  if (type === 'Response' && inputs) return 'Status: ' + (inputs.statusCode || 200);
  if (type === 'Terminate' && inputs) return 'Status: ' + (inputs.runStatus || '—') + (inputs.runError?.message ? ' — ' + inputs.runError.message : '');
  return null;
}

function topoSort(actions) {
  const visited = new Set(), order = [];
  function visit(n) {
    if (visited.has(n)) return;
    visited.add(n);
    for (const d of Object.keys(actions[n]?.runAfter || {})) if (actions[d]) visit(d);
    order.push(n);
  }
  for (const n of Object.keys(actions)) visit(n);
  return order;
}

let uid = 0;
function nextId() { return 'n' + (++uid); }

function card(name, action) {
  const info = typeInfo(action.type);
  const d = detail(action);
  const bid = nextId();
  const cid = nextId();
  return '<div class="card" data-action="'+escHtml(name)+'" onclick="toggle(\\''+bid+'\\',\\''+cid+'\\')">'
    + '<div class="card-head ' + info.cls + '">'
    + '<span class="card-icon">'+info.icon+'</span>'
    + '<span class="card-name">'+fmt(name)+'</span>'
    + '<span class="card-type">'+info.label+'</span>'
    + (d ? '<span class="card-chevron" id="'+cid+'">›</span>' : '')
    + '</div>'
    + (d ? '<div class="card-body" id="'+bid+'">'+escHtml(d)+'</div>' : '')
    + '</div>';
}

function renderActions(actions) {
  if (!actions || !Object.keys(actions).length) return '';
  const order = topoSort(actions);
  const parts = [];
  for (let i=0; i<order.length; i++) {
    if (i>0) parts.push('<div class="arrow"></div>');
    const name = order[i], a = actions[name];
    if (a.type === 'Foreach') parts.push(foreach(name, a));
    else if (a.type === 'If') parts.push(condition(name, a));
    else parts.push(card(name, a));
  }
  return parts.join('');
}

function foreach(name, action) {
  const fe = action.foreach || '';
  const innerId = nextId();
  const chevId = nextId();
  const inner = renderActions(action.actions || {});
  return '<div class="loop-box" data-action="'+escHtml(name)+'">'
    + '<div class="loop-header" onclick="toggleLoop(\\''+innerId+'\\',\\''+chevId+'\\')">'
    + '<span class="card-icon">🔄</span>'
    + '<span class="card-name">'+fmt(name)+'</span>'
    + '<span class="loop-badge">'+escHtml(fe)+'</span>'
    + '<span class="card-chevron open" id="'+chevId+'">›</span>'
    + '</div>'
    + '<div class="loop-inner" id="'+innerId+'">'
    + (inner || '<div class="branch-empty">No actions inside loop</div>')
    + '</div>'
    + '</div>';
}

function condition(name, action) {
  const trueHtml = renderActions(action.actions || {});
  const falseHtml = renderActions(action.else?.actions || {});
  const info = typeInfo('If');
  return '<div class="condition-wrap">'
    + '<div class="card"><div class="card-head ' + info.cls + '">'
    + '<span class="card-icon">'+info.icon+'</span>'
    + '<span class="card-name">'+fmt(name)+'</span>'
    + '<span class="card-type">Condition</span>'
    + '</div></div>'
    + '<div class="condition-branches">'
    + '<div class="branch branch-yes"><div class="branch-label">✓ Yes</div><div class="branch-inner">'
    + (trueHtml || '<div class="branch-empty">No actions</div>') + '</div></div>'
    + '<div class="branch branch-no"><div class="branch-label">✗ No</div><div class="branch-inner">'
    + (falseHtml || '<div class="branch-empty">No actions</div>') + '</div></div>'
    + '</div></div>';
}

function toggle(bodyId, chevId) {
  const b = document.getElementById(bodyId);
  const c = document.getElementById(chevId);
  if (b) b.classList.toggle('open');
  if (c) c.classList.toggle('open');
}

function toggleLoop(innerId, chevId) {
  const el = document.getElementById(innerId);
  const ch = document.getElementById(chevId);
  if (el) el.classList.toggle('collapsed');
  if (ch) ch.classList.toggle('open');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function render(data) {
  uid = 0;
  const { name, triggers, actions } = data;
  const count = Object.keys(actions).length;
  const [tName, tDef] = Object.entries(triggers)[0] || ['manual',{type:'Request',kind:'Button'}];
  const tInfo = typeInfo(tDef.type);

  const triggerCard = '<div class="card">'
    + '<div class="card-head ' + tInfo.cls + '">'
    + '<span class="card-icon">'+tInfo.icon+'</span>'
    + '<span class="card-name">'+fmt(tName)+'</span>'
    + '<span class="card-type">'+escHtml(tDef.type+(tDef.kind?'/'+tDef.kind:''))+'</span>'
    + '</div></div>';

  const actionsHtml = renderActions(actions);

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
    + '<div class="canvas">'
    + triggerCard
    + (actionsHtml ? '<div class="arrow"></div>' + actionsHtml : '')
    + '</div>';
}

// #6 — Search / filter
function filterActions(query) {
  const q = query.toLowerCase().trim();
  document.querySelectorAll('.card').forEach(function(card) {
    const name = (card.querySelector('.card-name') || {}).textContent || '';
    card.style.opacity = (!q || name.toLowerCase().includes(q)) ? '1' : '0.2';
  });
}

// #1 — Run in visualizer
const vscode = acquireVsCodeApi();
function runInVisualizer() {
  const btn = document.getElementById('runBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Running…'; }
  document.getElementById('runSummary')?.remove();
  document.querySelectorAll('.card').forEach(function(c) {
    c.classList.remove('result-pass','result-fail','result-skip');
    c.querySelector('.result-badge')?.remove();
    c.querySelector('.result-output')?.remove();
  });
  vscode.postMessage({ type: 'runFlow' });
}

function switchTab(btn, paneId) {
  const card = btn.closest('.card-tabs').parentElement;
  card.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
  card.querySelectorAll('.tab-pane').forEach(function(p) { p.classList.remove('active'); });
  btn.classList.add('active');
  const pane = document.getElementById(paneId);
  if (pane) pane.classList.add('active');
  event.stopPropagation();
}

function applyResults(results) {
  const btn = document.getElementById('runBtn');
  if (btn) { btn.disabled = false; btn.textContent = '▶ Run'; }

  const statusMap = results.actions || {};

  // Process every element that has a data-action attribute (cards + loop-boxes)
  document.querySelectorAll('[data-action]').forEach(function(el) {
    const actionName = el.getAttribute('data-action');
    const r = statusMap[actionName];
    if (!r) return;

    const isCard = el.classList.contains('card');
    const isLoop = el.classList.contains('loop-box');

    // Status colour
    const cls = r.status === 'Succeeded' ? 'result-pass' : r.status === 'Skipped' ? 'result-skip' : 'result-fail';
    if (isCard) el.classList.add(cls);

    // Badge on head
    const head = el.querySelector('.card-head, .loop-header');
    if (head && !head.querySelector('.result-badge')) {
      const badge = document.createElement('span');
      badge.className = 'result-badge';
      badge.textContent = r.status === 'Succeeded' ? '✅' : r.status === 'Skipped' ? '⊘' : '❌';
      head.appendChild(badge);
    }

    if (!isCard) return; // loops just get the badge, no tabs

    // Get or create card body
    let body = el.querySelector('.card-body');
    if (!body) {
      body = document.createElement('div');
      body.className = 'card-body';
      el.appendChild(body);
    }
    body.classList.add('open');

    // Get input from original flow data
    const actionDef = DATA.actions?.[actionName];
    const rawInput = actionDef?.inputs !== undefined ? actionDef.inputs : actionDef?.foreach;
    const inputStr = rawInput !== undefined
      ? (typeof rawInput === 'object' ? JSON.stringify(rawInput, null, 2) : String(rawInput))
      : '—';

    // Get output from run results
    const rawOutput = r.output;
    const outputStr = rawOutput !== undefined && rawOutput !== null
      ? (typeof rawOutput === 'object' ? JSON.stringify(rawOutput, null, 2) : String(rawOutput))
      : (r.error ? '❌ ' + r.error : '(no output)');

    const inId = nextId();
    const outId = nextId();

    body.innerHTML =
      '<div class="card-tabs">'
      + '<div class="tab-bar">'
      + '<button class="tab-btn active" onclick="switchTab(this,\\''+inId+'\\')">Input</button>'
      + '<button class="tab-btn" onclick="switchTab(this,\\''+outId+'\\')">Output</button>'
      + '</div>'
      + '<div class="tab-pane active" id="'+inId+'"><pre class="tab-pre">'+escHtml(inputStr)+'</pre></div>'
      + '<div class="tab-pane" id="'+outId+'"><pre class="tab-pre">'+escHtml(outputStr)+'</pre></div>'
      + '</div>';
  });

  // Summary banner
  document.getElementById('runSummary')?.remove();
  const canvas = document.querySelector('.canvas');
  if (canvas) {
    const summary = document.createElement('div');
    summary.id = 'runSummary';
    summary.className = 'run-summary ' + (results.failed > 0 ? 'fail' : 'pass');
    summary.textContent = results.failed > 0
      ? '❌ ' + results.failed + ' failed · ' + results.passed + ' passed · ' + results.skipped + ' skipped'
      : '✅ All ' + results.passed + ' actions passed in ' + results.duration + 'ms';
    canvas.insertAdjacentElement('beforebegin', summary);
  }
}

// Listen for messages from the extension
window.addEventListener('message', function(event) {
  const msg = event.data;
  if (msg.type === 'update') {
    render(msg.data);
    const banner = document.getElementById('banner');
    if (banner) {
      banner.classList.add('show');
      setTimeout(function() { banner.classList.remove('show'); }, 2000);
    }
  } else if (msg.type === 'runResults') {
    applyResults(msg.results);
  } else if (msg.type === 'runError') {
    const btn = document.getElementById('runBtn');
    if (btn) { btn.disabled = false; btn.textContent = '▶ Run'; }
    alert('Run failed: ' + msg.message);
  }
});
`;
