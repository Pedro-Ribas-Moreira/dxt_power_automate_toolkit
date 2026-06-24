import * as vscode from 'vscode';
import { Library, LibraryConnector, LibraryOperation, LibraryExample, BotPattern, BotPatternKind } from './libraryBuilder';

export type LibNodeKind = 'connector' | 'operation' | 'example' | 'botpattern-category' | 'botpattern' | 'info';

export interface LibNodePayload {
  connectorKey?: string;
  operationKey?: string;
  example?: LibraryExample;
  connector?: LibraryConnector;
  operation?: LibraryOperation;
  botPattern?: BotPattern;
  botPatternKind?: BotPatternKind;
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
    if (el.kind === 'botpattern-category') { return this.botPatternNodes(el); }
    return [];
  }

  private rootNodes(): LibraryNode[] {
    if (!this.library) {
      return [info('No library built yet — click ↺ to scan your solutions')];
    }
    const { connectors, flowsScanned, solutionsScanned, topicsScanned, botPatterns, lastUpdated } = this.library;
    const hasConnectors = Object.keys(connectors).length > 0;
    const hasBotPatterns = botPatterns && botPatterns.length > 0;

    if (!hasConnectors && !hasBotPatterns) {
      return [info('No actions found — export some solutions first')];
    }

    const date = new Date(lastUpdated).toLocaleString();
    const q = this.filter;

    const topicsLabel = topicsScanned ? ` · ${topicsScanned} topics` : '';
    const headerLabel = q
      ? `🔍 "${q}"`
      : `${flowsScanned} flows · ${solutionsScanned} solutions${topicsLabel} · ${date}`;
    const header = info(headerLabel);

    // ── Connector nodes ──────────────────────────────────────────────────────
    const connEntries = Object.entries(connectors)
      .filter(([, conn]) => {
        if (!q) { return true; }
        if (conn.displayName.toLowerCase().includes(q)) { return true; }
        return Object.values(conn.operations).some(op => op.displayName.toLowerCase().includes(q));
      })
      .sort(([, a], [, b]) => b.count - a.count);

    const connNodes = connEntries.map(([key, conn]) => {
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

    // ── Bot pattern category nodes ───────────────────────────────────────────
    const botNodes: LibraryNode[] = [];
    if (hasBotPatterns) {
      const categories: { kind: BotPatternKind; label: string; icon: string }[] = [
        { kind: 'AdaptiveCard', label: 'Adaptive Cards', icon: 'layout' },
        { kind: 'FlowCall',     label: 'Flow Calls',     icon: 'zap' },
        { kind: 'Question',     label: 'Questions',      icon: 'question' },
        { kind: 'Message',      label: 'Messages',       icon: 'comment' },
      ];
      for (const cat of categories) {
        const matching = botPatterns.filter(p =>
          p.kind === cat.kind &&
          (!q || p.displayName.toLowerCase().includes(q) || p.topic.toLowerCase().includes(q) || p.solution.toLowerCase().includes(q))
        );
        if (!matching.length) { continue; }
        const catNode = new LibraryNode(
          cat.label,
          'botpattern-category',
          vscode.TreeItemCollapsibleState.Collapsed,
          { botPatternKind: cat.kind }
        );
        catNode.description = `${matching.length} pattern${matching.length !== 1 ? 's' : ''}`;
        catNode.iconPath = new vscode.ThemeIcon(cat.icon);
        botNodes.push(catNode);
      }
    }

    if (!connNodes.length && !botNodes.length) {
      return [info(`No results for "${this.filter}"`)];
    }

    const sections: LibraryNode[] = [header];
    if (connNodes.length) { sections.push(...connNodes); }
    if (botNodes.length) {
      const botHeader = info(`🤖 Bot Patterns`);
      sections.push(botHeader, ...botNodes);
    }
    return sections;
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

  private botPatternNodes(catNode: LibraryNode): LibraryNode[] {
    const lib = this.library;
    if (!lib?.botPatterns) { return []; }
    const kind = catNode.payload?.botPatternKind;
    const q = this.filter;

    return lib.botPatterns
      .filter(p => p.kind === kind &&
        (!q || p.displayName.toLowerCase().includes(q) || p.topic.toLowerCase().includes(q) || p.solution.toLowerCase().includes(q))
      )
      .map(p => {
        const node = new LibraryNode(
          p.displayName,
          'botpattern',
          vscode.TreeItemCollapsibleState.None,
          { botPattern: p }
        );
        node.description = `${p.solution} / ${p.topic}`;
        node.iconPath = new vscode.ThemeIcon('symbol-snippet');
        node.tooltip = `Click copy to paste this pattern`;
        return node;
      });
  }
}

function info(label: string): LibraryNode {
  const node = new LibraryNode(label, 'info', vscode.TreeItemCollapsibleState.None);
  node.iconPath = new vscode.ThemeIcon('info');
  return node;
}
