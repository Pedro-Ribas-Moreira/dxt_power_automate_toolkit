// "Asana Tasks" sidebar tree: DT-project sections at the root, open tasks
// (assigned to me or unassigned, mirroring dxt-bridge's default filter) under
// each. Data comes from asanaApi's TTL caches, so expanding costs at most one
// API call per section.
import * as vscode from 'vscode';
import { AsanaTask, fetchProjectSections, fetchSectionTasks, getAsanaPat, invalidateCache } from './asanaApi';

export type AsanaNodeKind = 'section' | 'asana-task' | 'message';

export class AsanaNode extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly kind: AsanaNodeKind,
    public readonly sectionGid?: string,
    public readonly task?: AsanaTask
  ) {
    super(label, collapsibleState);
    this.contextValue = kind;
  }
}

function taskNode(task: AsanaTask): AsanaNode {
  const node = new AsanaNode(task.name, vscode.TreeItemCollapsibleState.None, 'asana-task', undefined, task);
  const due = task.due_on ? `due ${task.due_on}` : 'no due date';
  const who = task.assignee?.name ?? 'unassigned';
  node.description = `${due} · ${who}`;
  node.tooltip = new vscode.MarkdownString(
    `**${task.name}**\n\n${due} · ${who}${task.notes ? `\n\n${task.notes}` : ''}\n\n[Open in Asana](${task.permalink_url})`
  );
  node.iconPath = task.urgency === 'overdue'
    ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.red'))
    : new vscode.ThemeIcon('circle-large-outline');
  node.command = {
    command: 'dxt-power-automate-toolkit.asanaOpenTask',
    title: 'Open Asana Task',
    arguments: [task.gid],
  };
  return node;
}

export class AsanaTreeProvider implements vscode.TreeDataProvider<AsanaNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<AsanaNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    invalidateCache();
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: AsanaNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: AsanaNode): Promise<AsanaNode[]> {
    if (!(await getAsanaPat())) { return []; } // welcome view shows the connect button

    try {
      if (!element) {
        const sections = await fetchProjectSections();
        return sections.map(s => {
          const node = new AsanaNode(s.name, vscode.TreeItemCollapsibleState.Collapsed, 'section', s.gid);
          node.iconPath = new vscode.ThemeIcon('list-unordered');
          return node;
        });
      }
      if (element.kind === 'section' && element.sectionGid) {
        const tasks = await fetchSectionTasks(element.sectionGid, 'me_or_unassigned');
        if (!tasks.length) {
          const empty = new AsanaNode('No open tasks', vscode.TreeItemCollapsibleState.None, 'message');
          empty.iconPath = new vscode.ThemeIcon('check');
          return [empty];
        }
        return tasks.map(taskNode);
      }
      return [];
    } catch (e: any) {
      const err = new AsanaNode(`Asana error: ${e.message}`, vscode.TreeItemCollapsibleState.None, 'message');
      err.iconPath = new vscode.ThemeIcon('error');
      return [err];
    }
  }
}
