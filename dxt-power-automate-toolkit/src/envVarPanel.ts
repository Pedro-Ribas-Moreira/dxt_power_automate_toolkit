import * as vscode from 'vscode';
import { DvEnvVar, DV_ENV_VAR_TYPES, dvGetEnvVars, dvSetEnvVarValue, dvCreateEnvVar, dvDeleteEnvVar } from './dataverseApi';
import { info, error } from './log';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHtml(solutionName: string, envUrl: string, vars: DvEnvVar[]): string {
  const rows = vars.map(v => {
    const typeName = DV_ENV_VAR_TYPES[v.type] ?? `${v.type}`;
    const displayValue = v.currentValue ?? v.defaultvalue ?? '';
    const isSecret = v.type === 100000005;
    const shownValue = isSecret && displayValue ? '••••••••' : esc(displayValue);
    return `
      <tr data-id="${esc(v.environmentvariabledefinitionid)}" data-type="${v.type}" data-schema="${esc(v.schemaname)}">
        <td class="name" title="${esc(v.description || v.displayname)}">${esc(v.displayname)}<br><span class="schema">${esc(v.schemaname)}</span></td>
        <td><span class="badge type-${typeName.toLowerCase()}">${typeName}</span></td>
        <td class="val ${v.currentValue !== undefined ? 'overridden' : ''}">${shownValue || '<span class="empty">—</span>'}</td>
        <td class="val default">${esc(v.defaultvalue) || '<span class="empty">—</span>'}</td>
        <td class="actions">
          <button class="btn btn-edit" data-id="${esc(v.environmentvariabledefinitionid)}" data-name="${esc(v.displayname)}" data-value="${esc(v.currentValue ?? v.defaultvalue ?? '')}" data-type="${v.type}">Edit</button>
          <button class="btn btn-del" data-id="${esc(v.environmentvariabledefinitionid)}" data-name="${esc(v.displayname)}">Delete</button>
        </td>
      </tr>`;
  }).join('');

  const emptyRow = vars.length === 0
    ? `<tr><td colspan="5" class="empty-state">No environment variables in this solution yet.</td></tr>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Environment Variables — ${esc(solutionName)}</title>
<style>
  :root { --bg: #1e1e1e; --surface: #252526; --border: #3c3c3c; --text: #cccccc; --muted: #888; --accent: #0078d4; --green: #4ec9b0; --yellow: #dcdcaa; --red: #f48771; --orange: #ce9178; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font: 13px/1.5 var(--vscode-font-family, 'Segoe UI', sans-serif); padding: 16px; }
  h1 { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
  .meta { color: var(--muted); font-size: 11px; margin-bottom: 16px; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
  .btn { padding: 4px 10px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; border-radius: 3px; font-size: 12px; }
  .btn:hover { background: #2a2d2e; }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn-primary:hover { background: #106ebe; }
  .btn-del { color: var(--red); border-color: transparent; background: transparent; }
  .btn-del:hover { background: rgba(244,135,113,0.1); }
  .btn-edit { color: var(--accent); border-color: transparent; background: transparent; }
  .btn-edit:hover { background: rgba(0,120,212,0.1); }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); color: var(--muted); font-weight: 400; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
  td { padding: 7px 8px; border-bottom: 1px solid #2a2a2a; vertical-align: top; }
  tr:hover td { background: rgba(255,255,255,0.03); }
  .schema { color: var(--muted); font-size: 11px; font-family: monospace; }
  .val { font-family: monospace; font-size: 12px; color: var(--green); word-break: break-all; }
  .val.default { color: var(--muted); }
  .overridden { color: var(--yellow); }
  .empty { color: var(--muted); font-family: inherit; }
  .empty-state { text-align: center; padding: 32px; color: var(--muted); }
  .badge { padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; letter-spacing: .04em; }
  .type-string  { background: rgba(78,201,176,.15); color: var(--green); }
  .type-number  { background: rgba(0,120,212,.15); color: #75bfff; }
  .type-boolean { background: rgba(220,220,170,.15); color: var(--yellow); }
  .type-json    { background: rgba(206,145,120,.15); color: var(--orange); }
  .type-datasource { background: rgba(255,255,255,.08); color: var(--muted); }
  .type-secret  { background: rgba(244,135,113,.15); color: var(--red); }
  /* Modal */
  .overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 10; justify-content: center; align-items: center; }
  .overlay.active { display: flex; }
  .modal { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 20px; width: 480px; max-width: 90vw; }
  .modal h2 { font-size: 14px; margin-bottom: 14px; }
  .field { margin-bottom: 12px; }
  .field label { display: block; font-size: 11px; color: var(--muted); margin-bottom: 4px; text-transform: uppercase; letter-spacing: .05em; }
  .field input, .field select, .field textarea { width: 100%; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 6px 8px; border-radius: 3px; font-size: 13px; font-family: inherit; }
  .field textarea { height: 80px; resize: vertical; font-family: monospace; }
  .field input:focus, .field select:focus, .field textarea:focus { outline: none; border-color: var(--accent); }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
</style>
</head>
<body>
<h1>Environment Variables — ${esc(solutionName)}</h1>
<div class="meta">${esc(envUrl)} · ${vars.length} variable${vars.length !== 1 ? 's' : ''}</div>
<div class="toolbar">
  <button class="btn btn-primary" id="btnNew">+ New Variable</button>
  <button class="btn" id="btnRefresh">↺ Refresh</button>
</div>
<table>
  <thead><tr><th>Name</th><th>Type</th><th>Current Value</th><th>Default</th><th></th></tr></thead>
  <tbody>${rows}${emptyRow}</tbody>
</table>

<!-- Edit modal -->
<div class="overlay" id="overlay">
  <div class="modal">
    <h2 id="modalTitle">Edit Variable</h2>
    <div id="createFields" style="display:none">
      <div class="field"><label>Schema Name (prefix_name)</label><input id="fSchema" placeholder="dta_MySetting" /></div>
      <div class="field"><label>Display Name</label><input id="fDisplay" /></div>
      <div class="field"><label>Type</label>
        <select id="fType">
          <option value="100000000">String</option>
          <option value="100000001">Number</option>
          <option value="100000002">Boolean</option>
          <option value="100000003">JSON</option>
          <option value="100000005">Secret</option>
        </select>
      </div>
      <div class="field"><label>Description (optional)</label><input id="fDesc" /></div>
      <div class="field"><label>Default Value</label><textarea id="fDefault"></textarea></div>
    </div>
    <div id="editFields">
      <div class="field"><label id="editLabel">Current Value</label><textarea id="fValue"></textarea></div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="btnCancel">Cancel</button>
      <button class="btn btn-primary" id="btnSave">Save</button>
    </div>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  let mode = 'edit';
  let editId = '';

  document.getElementById('btnNew').addEventListener('click', () => {
    mode = 'create';
    document.getElementById('modalTitle').textContent = 'New Environment Variable';
    document.getElementById('createFields').style.display = '';
    document.getElementById('editFields').style.display = 'none';
    document.getElementById('fSchema').value = '';
    document.getElementById('fDisplay').value = '';
    document.getElementById('fDesc').value = '';
    document.getElementById('fDefault').value = '';
    document.getElementById('overlay').classList.add('active');
  });

  document.getElementById('btnRefresh').addEventListener('click', () => {
    vscode.postMessage({ command: 'refresh' });
  });

  document.getElementById('btnCancel').addEventListener('click', () => {
    document.getElementById('overlay').classList.remove('active');
  });

  document.getElementById('btnSave').addEventListener('click', () => {
    if (mode === 'edit') {
      vscode.postMessage({ command: 'setValue', id: editId, value: document.getElementById('fValue').value });
    } else {
      vscode.postMessage({
        command: 'createVar',
        schemaname: document.getElementById('fSchema').value.trim(),
        displayname: document.getElementById('fDisplay').value.trim(),
        description: document.getElementById('fDesc').value.trim(),
        type: parseInt(document.getElementById('fType').value, 10),
        defaultvalue: document.getElementById('fDefault').value,
      });
    }
    document.getElementById('overlay').classList.remove('active');
  });

  document.querySelectorAll('.btn-edit').forEach(btn => {
    btn.addEventListener('click', e => {
      const b = e.currentTarget;
      mode = 'edit';
      editId = b.dataset.id;
      document.getElementById('modalTitle').textContent = 'Edit: ' + b.dataset.name;
      document.getElementById('createFields').style.display = 'none';
      document.getElementById('editFields').style.display = '';
      document.getElementById('editLabel').textContent = parseInt(b.dataset.type) === 100000005 ? 'Secret Value' : 'Current Value';
      document.getElementById('fValue').value = b.dataset.value;
      document.getElementById('overlay').classList.add('active');
    });
  });

  document.querySelectorAll('.btn-del').forEach(btn => {
    btn.addEventListener('click', e => {
      const b = e.currentTarget;
      if (confirm('Delete "' + b.dataset.name + '"? This cannot be undone.')) {
        vscode.postMessage({ command: 'deleteVar', id: b.dataset.id, name: b.dataset.name });
      }
    });
  });

  window.addEventListener('message', ev => {
    if (ev.data.command === 'reload') { location.reload(); }
  });
</script>
</body>
</html>`;
}

export async function openEnvVarPanel(
  context: vscode.ExtensionContext,
  solutionName: string,
  solutionUniqueName: string,
  envUrl: string
): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    'dxt-envvars',
    `Env Vars — ${solutionName}`,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  async function reload() {
    try {
      const vars = await dvGetEnvVars(envUrl, solutionUniqueName);
      panel.webview.html = buildHtml(solutionName, envUrl, vars);
    } catch (e: any) {
      error('Env Vars: failed to load', e.message);
      panel.webview.html = `<body style="padding:16px;color:#f48771;font-family:sans-serif">
        <b>Failed to load environment variables</b><br>${e.message}
        <br><br>Make sure IT has added <b>Dynamics CRM → user_impersonation</b> to the app registration.</body>`;
    }
  }

  await reload();

  panel.webview.onDidReceiveMessage(async msg => {
    try {
      switch (msg.command) {
        case 'refresh':
          await reload();
          break;
        case 'setValue': {
          info(`Env Vars: updating value for ${msg.id}`);
          await dvSetEnvVarValue(envUrl, msg.id, msg.value);
          vscode.window.showInformationMessage('Environment variable value updated.');
          await reload();
          break;
        }
        case 'createVar': {
          if (!msg.schemaname || !msg.displayname) {
            vscode.window.showWarningMessage('Schema name and display name are required.');
            return;
          }
          info(`Env Vars: creating ${msg.schemaname}`);
          await dvCreateEnvVar(envUrl, {
            schemaname: msg.schemaname,
            displayname: msg.displayname,
            description: msg.description,
            type: msg.type,
            defaultvalue: msg.defaultvalue,
          });
          vscode.window.showInformationMessage(`Environment variable "${msg.displayname}" created.`);
          await reload();
          break;
        }
        case 'deleteVar': {
          info(`Env Vars: deleting ${msg.id}`);
          await dvDeleteEnvVar(envUrl, msg.id);
          vscode.window.showInformationMessage(`"${msg.name}" deleted.`);
          await reload();
          break;
        }
      }
    } catch (e: any) {
      error('Env Vars panel error', e.message);
      vscode.window.showErrorMessage(`Operation failed: ${e.message}`);
    }
  }, undefined, context.subscriptions);
}
