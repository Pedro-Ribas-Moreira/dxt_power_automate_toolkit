import * as vscode from 'vscode';
import * as path from 'path';
import { PowerAutomateTreeProvider, PowerAutomateNode } from './treeProvider';
import { exportAndUnpack, packAndImport, initPacPath } from './pacCli';
import { initLogger, info, error } from './log';

export async function activate(context: vscode.ExtensionContext) {
  initLogger(context);
  await initPacPath(context);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  const solutionsRoot = workspaceRoot ? path.join(workspaceRoot, 'solutions') : undefined;
  const provider = new PowerAutomateTreeProvider(solutionsRoot);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dxt-power-automate.treeView', provider),

    vscode.commands.registerCommand('dxt-power-automate-toolkit.refresh', () => provider.refresh()),

    vscode.commands.registerCommand('dxt-power-automate-toolkit.exportSolution', async (node: PowerAutomateNode) => {
      const { solution, envUrl } = node.payload ?? {};
      if (!solution || !envUrl) { return; }
      if (!solutionsRoot) {
        vscode.window.showWarningMessage('Open a workspace folder before exporting solutions.');
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Exporting ${solution.FriendlyName}…`, cancellable: false },
        async (progress) => {
          progress.report({ message: 'See Output panel for live progress' });
          try {
            info(`Exporting solution: ${solution.SolutionUniqueName} from ${envUrl}`);
            await exportAndUnpack(envUrl, solution.SolutionUniqueName, solutionsRoot);
            info(`Export complete: ${solution.SolutionUniqueName}`);
            vscode.window.showInformationMessage(`✅ "${solution.FriendlyName}" exported successfully.`);
            provider.refresh();
          } catch (e: any) {
            error(`Export failed: ${solution.SolutionUniqueName}`, e.message);
            vscode.window.showErrorMessage(`Export failed: ${e.message}`);
          }
        }
      );
    }),

    vscode.commands.registerCommand('dxt-power-automate-toolkit.importSolution', async (node: PowerAutomateNode) => {
      const { solution, envUrl, solutionLocalDir } = node.payload ?? {};
      if (!solution || !envUrl || !solutionLocalDir) { return; }
      const envHost = new URL(envUrl).hostname;
      const confirm = await vscode.window.showWarningMessage(
        `Import "${solution.FriendlyName}" to ${envHost}?`,
        { modal: true },
        'Import'
      );
      if (confirm !== 'Import') { return; }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Importing ${solution.FriendlyName}…`, cancellable: false },
        async (progress) => {
          progress.report({ message: 'Packing… See Output panel for live progress' });
          try {
            info(`Importing solution: ${solution.SolutionUniqueName} to ${envUrl}`);
            await packAndImport(envUrl, solution.SolutionUniqueName, solutionLocalDir);
            info(`Import complete: ${solution.SolutionUniqueName}`);
            vscode.window.showInformationMessage(`✅ "${solution.FriendlyName}" imported successfully.`);
          } catch (e: any) {
            error(`Import failed: ${solution.SolutionUniqueName}`, e.message);
            vscode.window.showErrorMessage(`❌ Import failed: ${e.message}`);
          }
        }
      );
    }),

    vscode.commands.registerCommand('dxt-power-automate-toolkit.runFlow', async (node: PowerAutomateNode) => {
      const { flowPath } = node.payload ?? {};
      if (!flowPath) { return; }
      if (!workspaceRoot) {
        vscode.window.showWarningMessage('Open a workspace folder to run flows.');
        return;
      }
      const flowName = path.basename(flowPath, '.json');
      const runnerPath = path.join(workspaceRoot, 'flow-runner.js');
      const terminal = vscode.window.createTerminal(`Flow: ${flowName}`);
      terminal.show();
      terminal.sendText(`node "${runnerPath}" "${flowPath}"`);
    })
  );
}

export function deactivate() {}
