import * as vscode from 'vscode';

let channel: vscode.OutputChannel;

export function initLogger(ctx: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('Power Automate Toolkit');
  ctx.subscriptions.push(channel);
  info('Extension activated');
}

export function info(msg: string): void {
  channel?.appendLine(`[INFO]  ${timestamp()} ${msg}`);
}

export function error(msg: string, detail?: string): void {
  channel?.appendLine(`[ERROR] ${timestamp()} ${msg}`);
  if (detail) { channel?.appendLine(`        ${detail.replace(/\n/g, '\n        ')}`); }
  channel?.show(true); // reveal without stealing focus
}

export function command(cmd: string, stdout: string, stderr?: string): void {
  channel?.appendLine(`[CMD]   ${timestamp()} ${cmd}`);
  if (stdout.trim()) { channel?.appendLine(`[OUT]   ${stdout.trim().replace(/\n/g, '\n        ')}`); }
  if (stderr?.trim()) { channel?.appendLine(`[ERR]   ${stderr.trim().replace(/\n/g, '\n        ')}`); }
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}
