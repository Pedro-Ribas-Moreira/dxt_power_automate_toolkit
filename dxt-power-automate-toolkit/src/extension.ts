import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PowerAutomateTreeProvider, PowerAutomateNode } from './treeProvider';
import { exportAndUnpack, packAndImport, initPacPath, createSolution, listEnvironments, listSolutions } from './pacCli';
import { loadCompanyContext, writeDefaultContext, CompanyContext } from './companyContext';
import { generateSolutionDocs } from './docGenerator';
import { initLogger, info, error } from './log';
import { openFlowVisualizer } from './flowVisualizer';
import { LibraryProvider, LibraryNode } from './libraryProvider';
import { buildLibrary, saveLibrary, loadLibrary, generateClaudeMd } from './libraryBuilder';
import { importFromJson, importFromCsv, importFromClipboardText, saveMockEntry, getMockDataPath, listApiActions, listMockActions } from './mockDataImporter';

export async function activate(context: vscode.ExtensionContext) {
  initLogger(context);
  await initPacPath(context);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  const solutionsRoot = workspaceRoot ? path.join(workspaceRoot, 'solutions') : undefined;
  let companyCtx: CompanyContext | null = workspaceRoot ? loadCompanyContext(workspaceRoot) : null;
  const provider = new PowerAutomateTreeProvider(solutionsRoot);

  // Library panel
  const libProvider = new LibraryProvider();
  if (solutionsRoot) {
    const existing = loadLibrary(solutionsRoot);
    if (existing) { libProvider.setLibrary(existing); }
  }

  // #4 status bar — shows which environment is currently active
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = '$(server) Power Automate';
  statusBar.tooltip = 'Expand an environment in the Power Automate Toolkit panel to set active';
  statusBar.show();
  context.subscriptions.push(statusBar);
  provider.onEnvSelected(env => {
    statusBar.text = `$(server) ${env.FriendlyName}`;
    statusBar.tooltip = env.EnvironmentUrl;
  });

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dxt-power-automate.treeView', provider),
    vscode.window.registerTreeDataProvider('dxt-power-automate.libraryView', libProvider),

    vscode.commands.registerCommand('dxt-power-automate-toolkit.refresh', () => provider.refresh()),

    vscode.commands.registerCommand('dxt-power-automate-toolkit.exportSolution', async (node: PowerAutomateNode) => {
      const { solution, envUrl } = node.payload ?? {};
      if (!solution || !envUrl) { return; }

      // Resolve destination — use workspace/solutions if open, otherwise ask the user to pick/create a folder
      let effectiveSolutionsRoot = solutionsRoot;
      if (!effectiveSolutionsRoot) {
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Export solutions here',
          title: 'Select (or create) a folder to export solutions into',
        });
        if (!picked?.length) { return; }
        effectiveSolutionsRoot = path.join(picked[0].fsPath, 'solutions');
        // Offer to open the picked folder as the workspace so subsequent actions work normally
        const open = await vscode.window.showInformationMessage(
          `Solutions will be saved to "${effectiveSolutionsRoot}". Open this folder in VS Code for the full toolkit experience?`,
          'Open Folder', 'Continue without opening'
        );
        if (open === 'Open Folder') {
          await vscode.commands.executeCommand('vscode.openFolder', picked[0], { forceNewWindow: false });
          return; // VS Code reloads — user can re-trigger the export in the new window
        }
      }

      const dest = effectiveSolutionsRoot;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Exporting ${solution.FriendlyName}…`, cancellable: false },
        async (progress) => {
          progress.report({ message: 'See Output panel for live progress' });
          try {
            info(`Exporting solution: ${solution.SolutionUniqueName} from ${envUrl}`);
            await exportAndUnpack(envUrl, solution.SolutionUniqueName, dest);
            info(`Export complete: ${solution.SolutionUniqueName}`);
            vscode.window.showInformationMessage(`✅ "${solution.FriendlyName}" exported successfully.`);
            provider.refresh();
            // auto-rebuild library after each export
            const lib = buildLibrary(dest);
            saveLibrary(lib, dest);
            generateClaudeMd(lib, dest);
            libProvider.setLibrary(lib);
            info(`Library rebuilt — ${lib.flowsScanned} flows across ${lib.solutionsScanned} solutions`);
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
      const { flowPath, solutionLocalDir } = node.payload ?? {};
      if (!flowPath) { return; }
      const flowName = path.basename(flowPath, '.json');
      const runnerPath = path.join(context.extensionPath, 'flow-runner.js');
      const mockPath = solutionLocalDir ? getMockDataPath(solutionLocalDir) : undefined;
      const hasMock = mockPath && require('fs').existsSync(mockPath);
      const terminal = vscode.window.createTerminal(`Flow: ${flowName}`);
      terminal.show();
      terminal.sendText(`node "${runnerPath}" "${flowPath}"${hasMock ? ` "${mockPath}"` : ''}`);
      if (hasMock) {
        info(`Running with mock data: ${mockPath}`);
      }
    }),

    vscode.commands.registerCommand('dxt-power-automate-toolkit.viewFlow', (node: PowerAutomateNode) => {
      const { flowPath } = node.payload ?? {};
      if (!flowPath) { return; }
      openFlowVisualizer(context, flowPath);
    }),

    vscode.commands.registerCommand('dxt-power-automate-toolkit.buildLibrary', () => {
      if (!solutionsRoot) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      const lib = buildLibrary(solutionsRoot);
      saveLibrary(lib, solutionsRoot);
      generateClaudeMd(lib, solutionsRoot);
      libProvider.setLibrary(lib);
      vscode.window.showInformationMessage(`✅ Library built — ${lib.flowsScanned} flows across ${lib.solutionsScanned} solutions`);
    }),

    vscode.commands.registerCommand('dxt-power-automate-toolkit.importMockData', async (node: PowerAutomateNode) => {
      const { flowPath, solutionLocalDir } = node.payload ?? {};
      if (!flowPath || !solutionLocalDir) { return; }

      const mockPath = getMockDataPath(solutionLocalDir);
      const existingMocks = listMockActions(mockPath);
      const apiActions = listApiActions(flowPath);

      if (!apiActions.length) {
        vscode.window.showInformationMessage('No API/connector actions found in this flow.');
        return;
      }

      // Step 1: pick source format
      const source = await vscode.window.showQuickPick([
        { label: '$(clippy) Paste from clipboard', description: 'Copy the run output from Power Automate and paste here', id: 'clipboard' },
        { label: '$(file-code) Select JSON file',  description: 'Point to a saved .json file from a PA run', id: 'json' },
        { label: '$(table) Select CSV file',        description: 'Excel → Save As CSV, then select here', id: 'csv' },
      ], { title: 'Import Mock Data — Step 1 of 2: Choose source' });
      if (!source) { return; }

      // Step 2: get raw data
      let raw: any = null;
      if (source.id === 'clipboard') {
        const text = await vscode.env.clipboard.readText();
        raw = importFromClipboardText(text);
        if (!raw) { vscode.window.showErrorMessage('Clipboard does not contain valid JSON or CSV.'); return; }
      } else {
        const ext = source.id === 'json' ? ['json'] : ['csv'];
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false, filters: { 'Data file': ext },
          title: `Select ${ext[0].toUpperCase()} file`
        });
        if (!picked?.length) { return; }
        raw = source.id === 'json'
          ? importFromJson(picked[0].fsPath)
          : importFromCsv(picked[0].fsPath);
        if (!raw) { vscode.window.showErrorMessage('Could not parse the selected file.'); return; }
      }

      // Step 3: pick which action this mock is for
      const actionPick = await vscode.window.showQuickPick(
        apiActions.map(a => ({
          label: a.displayName,
          description: `${a.type}${existingMocks.includes(a.name) ? '  ✓ already has mock' : ''}`,
          detail: a.name,
          action: a
        })),
        { title: 'Import Mock Data — Step 2 of 2: Which action does this data mock?' }
      );
      if (!actionPick) { return; }

      // Save
      saveMockEntry(mockPath, actionPick.action.name, raw);
      info(`Mock data saved: ${actionPick.action.name} → ${mockPath}`);
      vscode.window.showInformationMessage(
        `✅ Mock saved for "${actionPick.action.displayName}". The next ▶ Run will use it automatically.`
      );
    }),

    vscode.commands.registerCommand('dxt-power-automate-toolkit.deepScan', async () => {
      if (!solutionsRoot) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }

      // Step 1: load environments with a visible progress notification
      info('Deep Scan: loading environments…');
      let envs: Awaited<ReturnType<typeof listEnvironments>>;
      try {
        envs = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Deep Scan: loading environments…', cancellable: false },
          () => listEnvironments()
        );
      } catch (e: any) {
        error('Deep Scan: could not load environments', e.message);
        vscode.window.showErrorMessage('Could not load environments — check the Output panel.');
        return;
      }

      const envPick = await vscode.window.showQuickPick(
        envs.map(e => {
          const isDev = /dev[-_]/i.test(e.EnvironmentUrl) || /dev[-_ ]/i.test(e.FriendlyName);
          const isProd = e.EnvironmentIdentifier?.IsDefault || /prod/i.test(e.FriendlyName);
          return {
            label: e.FriendlyName,
            description: isProd ? '⚠ looks like production' : isDev ? '✓ development' : e.Geo,
            detail: e.EnvironmentUrl,
            env: e, isProd
          };
        }),
        { title: 'Deep Scan — Step 1 of 3: Select environment', placeHolder: 'Choose a non-production environment' }
      );
      if (!envPick) { return; }

      if (envPick.isProd) {
        const ok = await vscode.window.showWarningMessage(
          `"${envPick.label}" looks like a production environment. Deep Scan is safer on Development.`,
          { modal: true }, 'Proceed anyway'
        );
        if (ok !== 'Proceed anyway') { return; }
      }

      // Step 2: list unmanaged solutions and let user pick up to 10
      let solutions: any[];
      try {
        const raw = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Loading solutions from ${envPick.env.FriendlyName}…`, cancellable: false },
          () => listSolutions(envPick.env.EnvironmentUrl)
        );
        solutions = raw.filter((s: any) => !s.IsManaged);
      } catch (e: any) {
        error('Deep Scan: could not load solutions', e.message);
        vscode.window.showErrorMessage('Could not load solutions — check the Output panel.');
        return;
      }

      const picks = await vscode.window.showQuickPick(
        solutions.slice(0, 30).map((s: any, i: number) => ({
          label: s.FriendlyName,
          description: `v${s.VersionNumber}`,
          detail: s.SolutionUniqueName,
          solution: s,
          picked: i < 10
        })),
        {
          title: 'Deep Scan — Step 2 of 3: Select solutions (max 10)',
          placeHolder: 'First 10 are pre-selected — uncheck any you want to skip',
          canPickMany: true
        }
      );
      if (!picks?.length) { return; }

      const selected = (picks as any[]).slice(0, 10);
      const estMins = selected.length * 4;

      // Step 3: confirm
      const go = await vscode.window.showInformationMessage(
        `Scan ${selected.length} solution${selected.length > 1 ? 's' : ''} from "${envPick.env.FriendlyName}"?\n\n` +
        `Each solution: ~1 min export + 3 min cooldown\nEstimated total: ~${estMins} min`,
        { modal: true }, 'Start Scan'
      );
      if (go !== 'Start Scan') { return; }

      // Step 4: run incrementally
      info(`Deep Scan started — ${selected.length} solutions from ${envPick.env.EnvironmentUrl}`);
      let done = 0, failed = 0;

      for (let i = 0; i < selected.length; i++) {
        const sol = selected[i].solution;
        const isLast = i === selected.length - 1;

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Deep Scan ${i + 1}/${selected.length}: ${sol.FriendlyName}`, cancellable: false },
          async (progress) => {
            try {
              progress.report({ message: 'Exporting & unpacking…' });
              info(`Deep Scan: exporting ${sol.SolutionUniqueName}`);
              await exportAndUnpack(envPick.env.EnvironmentUrl, sol.SolutionUniqueName, solutionsRoot);
              done++;
              info(`Deep Scan: exported ${sol.SolutionUniqueName} (${done}/${selected.length})`);

              // Rebuild library immediately after each export
              const lib = buildLibrary(solutionsRoot);
              saveLibrary(lib, solutionsRoot);
              generateClaudeMd(lib, solutionsRoot);
              libProvider.setLibrary(lib);
              info(`Library updated — ${lib.flowsScanned} flows indexed`);
              provider.refresh();
            } catch (e: any) {
              failed++;
              error(`Deep Scan: failed on ${sol.SolutionUniqueName}`, e.message);
            }

            // 3-minute cooldown between solutions (skip after last)
            if (!isLast) {
              await countdown(progress, 3 * 60);
            }
          }
        );
      }

      vscode.window.showInformationMessage(
        `✅ Deep Scan complete — ${done} exported${failed ? `, ${failed} failed` : ''} · Library updated`
      );
    }),

    vscode.commands.registerCommand('dxt-power-automate-toolkit.filterLibrary', () => {
      const box = vscode.window.createInputBox();
      box.placeholder = 'Search actions, connectors, operations…';
      box.prompt = libProvider.getFilter() ? `Active filter: "${libProvider.getFilter()}" — clear to reset` : undefined;
      box.value = libProvider.getFilter();
      box.onDidChangeValue(v => libProvider.setFilter(v));
      box.onDidAccept(() => box.hide());
      box.onDidHide(() => box.dispose());
      box.show();
    }),

    vscode.commands.registerCommand('dxt-power-automate-toolkit.copySnippet', async (node: LibraryNode) => {
      const ex = node.payload?.example;
      const op = node.payload?.operation;
      const snippet = ex?.snippet ?? op?.examples?.[0]?.snippet;
      if (!snippet) { return; }
      const json = JSON.stringify(snippet, null, 2);
      await vscode.env.clipboard.writeText(json);
      vscode.window.showInformationMessage(`📋 Snippet copied — paste it into your flow JSON`);
    }),

    // ── Open in Browser ──────────────────────────────────────────────────────
    vscode.commands.registerCommand('dxt-power-automate-toolkit.openInBrowser', async (node: PowerAutomateNode) => {
      const { flowPath, envId, solution, envUrl } = node.payload ?? {};

      if (flowPath && envId) {
        // Flow node — extract the GUID from the filename
        const rawName = path.basename(flowPath, '.json');
        const guidMatch = rawName.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
        if (!guidMatch) {
          vscode.window.showErrorMessage('Could not extract flow GUID from filename. Expected format: FlowName-{GUID}.json');
          return;
        }
        const flowGuid = guidMatch[1];
        const url = `https://make.powerautomate.com/environments/${envId}/flows/${flowGuid}`;
        await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }

      if (solution && envId) {
        // Solution node — open the environment's solutions page (we don't have the solution GUID)
        const url = `https://make.powerautomate.com/environments/${envId}/solutions`;
        await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }

      if (envUrl) {
        // Fallback: open the environment's maker portal via its org URL
        await vscode.env.openExternal(vscode.Uri.parse('https://make.powerautomate.com'));
        return;
      }

      vscode.window.showWarningMessage('Could not determine the URL — make sure you expanded the environment in the tree first so the environment ID is loaded.');
    }),

    // ── Navigate from URL ────────────────────────────────────────────────────
    vscode.commands.registerCommand('dxt-power-automate-toolkit.navigateFromUrl', async () => {
      const input = await vscode.window.showInputBox({
        title: 'Go to Flow or Solution from URL',
        prompt: 'Paste a Power Automate or Power Apps maker portal URL',
        placeHolder: 'https://make.powerautomate.com/environments/.../solutions/.../flows/...',
        validateInput: v => v?.startsWith('http') ? undefined : 'Please paste a full URL starting with https://'
      });
      if (!input) { return; }

      // ── Parse all IDs from the URL ────────────────────────────────────────
      const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      const envMatch  = input.match(/\/environments\/([^/?#]+)/i);
      const solMatch  = input.match(/\/solutions\/(' + GUID_RE.source + ')/i) ??
                        input.match(/\/solutions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      const flowMatch = input.match(/\/flows\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);

      if (!envMatch) {
        vscode.window.showErrorMessage('Could not find an environment ID in the URL. Expected format: …/environments/{guid}/…');
        return;
      }

      const urlEnvId  = envMatch[1].toLowerCase();
      const urlSolId  = solMatch?.[1]?.toLowerCase();
      const urlFlowId = flowMatch?.[1]?.toLowerCase();

      // ── Step 1: if flow is already exported locally, open it directly ─────
      if (urlFlowId && solutionsRoot) {
        const found = findFlowFileByGuid(solutionsRoot, urlFlowId);
        if (found) {
          info(`URL navigation: found locally at ${found}`);
          openFlowVisualizer(context, found);
          // Show which solution it belongs to
          const solName = found.split(path.sep).reverse().find((_, i, arr) => arr[i + 1] === 'Workflows') ?? '';
          vscode.window.showInformationMessage(`✅ Opened flow from solution: ${solName || 'local'}`);
          provider.refresh();
          return;
        }
      }

      // ── Step 2: load environments and find the matching one ───────────────
      info('URL navigation: flow not found locally — loading environments…');
      let envs: Awaited<ReturnType<typeof listEnvironments>>;
      try {
        envs = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'URL navigation: loading environments…', cancellable: false },
          () => listEnvironments()
        );
      } catch (e: any) {
        error('URL navigation: could not load environments', e.message);
        vscode.window.showErrorMessage('Could not load environments — is pac authenticated? Check the Output panel.');
        return;
      }

      const matchedEnv = envs.find(e =>
        e.EnvironmentIdentifier?.Id?.toLowerCase() === urlEnvId
      );

      if (!matchedEnv) {
        vscode.window.showWarningMessage(
          `Environment "${urlEnvId}" not found in your pac-authenticated environments. You may need to authenticate to the correct tenant.`,
          'Open in Browser'
        ).then(c => { if (c === 'Open in Browser') { vscode.env.openExternal(vscode.Uri.parse(input)); } });
        return;
      }

      // ── Step 3: load solutions for that environment ───────────────────────
      let solutions: (typeof envs[0] extends infer E ? any[] : any[]);
      try {
        solutions = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Loading solutions from "${matchedEnv.FriendlyName}"…`, cancellable: false },
          () => listSolutions(matchedEnv.EnvironmentUrl)
        );
      } catch (e: any) {
        error('URL navigation: could not load solutions', e.message);
        vscode.window.showErrorMessage('Could not load solutions — check the Output panel.');
        return;
      }

      // ── Step 4: try to auto-match the solution by GUID ───────────────────
      // pac solution list JSON may include SolutionId; if not, we fall back to QuickPick
      const autoMatch = urlSolId
        ? solutions.find((s: any) => s.SolutionId?.toLowerCase() === urlSolId)
        : undefined;

      const unmanagedSolutions = solutions.filter((s: any) => !s.IsManaged);
      const picks = unmanagedSolutions.map((s: any) => {
        const localDir = solutionsRoot ? path.join(solutionsRoot, s.SolutionUniqueName) : undefined;
        const isLocal  = localDir ? fs.existsSync(localDir) : false;
        const isMatch  = s.SolutionId?.toLowerCase() === urlSolId;
        return {
          label:       (isMatch ? '$(star-full) ' : '') + s.FriendlyName,
          description: `v${s.VersionNumber}` + (isLocal ? ' ✓ local' : '') + (isMatch ? ' ← from URL' : ''),
          detail:      s.SolutionUniqueName,
          solution:    s,
          isLocal,
          picked:      !!isMatch
        };
      });

      const autoLabel = autoMatch
        ? `Auto-matched: "${autoMatch.FriendlyName}" — export it now?`
        : `Environment: ${matchedEnv.FriendlyName} — which solution contains this flow?`;

      const picked = await vscode.window.showQuickPick(picks, {
        title: autoLabel,
        placeHolder: urlSolId ? `Solution ID from URL: ${urlSolId}` : 'Select the solution to export',
      });
      if (!picked) { return; }

      if (picked.isLocal && solutionsRoot) {
        // Already local — refresh tree and tell the user where to find it
        provider.refresh();
        vscode.window.showInformationMessage(
          `✅ "${picked.solution.FriendlyName}" is already exported locally. Expand it in the Environments panel to find your flow.`
        );
        return;
      }

      if (!solutionsRoot) {
        vscode.window.showWarningMessage('Open a workspace folder first so there is somewhere to export solutions into.');
        return;
      }

      // ── Step 5: export the solution, then open the flow ───────────────────
      const go = await vscode.window.showInformationMessage(
        `Export & unpack "${picked.solution.FriendlyName}" from "${matchedEnv.FriendlyName}"?`,
        { modal: true }, 'Export & Unpack'
      );
      if (go !== 'Export & Unpack') { return; }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Exporting "${picked.solution.FriendlyName}"…`, cancellable: false },
        async (progress) => {
          progress.report({ message: 'See Output panel for live progress' });
          try {
            await exportAndUnpack(matchedEnv.EnvironmentUrl, picked.solution.SolutionUniqueName, solutionsRoot!);
            const lib = buildLibrary(solutionsRoot!);
            saveLibrary(lib, solutionsRoot!);
            generateClaudeMd(lib, solutionsRoot!);
            libProvider.setLibrary(lib);
            provider.refresh();

            // Try to open the flow now that it's exported
            if (urlFlowId) {
              const found = findFlowFileByGuid(solutionsRoot!, urlFlowId);
              if (found) {
                openFlowVisualizer(context, found);
                vscode.window.showInformationMessage(`✅ Flow exported and opened from "${picked.solution.FriendlyName}"`);
              } else {
                vscode.window.showInformationMessage(`✅ "${picked.solution.FriendlyName}" exported. Expand it in the tree to find your flow.`);
              }
            } else {
              vscode.window.showInformationMessage(`✅ "${picked.solution.FriendlyName}" exported successfully.`);
            }
          } catch (e: any) {
            error(`URL navigation: export failed for ${picked.solution.SolutionUniqueName}`, e.message);
            vscode.window.showErrorMessage(`Export failed: ${e.message}`);
          }
        }
      );
    }),

    // ── Generate Markdown documentation ─────────────────────────────────────
    vscode.commands.registerCommand('dxt-power-automate-toolkit.generateDocs', async (node?: PowerAutomateNode) => {
      if (!solutionsRoot) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      if (!fs.existsSync(solutionsRoot)) {
        vscode.window.showWarningMessage('No solutions folder found — export at least one solution first.');
        return;
      }
      // When triggered from a solution node, limit to that solution only
      const onlySolution = node?.payload?.solution?.SolutionUniqueName
        ?? (node?.payload?.solutionLocalDir ? path.basename(node.payload.solutionLocalDir) : undefined);

      // ── LM model selection — provider-agnostic (Claude, Copilot, etc.) ──────
      let summarize: ((prompt: string) => Promise<string>) | undefined;
      let modelLabel = '';

      const DOC_MODEL_KEY = 'docSummaryModelId';
      let allModels: vscode.LanguageModelChat[] = [];
      try {
        allModels = await vscode.lm.selectChatModels();
      } catch { /* LM API not available */ }

      if (allModels.length === 0) {
        const choice = await vscode.window.showInformationMessage(
          'No AI language model found. Install Claude or GitHub Copilot to enable plain-English summaries.',
          'Generate without summaries', 'Cancel'
        );
        if (choice !== 'Generate without summaries') { return; }
      } else {
        // Build picker: last-used model floats to the top
        const lastId = context.globalState.get<string>(DOC_MODEL_KEY);
        type ModelItem = vscode.QuickPickItem & { modelId: string };
        const modelItems: ModelItem[] = allModels.map(m => ({
          label: `$(sparkle) ${m.name || m.id}`,
          description: m.vendor,
          detail: m.id === lastId ? '★ Last used' : undefined,
          modelId: m.id,
        }));
        // Float last-used to top
        const lastIdx = modelItems.findIndex(i => i.modelId === lastId);
        if (lastIdx > 0) { modelItems.unshift(...modelItems.splice(lastIdx, 1)); }

        const noAiItem: ModelItem = {
          label: '$(circle-slash) No AI summaries',
          description: 'Technical docs only, no plain-English descriptions',
          modelId: '',
        };

        const pick = await vscode.window.showQuickPick([...modelItems, noAiItem], {
          title: 'Generate Flow Documentation — AI model',
          placeHolder: 'Choose which AI to use for plain-English summaries',
        });
        if (!pick) { return; } // user cancelled

        if (pick.modelId) {
          const chosen = allModels.find(m => m.id === pick.modelId)!;
          modelLabel = chosen.name || chosen.id;
          context.globalState.update(DOC_MODEL_KEY, chosen.id);
          summarize = async (prompt: string) => {
            const msgs = [vscode.LanguageModelChatMessage.User(prompt)];
            const res = await chosen.sendRequest(msgs, {});
            let text = '';
            for await (const chunk of res.text) { text += chunk; }
            return text.trim();
          };
          info(`Doc generation: using "${modelLabel}" for AI summaries`);
        }
      }

      const MARKER_START = '<!-- PA-DOCS:START -->';
      const MARKER_END = '<!-- PA-DOCS:END -->';

      let solutionDocs: import('./docGenerator').SolutionDoc[] = [];
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: summarize
            ? `Generating docs${onlySolution ? ` for ${onlySolution}` : ''} with AI summaries (${modelLabel})…`
            : `Generating flow documentation${onlySolution ? ` for ${onlySolution}` : ''}…`,
          cancellable: false,
        },
        async (progress) => {
          solutionDocs = await generateSolutionDocs(solutionsRoot!, summarize, (msg) => {
            progress.report({ message: msg });
          }, onlySolution, companyCtx ?? undefined);
        }
      );

      if (!solutionDocs.length) {
        vscode.window.showWarningMessage('No solutions with flows found — export at least one solution first.');
        return;
      }

      // Write one FLOWS.md per solution, inside its folder
      let firstPath = '';
      for (const sol of solutionDocs) {
        const block = `${MARKER_START}\n${sol.content}\n${MARKER_END}`;
        let finalContent: string;

        if (fs.existsSync(sol.outPath)) {
          const existing = fs.readFileSync(sol.outPath, 'utf8');
          const s = existing.indexOf(MARKER_START);
          const e = existing.indexOf(MARKER_END);
          if (s !== -1 && e !== -1 && e > s) {
            finalContent = existing.slice(0, s) + block + existing.slice(e + MARKER_END.length);
          } else {
            finalContent = block + '\n\n---\n\n## My Notes\n\n> ✏️ Write your custom notes here — they will be preserved on every re-generation.\n\n' + existing;
          }
        } else {
          finalContent = block + '\n\n---\n\n## My Notes\n\n> ✏️ Write your custom notes here — they will be preserved on every re-generation.\n';
        }

        fs.writeFileSync(sol.outPath, finalContent, 'utf8');
        info(`Docs written: ${sol.outPath}`);
        if (!firstPath) { firstPath = sol.outPath; }
      }

      const doc = await vscode.workspace.openTextDocument(firstPath);
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(
        `✅ FLOWS.md generated for ${solutionDocs.length} solution${solutionDocs.length !== 1 ? 's' : ''}${summarize ? ` with AI summaries (${modelLabel})` : ''}`
      );
    }),

    // ── Setup company context ─────────────────────────────────────────────────
    vscode.commands.registerCommand('dxt-power-automate-toolkit.setupContext', async () => {
      if (!workspaceRoot) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      const filePath = writeDefaultContext(workspaceRoot);
      companyCtx = loadCompanyContext(workspaceRoot);
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage('Edit company-context.json to match your organisation, then save. The extension will use it for AI summaries and naming suggestions.');
    }),

    // ── Search flows across solutions ────────────────────────────────────────
    vscode.commands.registerCommand('dxt-power-automate-toolkit.searchFlows', async () => {
      if (!solutionsRoot) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      if (!fs.existsSync(solutionsRoot)) {
        vscode.window.showWarningMessage('No solutions folder found — export at least one solution first.');
        return;
      }

      type FlowItem = vscode.QuickPickItem & { flowPath: string };
      const items: FlowItem[] = [];

      const solutionDirs = fs.readdirSync(solutionsRoot, { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => d.name);

      for (const sol of solutionDirs) {
        const workflowsDir = path.join(solutionsRoot, sol, 'Workflows');
        if (!fs.existsSync(workflowsDir)) { continue; }
        for (const file of fs.readdirSync(workflowsDir).filter(f => f.endsWith('.json'))) {
          try {
            const flowPath = path.join(workflowsDir, file);
            const raw = fs.readFileSync(flowPath, 'utf8');
            const flow = JSON.parse(raw);
            const def = flow.properties?.definition ?? flow.definition ?? flow;

            const displayName = path.basename(file, '.json')
              .replace(/-[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/i, '')
              .replace(/-/g, ' ');

            const triggerType: string = (Object.values(def.triggers ?? {})[0] as any)?.type ?? '';
            const actionVals = Object.values(def.actions ?? {}) as any[];
            const connectors: string[] = [...new Set(
              actionVals.flatMap(a => {
                const apiId: string | undefined = a.inputs?.host?.apiId;
                return apiId ? [apiId.split('/').pop()!] : [];
              })
            )];

            items.push({
              label: `$(play-circle) ${displayName}`,
              description: sol,
              detail: [triggerType, ...connectors].filter(Boolean).join(' · '),
              flowPath,
            });
          } catch { /* skip unparseable */ }
        }
      }

      if (!items.length) {
        vscode.window.showInformationMessage('No flow files found — export solutions first.');
        return;
      }

      const picked = await vscode.window.showQuickPick(items, {
        title: `Search Flows (${items.length} total)`,
        placeHolder: 'Filter by flow name, solution, connector, or trigger type…',
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (picked) {
        openFlowVisualizer(context, picked.flowPath);
      }
    }),

    vscode.commands.registerCommand('dxt-power-automate-toolkit.newSolution', async () => {
      if (!solutionsRoot) {
        vscode.window.showWarningMessage('Open a workspace folder before creating a solution.');
        return;
      }

      // Step 1: pick environment
      let envs: Awaited<ReturnType<typeof listEnvironments>>;
      try {
        envs = await listEnvironments();
      } catch {
        vscode.window.showErrorMessage('Could not load environments. Is pac authenticated?');
        return;
      }
      const envPick = await vscode.window.showQuickPick(
        envs.map(e => ({ label: e.FriendlyName, description: e.EnvironmentIdentifier?.IsDefault ? 'default' : e.Geo, detail: e.EnvironmentUrl, env: e })),
        { title: 'New Solution — Step 1 of 4', placeHolder: 'Select target environment' }
      );
      if (!envPick) { return; }

      // Step 2: display name
      const displayName = await vscode.window.showInputBox({
        title: 'New Solution — Step 2 of 4',
        prompt: 'Solution display name',
        placeHolder: 'e.g. PPP - My New Flow',
        validateInput: v => v?.trim() ? undefined : 'Required'
      });
      if (!displayName) { return; }

      // Step 3: unique name (auto-generated, editable)
      const autoUnique = displayName.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
      const uniqueName = await vscode.window.showInputBox({
        title: 'New Solution — Step 3 of 4',
        prompt: 'Solution unique name (no spaces or special characters)',
        value: autoUnique,
        validateInput: v => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(v ?? '') ? undefined : 'Must start with a letter, letters/numbers/underscores only'
      });
      if (!uniqueName) { return; }

      // Step 4: brand / publisher prefix — show brands from company context if available
      let publisherPrefix: string | undefined;
      if (companyCtx?.brands.length) {
        type BrandItem = vscode.QuickPickItem & { prefix: string };
        const brandItems: BrandItem[] = companyCtx.brands.map(b => ({
          label: b.name,
          description: b.prefix.toLowerCase(),
          detail: b.description,
          prefix: b.prefix.toLowerCase(),
        }));
        const customItem: BrandItem = { label: '$(edit) Custom prefix…', description: '', prefix: '' };
        const picked = await vscode.window.showQuickPick([...brandItems, customItem], {
          title: 'New Solution — Step 4 of 4',
          placeHolder: 'Select the brand this solution belongs to',
        });
        if (!picked) { return; }
        if (picked.prefix) {
          publisherPrefix = picked.prefix;
        } else {
          publisherPrefix = await vscode.window.showInputBox({
            title: 'New Solution — Step 4 of 4',
            prompt: 'Publisher prefix',
            value: 'dta',
            validateInput: v => /^[a-z][a-z0-9]{1,7}$/.test(v ?? '') ? undefined : '2-8 lowercase letters/numbers, must start with a letter'
          });
        }
      } else {
        publisherPrefix = await vscode.window.showInputBox({
          title: 'New Solution — Step 4 of 4',
          prompt: 'Publisher prefix',
          value: 'dta',
          validateInput: v => /^[a-z][a-z0-9]{1,7}$/.test(v ?? '') ? undefined : '2-8 lowercase letters/numbers, must start with a letter'
        });
      }
      if (!publisherPrefix) { return; }

      const publisherName = companyCtx?.brands.find(b => b.prefix.toLowerCase() === publisherPrefix)?.name
        ?? publisherPrefix.toUpperCase();
      const envUrl = envPick.env.EnvironmentUrl;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Creating solution "${displayName}"…`, cancellable: false },
        async (progress) => {
          progress.report({ message: 'See Output panel for progress' });
          try {
            info(`Creating solution: ${uniqueName} in ${envUrl}`);
            await createSolution(envUrl, uniqueName, displayName, publisherPrefix, publisherName, solutionsRoot);
            info(`Solution created: ${uniqueName}`);
            vscode.window.showInformationMessage(`✅ Solution "${displayName}" created in ${envPick.env.FriendlyName}`);
            provider.refresh();
          } catch (e: any) {
            error(`Create solution failed: ${uniqueName}`, e.message);
            vscode.window.showErrorMessage(`❌ Create failed: ${e.message}`);
          }
        }
      );
    })
  );
}

export function deactivate() {}

function findFlowFileByGuid(solutionsRoot: string, flowGuid: string): string | null {
  try {
    const solutions = fs.readdirSync(solutionsRoot, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    for (const sol of solutions) {
      const workflowsDir = path.join(solutionsRoot, sol, 'Workflows');
      if (!fs.existsSync(workflowsDir)) { continue; }
      const match = fs.readdirSync(workflowsDir).find(f =>
        f.toLowerCase().endsWith('.json') && f.toLowerCase().includes(flowGuid.toLowerCase())
      );
      if (match) { return path.join(workflowsDir, match); }
    }
  } catch { /* ignore */ }
  return null;
}

function countdown(
  progress: vscode.Progress<{ message?: string }>,
  seconds: number
): Promise<void> {
  return new Promise(resolve => {
    let remaining = seconds;
    const tick = () => {
      const m = Math.floor(remaining / 60);
      const s = String(remaining % 60).padStart(2, '0');
      progress.report({ message: `⏳ Cooling down — ${m}:${s} before next solution` });
      if (remaining <= 0) { resolve(); return; }
      remaining--;
      setTimeout(tick, 1000);
    };
    tick();
  });
}
