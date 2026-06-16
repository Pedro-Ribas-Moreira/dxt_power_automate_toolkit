import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PacEnvironment, PacSolution, listEnvironments, listSolutions, listLocalFlows } from './pacCli';

export type NodeKind = 'environment' | 'solution' | 'solution-local' | 'flow' | 'message';

export interface NodePayload {
  environment?: PacEnvironment;
  solution?: PacSolution;
  envUrl?: string;
  envId?: string;          // EnvironmentIdentifier.Id — used in maker portal URLs
  solutionLocalDir?: string;
  flowPath?: string;
}

export class PowerAutomateNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly kind: NodeKind,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly payload?: NodePayload
  ) {
    super(label, collapsibleState);
    this.contextValue = kind;
    this.iconPath = this.resolveIcon();
  }

  private resolveIcon(): vscode.ThemeIcon {
    switch (this.kind) {
      case 'environment':
        return new vscode.ThemeIcon('server', new vscode.ThemeColor('charts.blue'));
      case 'solution':
        return new vscode.ThemeIcon('package', new vscode.ThemeColor('charts.orange'));
      case 'solution-local':
        return new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.green'));
      case 'flow':
        return new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('charts.purple'));
      default:
        return new vscode.ThemeIcon('info');
    }
  }
}

export class PowerAutomateTreeProvider implements vscode.TreeDataProvider<PowerAutomateNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _onEnvSelected = new vscode.EventEmitter<PacEnvironment>();
  readonly onEnvSelected = this._onEnvSelected.event;

  constructor(private readonly solutionsRoot: string | undefined) {}

  refresh(): void { this._onDidChangeTreeData.fire(); }

  getTreeItem(element: PowerAutomateNode): vscode.TreeItem { return element; }

  async getChildren(element?: PowerAutomateNode): Promise<PowerAutomateNode[]> {
    if (!element) { return this.fetchEnvironments(); }
    if (element.kind === 'environment') { return this.fetchSolutions(element); }
    if (element.kind === 'solution-local') { return this.fetchLocalFlows(element); }
    return [];
  }

  private async fetchEnvironments(): Promise<PowerAutomateNode[]> {
    try {
      const envs = await listEnvironments();
      if (!envs.length) { return [infoNode('No environments found')]; }
      return envs.map(env => {
        const node = new PowerAutomateNode(
          env.FriendlyName,
          'environment',
          vscode.TreeItemCollapsibleState.Collapsed,
          { environment: env }
        );
        node.description = env.EnvironmentIdentifier?.IsDefault ? 'default' : env.Geo;
        node.tooltip = env.EnvironmentUrl;
        return node;
      });
    } catch (e: any) {
      return [errorNode('pac env list failed', e.message)];
    }
  }

  private async fetchSolutions(envNode: PowerAutomateNode): Promise<PowerAutomateNode[]> {
    const env = envNode.payload?.environment;
    if (!env) { return []; }

    // Notify status bar of the active environment
    this._onEnvSelected.fire(env);

    try {
      const solutions = await listSolutions(env.EnvironmentUrl);
      if (!solutions.length) { return [infoNode('No solutions found')]; }
      return solutions.map(sol => {
        const localDir = this.solutionsRoot ? path.join(this.solutionsRoot, sol.SolutionUniqueName) : undefined;
        const isLocal = localDir ? fs.existsSync(localDir) : false;
        const hasChanges = isLocal && localDir
          ? hasUnimportedChanges(localDir, this.solutionsRoot!, sol.SolutionUniqueName)
          : false;
        const kind: NodeKind = isLocal ? 'solution-local' : 'solution';

        let flowCount = 0;
        if (isLocal && localDir) {
          const wfDir = path.join(localDir, 'Workflows');
          try {
            if (fs.existsSync(wfDir)) {
              flowCount = fs.readdirSync(wfDir).filter(f => f.endsWith('.json')).length;
            }
          } catch { /* ignore */ }
        }

        const node = new PowerAutomateNode(
          sol.FriendlyName,
          kind,
          isLocal ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
          { solution: sol, envUrl: env.EnvironmentUrl, envId: env.EnvironmentIdentifier?.Id, solutionLocalDir: localDir ?? '' }
        );
        node.description = isLocal
          ? `v${sol.VersionNumber} ✓${hasChanges ? ' ●' : ''}${flowCount ? `  ${flowCount} flows` : ''}`
          : `v${sol.VersionNumber}`;
        node.tooltip = hasChanges
          ? `${sol.SolutionUniqueName}\n⚠ Local changes not yet imported`
          : sol.SolutionUniqueName;
        return node;
      });
    } catch (e: any) {
      return [errorNode('pac solution list failed', e.message)];
    }
  }

  private fetchLocalFlows(solNode: PowerAutomateNode): PowerAutomateNode[] {
    const dir = solNode.payload?.solutionLocalDir;
    if (!dir) { return []; }
    const flows = listLocalFlows(dir);
    if (!flows.length) { return [infoNode('No flows in Workflows/ folder')]; }
    const envId = solNode.payload?.envId;
    const envUrl = solNode.payload?.envUrl;
    return flows.map(rawName => {
      const flowPath = path.join(dir, 'Workflows', `${rawName}.json`);
      // Try to read the human-readable display name from the flow JSON
      let displayName = rawName.replace(/-[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/i, '');
      try {
        const json = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
        const name: unknown = json?.properties?.displayName;
        if (typeof name === 'string' && name.trim()) { displayName = name.trim(); }
      } catch { /* fall back to filename */ }
      const node = new PowerAutomateNode(displayName, 'flow', vscode.TreeItemCollapsibleState.None,
        { flowPath, solutionLocalDir: solNode.payload?.solutionLocalDir, envId, envUrl });
      node.tooltip = rawName;
      return node;
    });
  }

  getSolutionsRoot(): string | undefined { return this.solutionsRoot; }
}

// #5 — returns true if any Workflow file is newer than the last export/import zip
function hasUnimportedChanges(solutionDir: string, solutionsRoot: string, solutionName: string): boolean {
  try {
    const zips = [
      path.join(solutionsRoot, `${solutionName}_packed.zip`),
      path.join(solutionsRoot, `${solutionName}.zip`),
    ];
    let baseline = 0;
    for (const z of zips) {
      if (fs.existsSync(z)) { baseline = Math.max(baseline, fs.statSync(z).mtimeMs); }
    }
    if (baseline === 0) { return false; }

    const workflowsDir = path.join(solutionDir, 'Workflows');
    if (!fs.existsSync(workflowsDir)) { return false; }
    return fs.readdirSync(workflowsDir).some(f =>
      fs.statSync(path.join(workflowsDir, f)).mtimeMs > baseline
    );
  } catch { return false; }
}

function infoNode(label: string): PowerAutomateNode {
  return new PowerAutomateNode(label, 'message', vscode.TreeItemCollapsibleState.None);
}

function errorNode(label: string, detail: string): PowerAutomateNode {
  const node = new PowerAutomateNode(`$(error) ${label}`, 'message', vscode.TreeItemCollapsibleState.None);
  node.tooltip = detail;
  return node;
}
