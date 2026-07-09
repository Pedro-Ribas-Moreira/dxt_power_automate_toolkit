import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PowerAutomateTreeProvider, PowerAutomateNode } from './treeProvider';
import { exportAndUnpack, packAndImport, initPacPath, createSolution, listEnvironments, listSolutions, writeTemplateFlow, addWorkflowComponent, TriggerType } from './pacCli';
import { loadCompanyContext, writeDefaultContext, CompanyContext } from './companyContext';
import { generateSolutionDocs } from './docGenerator';
import { initLogger, info, error } from './log';
import { openFlowVisualizer } from './flowVisualizer';
import { openLibraryPanel } from './libraryPanel';
import { LibraryProvider, LibraryNode } from './libraryProvider';
import { buildLibrary, saveLibrary, loadLibrary, generateClaudeMd, mergeLibraries } from './libraryBuilder';
import { importFromJson, importFromCsv, importFromClipboardText, saveMockEntry, getMockDataPath, listApiActions, listMockActions } from './mockDataImporter';
import { initSharePoint, spUpload, spDownload, spListFolder, storeClientSecret, getStoredClientSecret, spDiscoverSites, spDiscoverLists, spDiscoverColumns } from './sharepoint';
import { resolveEnvName, getFlowRuns, getFlowRunDetail } from './paApi';
import { openFlowRunsPanel } from './flowRunsPanel';
import { buildCloudIndex, renderIndexMarkdown } from './cloudIndexBuilder';
import { initAsana, setAsanaPat, updateAsanaConfiguredContext, extractTaskGid, fetchTask, fetchProjectSections, createTask as createAsanaTask } from './asanaApi';
import { linkTask, unlinkTask, pullSharedLinks, importBridgeLinks } from './asanaLinks';
import { AsanaTreeProvider, AsanaNode } from './asanaProvider';
import { openAsanaTaskPanel } from './asanaPanel';

export async function activate(context: vscode.ExtensionContext) {
  initLogger(context);
  initSharePoint(context);

  // First run: store the client secret securely if not already saved
  const existingSecret = await getStoredClientSecret();
  if (!existingSecret) {
    const secret = await vscode.window.showInputBox({
      title: 'DXT Power Automate Toolkit — SharePoint Setup',
      prompt: 'Paste the Azure AD client secret provided by IT (stored encrypted, asked only once)',
      password: true,
      placeHolder: 'Client secret…',
    });
    if (secret) { await storeClientSecret(secret); }
  }

  await initPacPath(context);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  initAsana(context, workspaceRoot);
  void updateAsanaConfiguredContext(); // drives the Asana view's welcome content

  // Deep-merge two JSON values. `local` takes precedence for scalar conflicts.
  // Arrays of strings → union. Arrays of objects → merge by first found key (name/id/url/key).
  function deepMergeJson(base: any, local: any): any {
    if (local === null || local === undefined) { return base; }
    if (base === null || base === undefined) { return local; }
    if (Array.isArray(base) && Array.isArray(local)) {
      if (local.length === 0) { return base; }
      if (typeof local[0] === 'string') {
        return [...new Set([...local, ...base.filter((i: any) => typeof i === 'string')])];
      }
      const keyField = ['name', 'id', 'url', 'key', 'webUrl'].find(k => local[0]?.[k] !== undefined);
      if (keyField) {
        const map = new Map<string, any>(base.map((i: any) => [String(i[keyField]), i]));
        for (const item of local) {
          const k = String(item[keyField]);
          map.set(k, map.has(k) ? deepMergeJson(map.get(k), item) : item);
        }
        return [...map.values()];
      }
      return local; // object arrays without a clear key: local wins
    }
    if (typeof base === 'object' && typeof local === 'object' && !Array.isArray(base)) {
      const result: any = { ...base };
      for (const [k, v] of Object.entries(local)) { result[k] = deepMergeJson(base[k], v); }
      return result;
    }
    return local; // scalar: local wins
  }

  // Download shared context from SharePoint, deep-merge local into it, upload merged result.
  async function mergeAndUploadContext(spFileName: string, localContent: string): Promise<void> {
    let merged = localContent;
    try {
      const sharedJson = await spDownload(spFileName);
      if (sharedJson) {
        const base = JSON.parse(sharedJson);
        const local = JSON.parse(localContent);
        merged = JSON.stringify(deepMergeJson(base, local), null, 2);
      }
    } catch { /* no shared copy or parse error — upload as-is */ }
    await spUpload(spFileName, merged);
  }

  // Merge local library into the shared SharePoint copy, then upload the combined result.
  // This preserves contributions from teammates who have different solutions locally.
  async function mergeAndUploadLibrary(local: import('./libraryBuilder').Library): Promise<void> {
    try {
      const sharedJson = await spDownload('pa-library.json');
      if (sharedJson) {
        const shared: import('./libraryBuilder').Library = JSON.parse(sharedJson);
        local = mergeLibraries(shared, local); // local (patch) takes precedence
      }
    } catch { /* no shared copy yet — upload as-is */ }
    await spUpload('pa-library.json', JSON.stringify(local, null, 2));
    info(`Library synced to SharePoint (${local.flowsScanned} flows, ${local.topicsScanned} topics)`);
  }

  // Silently pull shared files from SharePoint on startup
  if (workspaceRoot) {
    const contextLocalPath = path.join(workspaceRoot, 'company-context.json');
    const solutionsRootEarly = path.join(workspaceRoot, 'solutions');
    const libLocalPath = path.join(solutionsRootEarly, '.pa-library.json');
    Promise.all([
      // Always pull the latest cloud index
      spDownload('cloud-index.md').then(content => {
        if (content) {
          fs.writeFileSync(path.join(workspaceRoot, 'DXT_CLOUD_INDEX.md'), content, 'utf8');
          info('Cloud index pulled from SharePoint');
        }
      }),
      // Always merge shared company context with local — neither side loses data
      spDownload('company-context.json').then(sharedContent => {
        if (!sharedContent) { return; }
        const local = fs.existsSync(contextLocalPath) ? fs.readFileSync(contextLocalPath, 'utf8') : null;
        const merged = local
          ? JSON.stringify(deepMergeJson(JSON.parse(sharedContent), JSON.parse(local)), null, 2)
          : sharedContent;
        fs.writeFileSync(contextLocalPath, merged, 'utf8');
        companyCtx = loadCompanyContext(workspaceRoot);
        info('Company context merged from SharePoint');
      }).catch(e => info(`Company context startup merge skipped: ${e.message}`)),
      // Action library: pull if no local file, otherwise merge+push local copy to SharePoint
      fs.existsSync(libLocalPath)
        ? mergeAndUploadLibrary(JSON.parse(fs.readFileSync(libLocalPath, 'utf8')))
            .catch(e => info(`Action library startup upload skipped: ${e.message}`))
        : spDownload('pa-library.json').then(content => {
            if (content) {
              fs.mkdirSync(solutionsRootEarly, { recursive: true });
              fs.writeFileSync(libLocalPath, content, 'utf8');
              info('Action library pulled from SharePoint');
            }
          }),
      // Asana solution↔task links shared by the team
      pullSharedLinks(workspaceRoot)
        .then(() => info('Asana links pulled from SharePoint'))
        .catch(e => info(`Asana links startup pull skipped: ${e.message}`)),
    ]).catch(() => { /* not signed in yet or files don't exist — ignore */ });
  }
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

  const asanaProvider = new AsanaTreeProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dxt-power-automate.treeView', provider),
    vscode.window.registerTreeDataProvider('dxt-power-automate.libraryView', libProvider),
    vscode.window.registerTreeDataProvider('dxt-power-automate.asanaView', asanaProvider),

    vscode.commands.registerCommand('dxt-power-automate-toolkit.refresh', () => provider.refresh()),

    // ── Asana ────────────────────────────────────────────────────────────────
    vscode.commands.registerCommand('dxt-power-automate-toolkit.asanaSetPat', async () => {
      const pat = await vscode.window.showInputBox({
        title: 'Asana — Personal Access Token',
        prompt: 'Create one at app.asana.com/0/my-apps → Personal access tokens. Stored encrypted via VS Code SecretStorage.',
        password: true,
        placeHolder: '1/1205145366424683:…',
      });
      if (!pat?.trim()) { return; }
      await setAsanaPat(pat.trim());
      asanaProvider.refresh();
      provider.refresh();
      vscode.window.showInformationMessage('✅ Asana connected.');
    }),

    vscode.commands.registerCommand('dxt-power-automate-toolkit.asanaRefresh', () => asanaProvider.refresh()),

    vscode.commands.registerCommand('dxt-power-automate-toolkit.asanaOpenTask', async (arg: string | AsanaNode | PowerAutomateNode) => {
      const gid = typeof arg === 'string'
        ? arg
        : arg instanceof AsanaNode
          ? arg.task?.gid
          : (arg as PowerAutomateNode)?.payload?.asanaGid;
      if (!gid) { return; }
      await openAsanaTaskPanel(context, gid);
    }),

    vscode.commands.registerCommand('dxt-power-automate-toolkit.asanaOpenInBrowser', async (node: AsanaNode | PowerAutomateNode) => {
      let url = node instanceof AsanaNode ? node.task?.permalink_url : (node as PowerAutomateNode)?.payload?.asanaUrl;
      if (!url) {
        const gid = node instanceof AsanaNode ? node.task?.gid : (node as PowerAutomateNode)?.payload?.asanaGid;
        if (gid) {
          try { url = (await fetchTask(gid)).permalink_url; } catch { /* fall through */ }
        }
      }
      if (url) { void vscode.env.openExternal(vscode.Uri.parse(url)); }
    }),

    vscode.commands.registerCommand('dxt-power-automate-toolkit.asanaAddComment', async (node: AsanaNode) => {
      const gid = node?.task?.gid;
      if (!gid) { return; }
      await openAsanaTaskPanel(context, gid);
    }),

    vscode.commands.registerCommand('dxt-power-automate-toolkit.asanaCreateTask', async () => {
      const name = await vscode.window.showInputBox({
        title: 'Asana — New Task',
        prompt: 'Task name',
        validateInput: v => v?.trim() ? undefined : 'Required',
      });
      if (!name) { return; }
      const notes = await vscode.window.showInputBox({ title: 'Asana — New Task', prompt: 'Notes (optional)' });
      if (notes === undefined) { return; }
      let sectionGid: string | undefined;
      try {
        const sections = await fetchProjectSections();
        if (sections.length) {
          const pick = await vscode.window.showQuickPick(
            sections.map(s => ({ label: s.name, gid: s.gid })),
            { title: 'Asana — New Task', placeHolder: 'Section (Esc to leave unfiled)' }
          );
          sectionGid = pick?.gid;
        }
      } catch { /* sections unavailable — create unfiled */ }
      try {
        const created = await createAsanaTask({ name, notes: notes || undefined, sectionGid });
        asanaProvider.refresh();
        const open = await vscode.window.showInformationMessage(`✅ Task created: ${created.name}`, 'Open in Asana');
        if (open) { void vscode.env.openExternal(vscode.Uri.parse(created.permalink_url)); }
      } catch (e: any) {
        vscode.window.showErrorMessage(`Create task failed: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand('dxt-power-automate-toolkit.linkAsanaTask', async (node: PowerAutomateNode | AsanaNode) => {
      if (!workspaceRoot) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }

      // From an Asana task node → pick a local solution; from a solution node → paste a task URL/GID
      let solutionUniqueName: string | undefined;
      let gid: string | undefined;

      if (node instanceof AsanaNode) {
        gid = node.task?.gid;
        if (!gid) { return; }
        if (!solutionsRoot || !fs.existsSync(solutionsRoot)) {
          vscode.window.showWarningMessage('No local solutions folder found — export a solution first.');
          return;
        }
        const localDirs = fs.readdirSync(solutionsRoot, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith('.'))
          .map(d => d.name);
        const pick = await vscode.window.showQuickPick(localDirs, {
          title: `Link "${node.task!.name}" to a solution`,
          placeHolder: 'Select the solution this ticket belongs to',
        });
        if (!pick) { return; }
        solutionUniqueName = pick;
      } else {
        solutionUniqueName = node?.payload?.solution?.SolutionUniqueName;
        if (!solutionUniqueName) { return; }
        const input = await vscode.window.showInputBox({
          title: `Link Asana Task to ${solutionUniqueName}`,
          prompt: 'Paste the Asana task URL or GID',
          placeHolder: 'https://app.asana.com/0/1204978926889787/1210… or 1210…',
        });
        if (!input) { return; }
        const extracted = extractTaskGid(input);
        if (!extracted) {
          vscode.window.showErrorMessage('Could not find a task GID in that input.');
          return;
        }
        gid = extracted;
      }

      // Validate the task exists before storing the link (mirrors dxt-bridge's 404 check)
      try {
        const task = await fetchTask(gid);
        await linkTask(workspaceRoot, solutionUniqueName, gid);
        provider.refresh();
        vscode.window.showInformationMessage(`🔗 Linked "${task.name}" to ${solutionUniqueName}`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Could not link task: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand('dxt-power-automate-toolkit.unlinkAsanaTask', async (node: PowerAutomateNode) => {
      const gid = node?.payload?.asanaGid;
      const solutionUniqueName = node?.payload?.solution?.SolutionUniqueName;
      if (!gid || !solutionUniqueName || !workspaceRoot) { return; }
      await unlinkTask(workspaceRoot, solutionUniqueName, gid);
      provider.refresh();
      vscode.window.showInformationMessage(`Unlinked task from ${solutionUniqueName}.`);
    }),

    vscode.commands.registerCommand('dxt-power-automate-toolkit.asanaImportBridgeLinks', async () => {
      if (!workspaceRoot) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      const picked = await vscode.window.showOpenDialog({
        title: 'Select the dxt-bridge .asana.json',
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { JSON: ['json'] },
        defaultUri: vscode.Uri.file(path.join(process.env.USERPROFILE ?? '', 'Desktop', 'dxt-bridge', 'dxt-bridge', '.asana.json')),
      });
      if (!picked?.length) { return; }
      try {
        // Imports ONLY the links map — the plaintext PAT in .asana.json is ignored on purpose.
        const count = await importBridgeLinks(workspaceRoot, picked[0].fsPath);
        provider.refresh();
        vscode.window.showInformationMessage(
          `✅ Imported ${count} Asana link${count !== 1 ? 's' : ''} from dxt-bridge. ` +
          `The PAT was NOT imported — run "Asana: Set Personal Access Token" to connect.`
        );
      } catch (e: any) {
        vscode.window.showErrorMessage(`Import failed: ${e.message}`);
      }
    }),

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
        { location: vscode.ProgressLocation.Notification, title: `Pulling "${solution.FriendlyName}" from cloud…`, cancellable: false },
        async (progress) => {
          progress.report({ message: 'See Output panel for live progress' });
          try {
            info(`Exporting solution: ${solution.SolutionUniqueName} from ${envUrl}`);
            await exportAndUnpack(envUrl, solution.SolutionUniqueName, dest);
            info(`Export complete: ${solution.SolutionUniqueName}`);
            vscode.window.showInformationMessage(`✅ "${solution.FriendlyName}" pulled from cloud successfully.`);
            provider.refresh();
            // auto-rebuild library after each export
            const lib = buildLibrary(dest);
            saveLibrary(lib, dest);
            const _wr1 = workspaceRoot ?? path.join(dest, '..');
            generateClaudeMd(lib, dest, _wr1, context.extensionPath);
            libProvider.setLibrary(lib);
            info(`Library rebuilt — ${lib.flowsScanned} flows across ${lib.solutionsScanned} solutions`);
            mergeAndUploadLibrary(lib).catch(e => info(`Library SharePoint sync skipped: ${e.message}`));
            spUpload('CLAUDE.md', fs.readFileSync(path.join(_wr1, 'CLAUDE.md'), 'utf8')).catch(e => info(`CLAUDE.md SharePoint upload skipped: ${e.message}`));
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
        `Push "${solution.FriendlyName}" to ${envHost}?`,
        { modal: true },
        'Push to Cloud'
      );
      if (confirm !== 'Push to Cloud') { return; }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Pushing "${solution.FriendlyName}" to cloud…`, cancellable: false },
        async (progress) => {
          progress.report({ message: 'Packing… See Output panel for live progress' });
          try {
            info(`Importing solution: ${solution.SolutionUniqueName} to ${envUrl}`);
            await packAndImport(envUrl, solution.SolutionUniqueName, solutionLocalDir);
            info(`Import complete: ${solution.SolutionUniqueName}`);
            vscode.window.showInformationMessage(`✅ "${solution.FriendlyName}" pushed to cloud successfully.`);
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

    vscode.commands.registerCommand('dxt-power-automate-toolkit.openLibrarySearch', () => {
      if (!solutionsRoot) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      openLibraryPanel(context, solutionsRoot);
    }),

    vscode.commands.registerCommand('dxt-power-automate-toolkit.buildLibrary', () => {
      if (!solutionsRoot) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      const lib = buildLibrary(solutionsRoot);
      saveLibrary(lib, solutionsRoot);
      generateClaudeMd(lib, solutionsRoot, workspaceRoot, context.extensionPath);
      libProvider.setLibrary(lib);
      mergeAndUploadLibrary(lib).catch(e => info(`Library SharePoint sync skipped: ${e.message}`));
      if (workspaceRoot && fs.existsSync(path.join(workspaceRoot, 'CLAUDE.md'))) {
        spUpload('CLAUDE.md', fs.readFileSync(path.join(workspaceRoot, 'CLAUDE.md'), 'utf8')).catch(e => info(`CLAUDE.md SharePoint upload skipped: ${e.message}`));
      }
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
        solutions.map((s: any, i: number) => ({
          label: s.FriendlyName,
          description: `v${s.VersionNumber}`,
          detail: s.SolutionUniqueName,
          solution: s,
          picked: i < 5
        })),
        {
          title: 'Deep Scan — Step 2 of 3: Select solutions',
          placeHolder: 'First 5 are pre-selected — check/uncheck as needed',
          canPickMany: true
        }
      );
      if (!picks?.length) { return; }

      const selected = picks as any[];
      const estMins = selected.length;

      // Step 3: confirm
      const go = await vscode.window.showInformationMessage(
        `Scan ${selected.length} solution${selected.length > 1 ? 's' : ''} from "${envPick.env.FriendlyName}"?\n\nEstimated total: ~${estMins} min`,
        { modal: true }, 'Start Scan'
      );
      if (go !== 'Start Scan') { return; }

      // Step 4: run incrementally
      info(`Deep Scan started — ${selected.length} solutions from ${envPick.env.EnvironmentUrl}`);
      let done = 0, failed = 0;

      for (let i = 0; i < selected.length; i++) {
        const sol = selected[i].solution;

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
              generateClaudeMd(lib, solutionsRoot, workspaceRoot, context.extensionPath);
              libProvider.setLibrary(lib);
              info(`Library updated — ${lib.flowsScanned} flows indexed`);
              mergeAndUploadLibrary(lib).catch(e => info(`Library SharePoint sync skipped: ${e.message}`));
              if (workspaceRoot && fs.existsSync(path.join(workspaceRoot, 'CLAUDE.md'))) {
                spUpload('CLAUDE.md', fs.readFileSync(path.join(workspaceRoot, 'CLAUDE.md'), 'utf8')).catch(e => info(`CLAUDE.md SharePoint upload skipped: ${e.message}`));
              }
              provider.refresh();
            } catch (e: any) {
              failed++;
              error(`Deep Scan: failed on ${sol.SolutionUniqueName}`, e.message);
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
      // Bot pattern — snippet is already a raw string (YAML or JSON)
      const botPattern = node.payload?.botPattern;
      if (botPattern) {
        await vscode.env.clipboard.writeText(botPattern.snippet);
        vscode.window.showInformationMessage(`📋 Bot pattern copied — paste it into your topic YAML`);
        return;
      }
      // Flow action snippet
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
      const { flowPath, envId, envIsDefault, solutionId, solution, envUrl } = node.payload ?? {};

      // The default environment uses "Default-{envId}" in maker portal URLs; others use just envId
      const envSegment = envId ? (envIsDefault ? `Default-${envId}` : envId) : undefined;

      if (flowPath && envSegment) {
        // Flow node — extract the GUID from the filename
        const rawName = path.basename(flowPath, '.json');
        const guidMatch = rawName.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
        if (!guidMatch) {
          vscode.window.showErrorMessage('Could not extract flow GUID from filename. Expected format: FlowName-{GUID}.json');
          return;
        }
        const flowGuid = guidMatch[1].toLowerCase();
        const url = solutionId
          ? `https://make.powerautomate.com/environments/${envSegment}/solutions/${solutionId}/flows/${flowGuid}/details`
          : `https://make.powerautomate.com/environments/${envSegment}/flows/${flowGuid}`;
        await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }

      if (solution && envSegment) {
        const solId = solution.Id ?? solution.SolutionId;
        const url = solId
          ? `https://make.powerautomate.com/environments/${envSegment}/solutions/${solId}`
          : `https://make.powerautomate.com/environments/${envSegment}/solutions`;
        await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }

      if (envUrl) {
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
            generateClaudeMd(lib, solutionsRoot!, workspaceRoot, context.extensionPath);
            libProvider.setLibrary(lib);
            mergeAndUploadLibrary(lib).catch(e => info(`Library SharePoint sync skipped: ${e.message}`));
            if (workspaceRoot && fs.existsSync(path.join(workspaceRoot, 'CLAUDE.md'))) {
              spUpload('CLAUDE.md', fs.readFileSync(path.join(workspaceRoot, 'CLAUDE.md'), 'utf8')).catch(e => info(`CLAUDE.md SharePoint upload skipped: ${e.message}`));
            }
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

      // Offer to share FLOWS.md files to SharePoint
      const upload = await vscode.window.showInformationMessage(
        `Share FLOWS.md to SharePoint so your team can see it?`,
        'Upload to SharePoint', 'Skip'
      );
      if (upload === 'Upload to SharePoint') {
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Uploading FLOWS.md to SharePoint…', cancellable: false },
            async () => {
              for (const sol of solutionDocs) {
                const content = fs.readFileSync(sol.outPath, 'utf8');
                await spUpload(`solutions/${sol.solName}/FLOWS.md`, content);
                info(`Uploaded FLOWS.md for ${sol.solName} to SharePoint`);
              }
            }
          );
          vscode.window.showInformationMessage('✅ FLOWS.md uploaded — teammates can now pull the latest docs.');
        } catch (e: any) {
          error('FLOWS.md SharePoint upload failed', e.message);
          vscode.window.showErrorMessage(`SharePoint upload failed: ${e.message}`);
        }
      }
    }),

    // ── Flow run history ─────────────────────────────────────────────────────
    vscode.commands.registerCommand('dxt-power-automate-toolkit.viewFlowRuns', async (node: PowerAutomateNode) => {
      const { flowPath, envUrl, solution } = node?.payload ?? {};
      if (!flowPath || !envUrl) {
        vscode.window.showWarningMessage('Select a flow from the Environments panel first.');
        return;
      }

      // Extract flow GUID from filename
      const rawName = path.basename(flowPath, '.json');
      const guidMatch = rawName.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
      if (!guidMatch) {
        vscode.window.showErrorMessage('Could not extract flow ID from filename.');
        return;
      }
      const flowId = guidMatch[1];
      const flowName = rawName.replace(/-[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/i, '').replace(/-/g, ' ');

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Loading runs for "${flowName}"…`, cancellable: false },
        async () => {
          try {
            info(`Flow runs: resolving environment for ${envUrl}`);
            const envName = await resolveEnvName(envUrl);
            if (!envName) {
              vscode.window.showErrorMessage(
                `Could not match environment "${envUrl}" to a Power Automate environment. ` +
                `Make sure the "Flows.Read.All" permission is granted for the app registration.`
              );
              return;
            }

            info(`Flow runs: fetching for flow ${flowId} in ${envName}`);
            const runs = await getFlowRuns(envName, flowId, 20);

            if (!runs.length) {
              vscode.window.showInformationMessage(`No runs found for "${flowName}" — the flow may not have run yet.`);
              return;
            }

            info(`Flow runs: opening panel with ${runs.length} run(s)`);
            openFlowRunsPanel(context, flowName, runs, (runId) =>
              getFlowRunDetail(envName, flowId, runId)
            );
          } catch (e: any) {
            error('Flow runs: failed', e.message);
            vscode.window.showErrorMessage(`Could not load flow runs: ${e.message}`);
          }
        }
      );
    }),

    // ── Discover SharePoint sites & lists ────────────────────────────────────
    vscode.commands.registerCommand('dxt-power-automate-toolkit.discoverSharePoint', async () => {
      if (!workspaceRoot) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'SharePoint Discovery', cancellable: true },
        async (progress, token) => {

          // ── Phase 1: list sites ──────────────────────────────────────────
          progress.report({ message: 'Listing accessible sites…' });
          info('=== SharePoint Discovery started ===');
          let sites: import('./sharepoint').SpSite[];
          try {
            sites = await spDiscoverSites();
          } catch (e: any) {
            error('SharePoint discovery failed at site listing', e.message);
            vscode.window.showErrorMessage(`Discovery failed: ${e.message}`);
            return;
          }

          if (token.isCancellationRequested) { info('Discovery cancelled by user after site listing'); return; }

          if (!sites.length) {
            vscode.window.showWarningMessage('No SharePoint sites found for your account.');
            return;
          }

          // ── Phase 2: let user pick which sites to scan ───────────────────
          type SiteItem = vscode.QuickPickItem & { site: import('./sharepoint').SpSite };
          const siteItems: SiteItem[] = sites.map(s => ({
            label: s.displayName,
            description: s.webUrl,
            picked: s.webUrl.includes('Omni-Channel'),
            site: s,
          }));

          const picked = await vscode.window.showQuickPick(siteItems, {
            title: `Found ${sites.length} site(s) — select which to scan for lists`,
            canPickMany: true,
            placeHolder: 'Space to select/deselect, Enter to confirm',
          });

          if (!picked?.length) { info('Discovery cancelled — no sites selected'); return; }
          if (token.isCancellationRequested) { info('Discovery cancelled by user'); return; }

          info(`Scanning lists in ${picked.length} site(s): ${picked.map(p => p.label).join(', ')}`);

          // ── Phase 3: scan lists + columns per site ───────────────────────
          const result: Array<{
            id: string; displayName: string; webUrl: string;
            lists: Array<{ id: string; displayName: string; name: string; columns: import('./sharepoint').SpColumn[] }>;
          }> = [];

          for (const item of picked) {
            if (token.isCancellationRequested) { info('Discovery cancelled mid-scan'); break; }

            const s = item.site;
            progress.report({ message: `Scanning "${s.displayName}"…` });
            info(`--- Scanning site: ${s.displayName} ---`);

            let lists: import('./sharepoint').SpList[];
            try {
              lists = await spDiscoverLists(s.id);
            } catch (e: any) {
              error(`Could not list lists in "${s.displayName}"`, e.message);
              continue;
            }

            if (!lists.length) {
              info(`No lists found in "${s.displayName}"`);
              result.push({ ...s, lists: [] });
              continue;
            }

            const enrichedLists: typeof result[number]['lists'] = [];
            for (const list of lists) {
              if (token.isCancellationRequested) { break; }
              progress.report({ message: `"${s.displayName}" → "${list.displayName}"…` });
              info(`  Getting columns for list: ${list.displayName}`);
              let columns: import('./sharepoint').SpColumn[] = [];
              try {
                columns = await spDiscoverColumns(s.id, list.id);
                info(`    ${columns.length} column(s): ${columns.map(c => c.name).join(', ')}`);
              } catch (e: any) {
                info(`    Could not get columns: ${e.message}`);
              }
              enrichedLists.push({ ...list, columns });
            }
            result.push({ ...s, lists: enrichedLists });
          }

          if (!result.length) { info('Discovery complete — no data to save'); return; }

          // ── Phase 4: save to sharepoint-context.json ─────────────────────
          const totalLists = result.reduce((n, s) => n + s.lists.length, 0);
          const totalCols  = result.reduce((n, s) => n + s.lists.reduce((m, l) => m + l.columns.length, 0), 0);
          info(`=== Discovery complete: ${result.length} site(s), ${totalLists} list(s), ${totalCols} column(s) ===`);

          const outPath = path.join(workspaceRoot, 'sharepoint-context.json');
          const payload = { discoveredAt: new Date().toISOString(), sites: result };
          fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
          info(`Saved → ${outPath}`);

          // Open the file so the user can review it
          const doc = await vscode.workspace.openTextDocument(outPath);
          await vscode.window.showTextDocument(doc);

          const action = await vscode.window.showInformationMessage(
            `✅ Discovered ${totalLists} lists across ${result.length} site(s). Review the file — delete anything sensitive — then share to SharePoint?`,
            'Upload to SharePoint', 'Keep local only'
          );
          if (action === 'Upload to SharePoint') {
            try {
              await mergeAndUploadContext('sharepoint-context.json', fs.readFileSync(outPath, 'utf8'));
              info('sharepoint-context.json merged and uploaded to SharePoint');
              vscode.window.showInformationMessage('✅ SharePoint context uploaded — teammates will get it automatically.');
            } catch (e: any) {
              error('SharePoint context upload failed', e.message);
              vscode.window.showErrorMessage(`Upload failed: ${e.message}`);
            }
          }
        }
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
      const upload = await vscode.window.showInformationMessage(
        'Edit company-context.json with your organisation\'s brands, terms and systems, then save. Share it to SharePoint so your teammates get the same knowledge automatically?',
        'Upload to SharePoint', 'Keep local only'
      );
      if (upload === 'Upload to SharePoint') {
        try {
          await mergeAndUploadContext('company-context.json', fs.readFileSync(filePath, 'utf8'));
          vscode.window.showInformationMessage('✅ Company context merged & uploaded — teammates will get it on next refresh.');
          info('Company context merged and uploaded to SharePoint via setupContext');
        } catch (e: any) {
          error('Company context SharePoint upload failed', e.message);
          vscode.window.showWarningMessage(`SharePoint upload failed: ${e.message}`);
        }
      }
    }),

    // ── Dataverse: check import dependencies ─────────────────────────────────
    vscode.commands.registerCommand('dxt-power-automate-toolkit.checkDependencies', async (node: PowerAutomateNode) => {
      const { solution, envUrl: sourceEnvUrl } = node?.payload ?? {};
      if (!solution || !sourceEnvUrl) { return; }

      let envs: Awaited<ReturnType<typeof listEnvironments>>;
      try {
        envs = await listEnvironments();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Could not load environments: ${e.message}`);
        return;
      }

      const targetPick = await vscode.window.showQuickPick(
        envs
          .filter(e => e.EnvironmentUrl !== sourceEnvUrl)
          .map(e => ({ label: e.FriendlyName, detail: e.EnvironmentUrl, env: e })),
        { title: `Check dependencies — import "${solution.FriendlyName}" into which environment?` }
      );
      if (!targetPick) { return; }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Checking dependencies…`, cancellable: false },
        async () => {
          try {
            const { dvCheckDependencies } = await import('./dataverseApi');
            const result = await dvCheckDependencies(sourceEnvUrl, solution.SolutionUniqueName, targetPick.env.EnvironmentUrl);
            const panel = vscode.window.createWebviewPanel('dxt-deps', `Dependencies — ${solution.FriendlyName}`, vscode.ViewColumn.One, {});
            const missingRows = result.missing.map(r =>
              `<tr><td class="icon">✗</td><td class="name">${r.connectionreferencedisplayname}</td><td class="schema">${r.connectionreferencelogicalname}</td><td class="status miss">Missing</td></tr>`
            ).join('');
            const presentRows = result.present.map(r =>
              `<tr><td class="icon">✓</td><td class="name">${r.connectionreferencedisplayname}</td><td class="schema">${r.connectionreferencelogicalname}</td><td class="status ok">Present</td></tr>`
            ).join('');
            panel.webview.html = `<!doctype html><html><head><meta charset="UTF-8">
<style>
body{font:13px/1.5 'Segoe UI',sans-serif;background:#1e1e1e;color:#ccc;padding:16px}
h1{font-size:15px;margin-bottom:4px}
.meta{color:#888;font-size:11px;margin-bottom:16px}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:6px 8px;border-bottom:1px solid #3c3c3c;color:#888;font-size:11px;text-transform:uppercase}
td{padding:6px 8px;border-bottom:1px solid #2a2a2a}
.icon{width:24px;font-size:16px}
.schema{font-family:monospace;font-size:11px;color:#888}
.status{font-size:11px;font-weight:600}
.miss{color:#f48771}.ok{color:#4ec9b0}
.summary{display:flex;gap:16px;margin-bottom:16px}
.pill{padding:4px 12px;border-radius:12px;font-size:12px;font-weight:600}
.pill.miss{background:rgba(244,135,113,.15);color:#f48771}
.pill.ok{background:rgba(78,201,176,.15);color:#4ec9b0}
</style></head><body>
<h1>Import Dependencies — ${solution.FriendlyName}</h1>
<div class="meta">Source: ${sourceEnvUrl}<br>Target: ${targetPick.env.EnvironmentUrl}</div>
<div class="summary">
  <span class="pill miss">✗ ${result.missing.length} Missing</span>
  <span class="pill ok">✓ ${result.present.length} Present</span>
</div>
<table>
<thead><tr><th></th><th>Connection Reference</th><th>Logical Name</th><th>Status</th></tr></thead>
<tbody>${missingRows}${presentRows}</tbody>
</table>
${result.missing.length ? `<p style="margin-top:16px;color:#f48771;font-size:12px">⚠ Create the missing connections in <b>${targetPick.label}</b> before importing this solution, then map them during import.</p>` : `<p style="margin-top:16px;color:#4ec9b0;font-size:12px">✅ All connection references are present — this solution should import cleanly.</p>`}
</body></html>`;
            info(`Dependency check: ${result.missing.length} missing, ${result.present.length} present`);
          } catch (e: any) {
            error('Dependency check failed', e.message);
            vscode.window.showErrorMessage(`Dependency check failed: ${e.message}`);
          }
        }
      );
    }),

    // ── Dataverse: manage environment variables ──────────────────────────────
    vscode.commands.registerCommand('dxt-power-automate-toolkit.manageEnvVars', async (node: PowerAutomateNode) => {
      const { solution, envUrl } = node?.payload ?? {};
      if (!solution || !envUrl) { return; }
      const { openEnvVarPanel } = await import('./envVarPanel');
      await openEnvVarPanel(context, solution.FriendlyName, solution.SolutionUniqueName, envUrl);
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

    // ── Build & share cloud index ─────────────────────────────────────────────
    vscode.commands.registerCommand('dxt-power-automate-toolkit.buildCloudIndex', async () => {
      let envs: Awaited<ReturnType<typeof listEnvironments>>;
      try {
        envs = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Cloud Index: loading environments…', cancellable: false },
          () => listEnvironments()
        );
      } catch (e: any) {
        vscode.window.showErrorMessage(`Could not load environments: ${e.message}`);
        return;
      }

      let index: Awaited<ReturnType<typeof buildCloudIndex>>;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Building cloud index…', cancellable: false },
        async (progress) => {
          // Find solution names that already have FLOWS.md on SharePoint
          const sharedFolders = await spListFolder('solutions').catch(() => [] as string[]);
          const sharedDocNames = new Set(sharedFolders);

          index = await buildCloudIndex(
            envs,
            solutionsRoot,
            (msg) => { progress.report({ message: msg }); info(`Cloud Index: ${msg}`); },
            sharedDocNames
          );
        }
      );

      const markdown = renderIndexMarkdown(index!);

      // Save locally so AI can read it in this workspace
      if (workspaceRoot) {
        fs.writeFileSync(path.join(workspaceRoot, 'DXT_CLOUD_INDEX.md'), markdown, 'utf8');
      }

      // Upload to SharePoint
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Uploading to SharePoint…', cancellable: false },
          async () => {
            await spUpload('cloud-index.md', markdown);
            info('Cloud index uploaded to SharePoint');
            // Also upload company context so teammates get the same domain knowledge
            if (workspaceRoot) {
              const ctxPath = path.join(workspaceRoot, 'company-context.json');
              if (fs.existsSync(ctxPath)) {
                await mergeAndUploadContext('company-context.json', fs.readFileSync(ctxPath, 'utf8'));
                info('Company context merged and uploaded to SharePoint');
              }
            }
          }
        );
        vscode.window.showInformationMessage('✅ Cloud index and company context shared on SharePoint — teammates will see it on next refresh.');
      } catch (e: any) {
        error('SharePoint upload failed', e.message);
        vscode.window.showWarningMessage(`Saved locally but SharePoint upload failed: ${e.message}`);
      }
    }),

    // ── Pull latest shared index from SharePoint ──────────────────────────────
    vscode.commands.registerCommand('dxt-power-automate-toolkit.pullSharedIndex', async () => {
      if (!workspaceRoot) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      try {
        let pulled = 0;
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Pulling latest files from SharePoint…', cancellable: false },
          async (progress) => {
            // Cloud index
            progress.report({ message: 'cloud index…' });
            const indexContent = await spDownload('cloud-index.md');
            if (indexContent) {
              fs.writeFileSync(path.join(workspaceRoot!, 'DXT_CLOUD_INDEX.md'), indexContent, 'utf8');
              pulled++;
              info('Cloud index pulled from SharePoint');
            }
            // Company context — merge shared into local so neither side loses data
            progress.report({ message: 'company context…' });
            const ctxContent = await spDownload('company-context.json');
            if (ctxContent) {
              const ctxPath = path.join(workspaceRoot!, 'company-context.json');
              const local = fs.existsSync(ctxPath) ? fs.readFileSync(ctxPath, 'utf8') : null;
              const merged = local
                ? JSON.stringify(deepMergeJson(JSON.parse(ctxContent), JSON.parse(local)), null, 2)
                : ctxContent;
              fs.writeFileSync(ctxPath, merged, 'utf8');
              companyCtx = loadCompanyContext(workspaceRoot!);
              pulled++;
              info('Company context merged from SharePoint');
            }
          }
        );

        if (!pulled) {
          vscode.window.showInformationMessage('Nothing found on SharePoint yet. Ask a teammate to run "Build & Share Cloud Index" first.');
          return;
        }
        const doc = await vscode.workspace.openTextDocument(path.join(workspaceRoot!, 'DXT_CLOUD_INDEX.md'));
        await vscode.window.showTextDocument(doc);
        vscode.window.showInformationMessage(`✅ Pulled ${pulled} file${pulled !== 1 ? 's' : ''} from SharePoint — cloud index and company context are up to date.`);
      } catch (e: any) {
        error('Pull from SharePoint failed', e.message);
        vscode.window.showErrorMessage(`Could not pull from SharePoint: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand('dxt-power-automate-toolkit.newSolution', async (node?: PowerAutomateNode) => {
      if (!solutionsRoot) {
        vscode.window.showWarningMessage('Open a workspace folder before creating a solution.');
        return;
      }

      // Determine target environment — pre-filled when called from an environment node
      let envUrl: string;
      let envFriendlyName: string;

      if (node?.payload?.environment) {
        envUrl = node.payload.environment.EnvironmentUrl;
        envFriendlyName = node.payload.environment.FriendlyName;
      } else {
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
        envUrl = envPick.env.EnvironmentUrl;
        envFriendlyName = envPick.env.FriendlyName;
      }

      const titlePrefix = `New Solution in ${envFriendlyName}`;

      // Display name
      const displayName = await vscode.window.showInputBox({
        title: titlePrefix,
        prompt: 'Solution display name',
        placeHolder: 'e.g. PPP - My New Flow',
        validateInput: v => v?.trim() ? undefined : 'Required'
      });
      if (!displayName) { return; }

      // Unique name (auto-generated, editable)
      const autoUnique = displayName.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
      const uniqueName = await vscode.window.showInputBox({
        title: titlePrefix,
        prompt: 'Solution unique name (no spaces or special characters)',
        value: autoUnique,
        validateInput: v => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(v ?? '') ? undefined : 'Must start with a letter, letters/numbers/underscores only'
      });
      if (!uniqueName) { return; }

      // Publisher — pick from known publishers or enter manually
      type PubItem = vscode.QuickPickItem & { prefix: string; uniqueName: string; displayName: string };
      const KNOWN_PUBLISHERS: PubItem[] = [
        { label: 'Digital Transformation', description: 'dta', detail: 'Recommended — existing DTA publisher', prefix: 'dta', uniqueName: 'dta', displayName: 'Digital Transformation' },
        { label: 'PrepayPower', description: 'ppp', detail: 'PrepayPower brand publisher', prefix: 'ppp', uniqueName: 'prepaypower', displayName: 'PrepayPower' },
      ];
      // Merge company context brands as additional options
      const brandPubs: PubItem[] = (companyCtx?.brands ?? [])
        .filter(b => !KNOWN_PUBLISHERS.some(kp => kp.prefix === b.prefix.toLowerCase()))
        .map(b => ({ label: b.name, description: b.prefix.toLowerCase(), detail: b.description, prefix: b.prefix.toLowerCase(), uniqueName: b.prefix.toLowerCase(), displayName: b.name }));
      const customPubItem: PubItem = { label: '$(edit) Custom publisher…', description: '', detail: 'Enter prefix and unique name manually', prefix: '', uniqueName: '', displayName: '' };
      const pubPick = await vscode.window.showQuickPick([...KNOWN_PUBLISHERS, ...brandPubs, customPubItem], {
        title: `${titlePrefix} — Publisher`,
        placeHolder: 'Select the publisher for this solution',
      });
      if (!pubPick) { return; }

      let publisherPrefix: string;
      let publisherUniqueName: string;
      let publisherDisplayName: string;

      if (pubPick.prefix) {
        publisherPrefix     = pubPick.prefix;
        publisherUniqueName = pubPick.uniqueName;
        publisherDisplayName = pubPick.displayName;
      } else {
        const prefixInput = await vscode.window.showInputBox({
          title: titlePrefix,
          prompt: 'Publisher prefix (must match an existing publisher prefix in the environment)',
          value: 'dta',
          validateInput: v => /^[a-z][a-z0-9]{1,7}$/.test(v ?? '') ? undefined : '2-8 lowercase letters/numbers, must start with a letter'
        });
        if (!prefixInput) { return; }
        const uniqueInput = await vscode.window.showInputBox({
          title: titlePrefix,
          prompt: 'Publisher unique name (exact value from the environment — check Power Apps → Publishers)',
          value: prefixInput,
          validateInput: v => /^[a-z][a-z0-9]{1,99}$/.test(v ?? '') ? undefined : 'Lowercase letters and numbers only, must start with a letter'
        });
        if (!uniqueInput) { return; }
        const displayInput = await vscode.window.showInputBox({
          title: titlePrefix,
          prompt: 'Publisher display name',
          value: prefixInput,
        });
        if (!displayInput) { return; }
        publisherPrefix      = prefixInput;
        publisherUniqueName  = uniqueInput;
        publisherDisplayName = displayInput;
      }

      // Starter flow — the org-mandated Try/Catch + error-email template
      type StarterItem = vscode.QuickPickItem & { trigger?: TriggerType };
      const starterPick = await vscode.window.showQuickPick<StarterItem>([
        { label: '$(play) Manual / Button', description: 'Recommended', detail: 'Starter flow with org-mandated Try/Catch + error email', trigger: 'Manual' },
        { label: '$(globe) HTTP Request', detail: 'Starter flow triggered by an HTTP request (webhooks, bots)', trigger: 'HTTP' },
        { label: '$(clock) Scheduled (daily)', detail: 'Starter flow on a daily recurrence', trigger: 'Scheduled' },
        { label: '$(circle-slash) Skip', detail: 'Create an empty solution with no starter flow' },
      ], { title: `${titlePrefix} — Starter flow`, placeHolder: 'Add a starter flow to the new solution?' });
      if (!starterPick) { return; }
      const starter = starterPick.trigger ? { trigger: starterPick.trigger } : undefined;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Creating solution "${displayName}"…`, cancellable: false },
        async (progress) => {
          progress.report({ message: 'See Output panel for progress' });
          try {
            info(`Creating solution: ${uniqueName} in ${envUrl}`);
            info(`Publisher: ${publisherDisplayName} (prefix=${publisherPrefix}, uniqueName=${publisherUniqueName})`);
            await createSolution(envUrl, uniqueName, displayName, publisherPrefix, publisherDisplayName, publisherUniqueName, solutionsRoot!, starter);
            info(`Solution created: ${uniqueName}`);
            vscode.window.showInformationMessage(
              starter
                ? `✅ Solution "${displayName}" created in ${envFriendlyName}. Map the Office 365 connection in the PA portal, then turn the starter flow on.`
                : `✅ Solution "${displayName}" created in ${envFriendlyName}`
            );
            provider.refresh();
          } catch (e: any) {
            error(`Create solution failed: ${uniqueName}`, e.message);
            vscode.window.showErrorMessage(`❌ Create failed: ${e.message}`);
          }
        }
      );
    }),

    // ── Add template flow to an existing local solution ──────────────────────
    vscode.commands.registerCommand('dxt-power-automate-toolkit.addTemplateFlow', async (node: PowerAutomateNode) => {
      const { solution, solutionLocalDir, envUrl } = node?.payload ?? {};
      if (!solutionLocalDir || !solution) { return; }

      const solutionXmlPath = path.join(solutionLocalDir, 'Other', 'Solution.xml');
      if (!fs.existsSync(solutionXmlPath)) {
        vscode.window.showWarningMessage('Could not find Solution.xml — make sure this solution has been exported locally first.');
        return;
      }

      type TriggerItem = vscode.QuickPickItem & { trigger: TriggerType };
      const triggerPick = await vscode.window.showQuickPick<TriggerItem>([
        { label: '$(play) Manual / Button', description: 'Recommended', detail: 'Org-mandated Try/Catch + error email, triggered manually', trigger: 'Manual' },
        { label: '$(globe) HTTP Request', detail: 'Triggered by an HTTP request (webhooks, bots)', trigger: 'HTTP' },
        { label: '$(clock) Scheduled (daily)', detail: 'Daily recurrence trigger', trigger: 'Scheduled' },
      ], { title: `Add Template Flow to ${solution.FriendlyName}`, placeHolder: 'Choose the trigger type' });
      if (!triggerPick) { return; }

      const description = await vscode.window.showInputBox({
        title: `Add Template Flow to ${solution.FriendlyName}`,
        prompt: 'Short description for the flow name (optional)',
        placeHolder: 'e.g. Process Meter Alerts — leave empty for "Starter Flow"',
      });
      if (description === undefined) { return; }

      const { guid: flowGuid, fileName, displayName: flowName } = writeTemplateFlow(
        solutionLocalDir,
        solution.FriendlyName,
        { trigger: triggerPick.trigger, description: description || undefined }
      );
      addWorkflowComponent(solutionLocalDir, flowGuid, flowName, fileName);
      info(`Template flow added to ${solution.SolutionUniqueName} (${flowGuid})`);
      provider.refresh();

      const action = await vscode.window.showInformationMessage(
        `✅ Template flow added locally to "${solution.FriendlyName}". Import the solution now to push it to the environment?`,
        'Import Now', 'Later'
      );

      if (action === 'Import Now' && envUrl) {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Importing "${solution.FriendlyName}"…`, cancellable: false },
          async (progress) => {
            progress.report({ message: 'Packing… See Output panel for live progress' });
            try {
              await packAndImport(envUrl, solution.SolutionUniqueName, solutionLocalDir);
              vscode.window.showInformationMessage(`✅ "${solution.FriendlyName}" imported. Map the DT Error Tracker connection in the PA portal, then turn the template flow on.`);
            } catch (e: any) {
              error(`Template flow import failed: ${solution.SolutionUniqueName}`, e.message);
              vscode.window.showErrorMessage(`❌ Import failed: ${e.message}`);
            }
          }
        );
      }
    }),

    // ── Add solution to environment (inline + button on environment nodes) ──
    vscode.commands.registerCommand('dxt-power-automate-toolkit.addToEnvironment', async (node: PowerAutomateNode) => {
      const { environment } = node?.payload ?? {};
      if (!environment) { return; }

      const envUrl = environment.EnvironmentUrl;
      const envName = environment.FriendlyName;

      type ActionItem = vscode.QuickPickItem & { id: string };
      const action = await vscode.window.showQuickPick<ActionItem>([
        { label: '$(add) New Solution', description: 'Scaffold a new solution locally and register it in this environment', id: 'new' },
        { label: '$(cloud-upload) Import Local Solution', description: 'Pick an existing local solution folder and pack+import it to this environment', id: 'import' },
      ], { title: `Add to ${envName}` });
      if (!action) { return; }

      if (action.id === 'new') {
        await vscode.commands.executeCommand('dxt-power-automate-toolkit.newSolution', node);
        return;
      }

      // ── Import local solution ────────────────────────────────────────────
      if (!solutionsRoot || !fs.existsSync(solutionsRoot)) {
        vscode.window.showWarningMessage('No local solutions folder found. Export at least one solution first, or create a new one.');
        return;
      }

      const localDirs = fs.readdirSync(solutionsRoot, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .map(d => d.name);

      if (!localDirs.length) {
        vscode.window.showInformationMessage('No local solution folders found in the solutions directory.');
        return;
      }

      type SolItem = vscode.QuickPickItem & { dirName: string };
      const items: SolItem[] = localDirs.map(dir => {
        const wfDir = path.join(solutionsRoot!, dir, 'Workflows');
        let flowCount = 0;
        try { if (fs.existsSync(wfDir)) { flowCount = fs.readdirSync(wfDir).filter(f => f.endsWith('.json')).length; } }
        catch { /* ignore */ }
        return {
          label: `$(folder) ${dir}`,
          description: flowCount ? `${flowCount} flow${flowCount !== 1 ? 's' : ''}` : 'no flows yet',
          dirName: dir,
        };
      });

      const picks = await vscode.window.showQuickPick(items, {
        title: `Import Local Solution to ${envName}`,
        placeHolder: 'Select one or more solution folders to import',
        canPickMany: true,
      });
      if (!picks?.length) { return; }

      const confirm = await vscode.window.showWarningMessage(
        `Import ${picks.length} solution${picks.length !== 1 ? 's' : ''} to "${envName}"? Existing solutions will be upgraded.`,
        { modal: true },
        'Import'
      );
      if (confirm !== 'Import') { return; }

      let done = 0, failed = 0;
      for (const pick of picks) {
        const localDir = path.join(solutionsRoot!, pick.dirName);
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Importing "${pick.dirName}" to ${envName}…`, cancellable: false },
          async (progress) => {
            progress.report({ message: 'Packing… See Output panel for live progress' });
            try {
              info(`Import local: packing and importing ${pick.dirName} to ${envUrl}`);
              await packAndImport(envUrl, pick.dirName, localDir);
              done++;
              info(`Import local: completed ${pick.dirName}`);
            } catch (e: any) {
              failed++;
              error(`Import local: failed for ${pick.dirName}`, e.message);
              vscode.window.showErrorMessage(`❌ Import failed for "${pick.dirName}": ${e.message}`);
            }
          }
        );
      }

      vscode.window.showInformationMessage(
        `✅ Import complete — ${done} imported${failed ? `, ${failed} failed` : ''}`
      );
      provider.refresh();
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

