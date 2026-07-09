// Asana task detail panel — header, notes, comment thread, add-comment box.
// Follows the envVarPanel.ts pattern: inline HTML, reload() re-renders, and
// command-tagged messages from the webview.
import * as vscode from 'vscode';
import { AsanaStory, AsanaTask, addComment, fetchTask, fetchTaskStories, invalidateCache } from './asanaApi';
import { error } from './log';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) { return 'just now'; }
  if (mins < 60) { return `${mins}m ago`; }
  const hours = Math.round(mins / 60);
  if (hours < 24) { return `${hours}h ago`; }
  const days = Math.round(hours / 24);
  if (days < 30) { return `${days}d ago`; }
  return new Date(iso).toLocaleDateString();
}

function buildHtml(task: AsanaTask, stories: AsanaStory[]): string {
  const comments = stories.filter(s => s.type === 'comment');
  const commentRows = comments.map(c => `
    <div class="comment">
      <div class="comment-head"><strong>${esc(c.created_by || 'Unknown')}</strong><span class="when">${esc(relTime(c.created_at))}</span></div>
      <div class="comment-body">${esc(c.text)}</div>
    </div>`).join('');

  const urgencyBadge: Record<string, string> = {
    'overdue': '<span class="badge overdue">Overdue</span>',
    'this-week': '<span class="badge week">Due this week</span>',
    'upcoming': '<span class="badge upcoming">Upcoming</span>',
    'no-date': '',
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>${esc(task.name)}</title>
<style>
  :root { --bg: #1e1e1e; --surface: #252526; --border: #3c3c3c; --text: #cccccc; --muted: #888; --accent: #0078d4; --red: #f48771; --yellow: #dcdcaa; --green: #4ec9b0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font: 13px/1.5 var(--vscode-font-family, 'Segoe UI', sans-serif); padding: 16px; max-width: 760px; }
  h1 { font-size: 16px; font-weight: 600; margin-bottom: 6px; }
  .meta { color: var(--muted); font-size: 12px; margin-bottom: 4px; display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .badge { padding: 1px 8px; border-radius: 9px; font-size: 10px; font-weight: 600; }
  .badge.overdue { background: rgba(244,135,113,.18); color: var(--red); }
  .badge.week { background: rgba(220,220,170,.15); color: var(--yellow); }
  .badge.upcoming { background: rgba(78,201,176,.14); color: var(--green); }
  .badge.done { background: rgba(78,201,176,.14); color: var(--green); }
  .toolbar { display: flex; gap: 8px; margin: 12px 0 16px; }
  .btn { padding: 4px 12px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; border-radius: 3px; font-size: 12px; }
  .btn:hover { background: #2a2d2e; }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn-primary:hover { background: #106ebe; }
  .btn:disabled { opacity: .5; cursor: default; }
  .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 18px 0 8px; }
  .notes { background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: 10px 12px; white-space: pre-wrap; word-break: break-word; }
  .notes.empty { color: var(--muted); font-style: italic; }
  .comment { border-left: 2px solid var(--border); padding: 6px 12px; margin-bottom: 10px; }
  .comment-head { display: flex; gap: 10px; align-items: baseline; margin-bottom: 2px; }
  .when { color: var(--muted); font-size: 11px; }
  .comment-body { white-space: pre-wrap; word-break: break-word; }
  .no-comments { color: var(--muted); font-style: italic; }
  textarea { width: 100%; background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 8px 10px; border-radius: 4px; font: inherit; min-height: 70px; resize: vertical; }
  textarea:focus { outline: none; border-color: var(--accent); }
  .comment-actions { display: flex; justify-content: flex-end; margin-top: 6px; }
</style>
</head>
<body>
<h1>${esc(task.name)}</h1>
<div class="meta">
  ${task.completed ? '<span class="badge done">Completed</span>' : urgencyBadge[task.urgency] ?? ''}
  <span>${task.due_on ? `Due ${esc(task.due_on)}` : 'No due date'}</span>
  <span>${task.assignee ? esc(task.assignee.name) : 'Unassigned'}</span>
  ${task.projects.length ? `<span>${esc(task.projects.join(' · '))}</span>` : ''}
</div>
<div class="toolbar">
  <button class="btn" id="btnOpen">Open in Asana ↗</button>
  <button class="btn" id="btnRefresh">↺ Refresh</button>
</div>

<div class="section-title">Description</div>
<div class="notes ${task.notes ? '' : 'empty'}">${task.notes ? esc(task.notes) : 'No description'}</div>

<div class="section-title">Comments (${comments.length})</div>
${commentRows || '<div class="no-comments">No comments yet.</div>'}

<div class="section-title">Add comment</div>
<textarea id="commentText" placeholder="Write a comment…"></textarea>
<div class="comment-actions"><button class="btn btn-primary" id="btnComment">Comment</button></div>

<script>
  const vscode = acquireVsCodeApi();
  document.getElementById('btnOpen').addEventListener('click', () => vscode.postMessage({ command: 'openInBrowser' }));
  document.getElementById('btnRefresh').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
  document.getElementById('btnComment').addEventListener('click', () => {
    const ta = document.getElementById('commentText');
    const text = ta.value.trim();
    if (!text) { return; }
    document.getElementById('btnComment').disabled = true;
    vscode.postMessage({ command: 'addComment', text });
  });
</script>
</body>
</html>`;
}

export async function openAsanaTaskPanel(context: vscode.ExtensionContext, gid: string): Promise<void> {
  let task: AsanaTask;
  try {
    task = await fetchTask(gid);
  } catch (e: any) {
    vscode.window.showErrorMessage(`Could not load Asana task: ${e.message}`);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'dxt-asana-task',
    task.name.length > 40 ? `${task.name.slice(0, 40)}…` : task.name,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  async function reload(): Promise<void> {
    try {
      const [freshTask, stories] = await Promise.all([fetchTask(gid), fetchTaskStories(gid)]);
      panel.webview.html = buildHtml(freshTask, stories);
    } catch (e: any) {
      panel.webview.html = `<html><body style="font-family:sans-serif;padding:20px;color:#f88;">Failed to load task: ${esc(e.message)}</body></html>`;
    }
  }

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.command === 'openInBrowser') {
      void vscode.env.openExternal(vscode.Uri.parse(task.permalink_url));
    } else if (msg.command === 'refresh') {
      invalidateCache();
      await reload();
    } else if (msg.command === 'addComment') {
      try {
        await addComment(gid, msg.text);
        await reload();
      } catch (e: any) {
        error('Asana comment failed', e.message);
        vscode.window.showErrorMessage(`Comment failed: ${e.message}`);
        await reload();
      }
    }
  });

  await reload();
}
