import * as vscode from 'vscode';
import { FlowRun, FlowRunDetail, FlowRunAction, statusIcon, timeAgo, durationLabel } from './paApi';

export function openFlowRunsPanel(
  context: vscode.ExtensionContext,
  flowName: string,
  runs: FlowRun[],
  onSelectRun: (runId: string) => Promise<FlowRunDetail>,
): void {
  const panel = vscode.window.createWebviewPanel(
    'dxt-flow-runs',
    `Runs: ${flowName}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const render = (runList: FlowRun[], detail?: FlowRunDetail) => {
    panel.webview.html = buildHtml(flowName, runList, detail);
  };

  render(runs);

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.command === 'selectRun') {
      panel.webview.html = buildHtml(flowName, runs, undefined, msg.runId, true);
      try {
        const detail = await onSelectRun(msg.runId);
        panel.webview.html = buildHtml(flowName, runs, detail, msg.runId);
      } catch (e: any) {
        panel.webview.html = buildHtml(flowName, runs, undefined, msg.runId, false, e.message);
      }
    }
  }, undefined, context.subscriptions);
}

function statusBadge(status: string): string {
  const colours: Record<string, string> = {
    Succeeded: '#2ea043',
    Failed:    '#da3633',
    Running:   '#d29922',
    Cancelled: '#6e7681',
  };
  const bg = colours[status] ?? '#6e7681';
  return `<span style="background:${bg};color:#fff;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:600">${statusIcon(status)} ${status}</span>`;
}

function actionRow(a: FlowRunAction): string {
  const dur = a.startTime && a.endTime ? durationLabel(a.startTime, a.endTime) : '—';
  const errHtml = a.error
    ? `<div style="margin-top:4px;padding:6px 10px;background:#3d1e1e;border-left:3px solid #da3633;border-radius:3px;font-size:11px;color:#f85149">
        <strong>${a.error.code ?? 'Error'}:</strong> ${escHtml(a.error.message)}
       </div>`
    : '';
  return `
    <tr style="border-top:1px solid #30363d">
      <td style="padding:7px 12px;font-size:12px;color:${a.status === 'Failed' ? '#f85149' : '#8b949e'}">${statusIcon(a.status)}</td>
      <td style="padding:7px 12px;font-size:12px;color:#e6edf3;font-family:monospace">${escHtml(a.displayName ?? a.name)}</td>
      <td style="padding:7px 12px;font-size:12px;color:#8b949e">${dur}</td>
      <td style="padding:7px 12px">${errHtml}</td>
    </tr>`;
}

function buildHtml(
  flowName: string,
  runs: FlowRun[],
  detail?: FlowRunDetail,
  selectedId?: string,
  loading = false,
  loadError?: string,
): string {
  const runRows = runs.map(r => {
    const dur = r.endTime ? durationLabel(r.startTime, r.endTime) : '…';
    const isSelected = r.id === selectedId;
    const rowBg = isSelected ? '#161b22' : 'transparent';
    return `
      <tr onclick="selectRun('${r.id}')" style="cursor:pointer;background:${rowBg};border-top:1px solid #21262d" onmouseover="this.style.background='#161b22'" onmouseout="this.style.background='${rowBg}'">
        <td style="padding:9px 14px;white-space:nowrap">${statusBadge(r.status)}</td>
        <td style="padding:9px 14px;color:#8b949e;font-size:12px;white-space:nowrap">${timeAgo(r.startTime)}</td>
        <td style="padding:9px 14px;color:#8b949e;font-size:12px;white-space:nowrap">${dur}</td>
        <td style="padding:9px 14px;color:#8b949e;font-size:12px">${escHtml(r.triggerName)}</td>
        ${r.error ? `<td style="padding:9px 14px;color:#f85149;font-size:11px">${escHtml(r.error.message)}</td>` : '<td></td>'}
      </tr>`;
  }).join('');

  const detailHtml = (() => {
    if (loading) {
      return `<div style="padding:24px;color:#8b949e;text-align:center">Loading run details…</div>`;
    }
    if (loadError) {
      return `<div style="padding:24px;color:#f85149">Failed to load details: ${escHtml(loadError)}</div>`;
    }
    if (!detail) {
      return `<div style="padding:24px;color:#8b949e;text-align:center">Click a run to see action-level details</div>`;
    }
    const failed  = detail.actions.filter(a => a.status === 'Failed');
    const skipped = detail.actions.filter(a => a.status === 'Skipped');
    const success = detail.actions.filter(a => a.status === 'Succeeded');

    const sections: string[] = [];
    if (failed.length) {
      sections.push(`
        <div style="margin-bottom:16px">
          <div style="font-size:12px;font-weight:600;color:#f85149;margin-bottom:8px">❌ Failed actions (${failed.length})</div>
          <table style="width:100%;border-collapse:collapse">${failed.map(actionRow).join('')}</table>
        </div>`);
    }
    if (success.length) {
      sections.push(`
        <div style="margin-bottom:16px">
          <details>
            <summary style="font-size:12px;font-weight:600;color:#3fb950;cursor:pointer;padding:4px 0">✅ Succeeded actions (${success.length})</summary>
            <table style="width:100%;border-collapse:collapse;margin-top:8px">${success.map(actionRow).join('')}</table>
          </details>
        </div>`);
    }
    if (skipped.length) {
      sections.push(`
        <div style="margin-bottom:16px">
          <details>
            <summary style="font-size:12px;font-weight:600;color:#6e7681;cursor:pointer;padding:4px 0">⏭ Skipped actions (${skipped.length})</summary>
            <table style="width:100%;border-collapse:collapse;margin-top:8px">${skipped.map(actionRow).join('')}</table>
          </details>
        </div>`);
    }
    return sections.join('') || '<div style="padding:24px;color:#8b949e">No action details available</div>';
  })();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0d1117; color: #e6edf3; display: flex; height: 100vh; overflow: hidden; }
    #left  { width: 52%; border-right: 1px solid #21262d; overflow-y: auto; display: flex; flex-direction: column; }
    #right { flex: 1; overflow-y: auto; padding: 16px; }
    h2 { font-size: 13px; font-weight: 600; color: #e6edf3; padding: 14px 16px; border-bottom: 1px solid #21262d; background: #0d1117; position: sticky; top: 0; z-index: 1; }
    table { width: 100%; border-collapse: collapse; }
    th { padding: 8px 14px; font-size: 11px; font-weight: 600; color: #8b949e; text-align: left; border-bottom: 1px solid #21262d; position: sticky; top: 40px; background: #0d1117; }
  </style>
</head>
<body>
  <div id="left">
    <h2>$(history) ${escHtml(flowName)} — last ${runs.length} runs</h2>
    <table>
      <thead><tr>
        <th>Status</th><th>When</th><th>Duration</th><th>Trigger</th><th>Error</th>
      </tr></thead>
      <tbody>${runRows}</tbody>
    </table>
  </div>
  <div id="right">
    <h2>Action details</h2>
    ${detailHtml}
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    function selectRun(id) { vscode.postMessage({ command: 'selectRun', runId: id }); }
  </script>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
