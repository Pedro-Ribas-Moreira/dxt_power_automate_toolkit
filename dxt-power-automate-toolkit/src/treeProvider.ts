import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PacEnvironment, PacSolution, listEnvironments, listSolutions, listLocalFlows } from './pacCli';

export type NodeKind = 'environment' | 'solution' | 'solution-local' | 'flow' | 'message';

export interface NodePayload {
  environment?: PacEnvironment;
  solution?: PacSolution;
  envUrl?: string;
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
        // cloud-only — orange nudges the user to export it
        return new vscode.ThemeIcon('package', new vscode.ThemeColor('charts.orange'));
      case 'solution-local':
        // exported locally — green means ready
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
    try {
      const solutions = await listSolutions(env.EnvironmentUrl);
      if (!solutions.length) { return [infoNode('No solutions found')]; }
      return solutions.map(sol => {
        const localDir = this.solutionsRoot ? path.join(this.solutionsRoot, sol.SolutionUniqueName) : undefined;
        const isLocal = localDir ? fs.existsSync(localDir) : false;
        const kind: NodeKind = isLocal ? 'solution-local' : 'solution';
        const node = new PowerAutomateNode(
          sol.FriendlyName,
          kind,
          isLocal ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
          { solution: sol, envUrl: env.EnvironmentUrl, solutionLocalDir: localDir ?? '' }
        );
        node.description = isLocal ? `v${sol.VersionNumber} ✓` : `v${sol.VersionNumber}`;
        node.tooltip = sol.SolutionUniqueName;
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
    return flows.map(name => {
      const flowPath = path.join(dir, 'Workflows', `${name}.json`);
      const node = new PowerAutomateNode(name, 'flow', vscode.TreeItemCollapsibleState.None, { flowPath });
      node.tooltip = flowPath;
      return node;
    });
  }

  getSolutionsRoot(): string | undefined { return this.solutionsRoot; }
}

function infoNode(label: string): PowerAutomateNode {
  return new PowerAutomateNode(label, 'message', vscode.TreeItemCollapsibleState.None);
}

function errorNode(label: string, detail: string): PowerAutomateNode {
  const node = new PowerAutomateNode(`$(error) ${label}`, 'message', vscode.TreeItemCollapsibleState.None);
  node.tooltip = detail;
  return node;
}
