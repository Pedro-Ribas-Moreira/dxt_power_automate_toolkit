// Shared infrastructure for webview panels whose UI code is ported from
// dxt-bridge (plain JS/CSS files under media/, loaded via asWebviewUri).
//
// Message protocol: the webview's fetch shim (media/vscode-shim.js) turns each
// fetch('/pac/...') into postMessage({id, cmd, payload}); the host replies
// {id, ok, data | error}. Handlers are registered under the ORIGINAL dxt-bridge
// URL path so ported code runs without a mapping table.
import * as vscode from 'vscode';
import * as crypto from 'crypto';

export type BridgeHandler = (payload: any) => Promise<any> | any;

export class WebviewBridge {
  private handlers = new Map<string, BridgeHandler>();
  private subscription: vscode.Disposable;

  constructor(private readonly webview: vscode.Webview) {
    this.subscription = webview.onDidReceiveMessage(async (msg: any) => {
      if (!msg || msg.id === undefined || typeof msg.cmd !== 'string') { return; }
      const handler = this.handlers.get(msg.cmd);
      if (!handler) {
        void this.webview.postMessage({ id: msg.id, ok: false, error: `No handler for ${msg.cmd}` });
        return;
      }
      try {
        const data = await handler(msg.payload ?? {});
        void this.webview.postMessage({ id: msg.id, ok: true, data });
      } catch (e: any) {
        void this.webview.postMessage({ id: msg.id, ok: false, error: e?.message ?? String(e) });
      }
    });
  }

  /** Register a handler for a command (keyed by dxt-bridge URL path, e.g. '/pac/save-action'). */
  on(cmd: string, handler: BridgeHandler): this {
    this.handlers.set(cmd, handler);
    return this;
  }

  /** Host-initiated notification (no id): the webview's bridge.onPush(type) receives it. */
  push(type: string, extra?: Record<string, unknown>): void {
    void this.webview.postMessage({ type, ...(extra ?? {}) });
  }

  dispose(): void {
    this.subscription.dispose();
  }
}

export interface WebviewHtmlOptions {
  title: string;
  bodyHtml: string;
  /** File names under media/, loaded in order. */
  styles: string[];
  /** File names under media/, loaded in order (vscode-shim.js must come first). */
  scripts: string[];
  bodyAttrs?: Record<string, string>;
}

function escAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function getNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

// CSP note: the ported dxt-bridge UI drives interactions through inline
// onclick="…" attributes generated in JS templates, which a nonce-only
// script-src would block (and a nonce makes 'unsafe-inline' ignored). So we
// keep 'unsafe-inline' for event handlers but load all script/style FILES from
// media/ only (localResourceRoots). Follow-up: migrate to event delegation,
// then tighten to a nonce'd CSP.
export function buildWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  opts: WebviewHtmlOptions
): string {
  const mediaUri = (f: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', f)).toString();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'unsafe-inline'`,
  ].join('; ');
  const styleTags = opts.styles
    .map(f => `<link rel="stylesheet" href="${mediaUri(f)}">`)
    .join('\n  ');
  const scriptTags = opts.scripts
    .map(f => `<script src="${mediaUri(f)}"></script>`)
    .join('\n  ');
  const bodyAttrs = Object.entries(opts.bodyAttrs ?? {})
    .map(([k, v]) => ` ${k}="${escAttr(v)}"`)
    .join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escAttr(opts.title)}</title>
  ${styleTags}
</head>
<body${bodyAttrs}>
${opts.bodyHtml}
  ${scriptTags}
</body>
</html>`;
}

export function createBridgedPanel(
  viewType: string,
  title: string,
  extensionUri: vscode.Uri,
  column: vscode.ViewColumn = vscode.ViewColumn.Beside
): { panel: vscode.WebviewPanel; bridge: WebviewBridge } {
  const panel = vscode.window.createWebviewPanel(viewType, title, column, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
  });
  const bridge = new WebviewBridge(panel.webview);
  panel.onDidDispose(() => bridge.dispose());
  return { panel, bridge };
}
