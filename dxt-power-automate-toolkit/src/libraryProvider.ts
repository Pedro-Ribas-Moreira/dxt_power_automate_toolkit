import * as vscode from 'vscode';
import { Library, LibraryConnector, LibraryOperation, LibraryExample } from './libraryBuilder';

export type LibNodeKind = 'connector' | 'operation' | 'example' | 'info';

export interface LibNodePayload {
  connectorKey?: string;
  operationKey?: string;
  example?: LibraryExample;
  connector?: LibraryConnector;
  operation?: LibraryOperation;
}

export class LibraryNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly kind: LibNodeKind,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly payload?: LibNodePayload
  ) {
    super(label, collapsibleState);
    this.contextValue = kind;
  }
}

export class LibraryProvider implements vscode.TreeDataProvider<LibraryNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private library: Library | null = null;
  private filter: string = '';

  setLibrary(lib: Library | null): void {
    this.library = lib;
    this._onDidChangeTreeData.fire();
  }

  setFilter(query: string): void {
    this.filter = query.toLowerCase().trim();
    this._onDidChangeTreeData.fire();
  }

  getFilter(): string { return this.filter; }

  getTreeItem(el: LibraryNode): vscode.TreeItem { return el; }

  getChildren(el?: LibraryNode): LibraryNode[] {
    if (!el) { return this.rootNodes(); }
    if (el.kind === 'connector') { return this.operationNodes(el); }
    if (el.kind === 'operation') { return this.exampleNodes(el); }
    return [];
  }

  private rootNodes(): LibraryNode[] {
    if (!this.library) {
      return [info('No library built yet — click ↺ to scan your solutions')];
    }
    const { connectors, flowsScanned, solutionsScanned, lastUpdated } = this.library;
    if (!Object.keys(connectors).length) {
      return [info('No actions found — export some solutions first')];
    }

    const date = new Date(lastUpdated).toLocaleString();
    const q = this.filter;

    // Filter: keep connectors that match by name, or have at least one matching operation
    const entries = Object.entries(connectors)
      .filter(([, conn]) => {
        if (!q) { return true; }
        if (conn.displayName.toLowerCase().includes(q)) { return true; }
        return Object.values(conn.operations).some(op => op.displayName.toLowerCase().includes(q));
      })
      .sort(([, a], [, b]) => b.count - a.count);

    if (!entries.length) {
      return [info(`No results for "${this.filter}"`)];
    }

    const headerLabel = q
      ? `🔍 "${q}" — ${entries.length} connector${entries.length !== 1 ? 's' : ''}`
      : `${flowsScanned} flows · ${solutionsScanned} solutions · ${date}`;
    const header = info(headerLabel);

    const nodes = entries.map(([key, conn]) => {
      const node = new LibraryNode(
        conn.displayName,
        'connector',
        vscode.TreeItemCollapsibleState.Collapsed,
        { connectorKey: key, connector: conn }
      );
      node.description = `${conn.count} uses`;
      node.iconPath = new vscode.ThemeIcon(conn.icon.replace('$(', '').replace(')', ''));
      return node;
    });

    return [header, ...nodes];
  }

  private operationNodes(connNode: LibraryNode): LibraryNode[] {
    const conn = connNode.payload?.connector;
    if (!conn) { return []; }
    const q = this.filter;

    return Object.entries(conn.operations)
      .filter(([, op]) => !q || op.displayName.toLowerCase().includes(q)
                              || conn.displayName.toLowerCase().includes(q))
      .sort(([, a], [, b]) => b.count - a.count)
      .map(([oKey, op]) => {
        const node = new LibraryNode(
          op.displayName,
          'operation',
          vscode.TreeItemCollapsibleState.Collapsed,
          { operationKey: oKey, operation: op, connectorKey: connNode.payload?.connectorKey }
        );
        node.description = `${op.count}×`;
        node.iconPath = new vscode.ThemeIcon('symbol-method');
        node.command = undefined;
        return node;
      });
  }

  private exampleNodes(opNode: LibraryNode): LibraryNode[] {
    const op = opNode.payload?.operation;
    if (!op) { return []; }

    return op.examples.map(ex => {
      const node = new LibraryNode(
        `${ex.solution} / ${ex.flow}`,
        'example',
        vscode.TreeItemCollapsibleState.None,
        { example: ex }
      );
      node.description = ex.actionName;
      node.iconPath = new vscode.ThemeIcon('file-code');
      node.tooltip = `Click copy to use this snippet in your flow`;
      return node;
    });
  }
}

function info(label: string): LibraryNode {
  const node = new LibraryNode(label, 'info', vscode.TreeItemCollapsibleState.None);
  node.iconPath = new vscode.ThemeIcon('info');
  return node;
}
