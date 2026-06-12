import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as log from './log';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface PacEnvironment {
  FriendlyName: string;
  OrganizationId: string;
  EnvironmentUrl: string;
  EnvironmentIdentifier: {
    Type: number;
    Id: string;
    IsDefault: boolean;
  };
  Geo: string;
}

export interface PacSolution {
  SolutionUniqueName: string;
  FriendlyName: string;
  VersionNumber: string;
  IsManaged: boolean;
}

let resolvedPacPath: string | null = null;

export async function initPacPath(context: vscode.ExtensionContext): Promise<void> {
  // 1. VS Code setting override
  const configured = vscode.workspace.getConfiguration('dxt-power-automate').get<string>('pacCliPath')?.trim();
  if (configured) {
    if (fs.existsSync(configured)) {
      resolvedPacPath = configured;
      log.info(`pac path from settings: ${configured}`);
      return;
    }
    log.error(`pacCliPath setting points to a file that doesn't exist: ${configured}`);
  }

  // 2. Power Platform extension global storage
  const globalStorageRoot = path.dirname(context.globalStorageUri.fsPath);
  const ppExtIds = [
    'microsoft-isvexptools.powerplatform-vscode',
    'microsoft-isvexptools.powerapps-tools',
    'ms-powerplatform.vscode-powerplatform-extension',
  ];
  for (const extId of ppExtIds) {
    const candidate = path.join(globalStorageRoot, extId, 'pac', 'tools', 'pac.exe');
    log.info(`Checking: ${candidate}`);
    if (fs.existsSync(candidate)) {
      resolvedPacPath = candidate;
      log.info(`pac found in Power Platform global storage: ${candidate}`);
      return;
    }
  }

  // 3. Try Get-Command WITH profile
  try {
    const { stdout } = await execAsync(
      `powershell.exe -Command "(Get-Command pac -ErrorAction SilentlyContinue).Source"`,
      { timeout: 15000, windowsHide: true }
    );
    const found = stdout.trim();
    if (found && found.toLowerCase().endsWith('.exe') && fs.existsSync(found)) {
      resolvedPacPath = found;
      log.info(`pac auto-detected via Get-Command: ${found}`);
      return;
    }
  } catch (e: any) {
    log.info(`Get-Command pac failed: ${e.message}`);
  }

  log.error(
    'pac CLI not found. Run "(Get-Command pac).Source" in your terminal, ' +
    'then set the result as "dxt-power-automate.pacCliPath" in VS Code settings.'
  );
}

// Fast commands (list, unpack, pack) — returns stdout
async function runPac(args: string[]): Promise<string> {
  if (!resolvedPacPath) {
    throw new Error('pac CLI path not resolved. Check the Output channel for details.');
  }
  const displayCmd = `pac ${args.join(' ')}`;
  log.info(`Running: ${displayCmd}`);
  try {
    const { stdout, stderr } = await execFileAsync(resolvedPacPath, args, {
      windowsHide: true,
      timeout: 120000,
    });
    log.command(displayCmd, stdout, stderr);
    return stdout;
  } catch (e: any) {
    const detail = e.stderr?.trim() || e.stdout?.trim() || e.message;
    log.error(`pac command failed: ${displayCmd}`, detail);
    throw new Error(detail);
  }
}

// Long-running commands (export, import) — streams stdout live to Output channel
function runPacLong(args: string[], timeoutMs = 600000): Promise<void> {
  if (!resolvedPacPath) {
    return Promise.reject(new Error('pac CLI path not resolved.'));
  }
  const displayCmd = `pac ${args.join(' ')}`;
  log.info(`Running: ${displayCmd}`);

  return new Promise((resolve, reject) => {
    const proc = spawn(resolvedPacPath!, args, { windowsHide: true });
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').map(l => l.trim()).filter(Boolean);
      lines.forEach(l => log.info(`  ${l}`));
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Timed out after ${timeoutMs / 60000} min — ${displayCmd}`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      log.info(`  exit code: ${code}`);
      if (code === 0) {
        resolve();
      } else {
        const detail = stderr.trim() || `Process exited with code ${code}`;
        log.error(`pac command failed: ${displayCmd}`, detail);
        reject(new Error(detail));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function extractJson<T>(raw: string): T {
  const match = raw.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (!match) {
    throw new Error(`Unexpected pac output (no JSON found): ${raw.slice(0, 300)}`);
  }
  return JSON.parse(match[1]) as T;
}

export async function listEnvironments(): Promise<PacEnvironment[]> {
  const raw = await runPac(['env', 'list', '--json']);
  const data = extractJson<PacEnvironment[] | { value: PacEnvironment[] }>(raw);
  return Array.isArray(data) ? data : data.value;
}

export async function listSolutions(envUrl: string): Promise<PacSolution[]> {
  const raw = await runPac(['solution', 'list', '--environment', envUrl, '--json']);
  const data = extractJson<PacSolution[] | { value: PacSolution[] }>(raw);
  return Array.isArray(data) ? data : data.value;
}

export async function exportAndUnpack(envUrl: string, solutionName: string, solutionsRoot: string): Promise<void> {
  if (!fs.existsSync(solutionsRoot)) {
    fs.mkdirSync(solutionsRoot, { recursive: true });
  }
  const zipPath = path.join(solutionsRoot, `${solutionName}.zip`);
  const unpackDir = path.join(solutionsRoot, solutionName);
  // Remove stale zip so pac doesn't refuse to overwrite it
  if (fs.existsSync(zipPath)) { fs.unlinkSync(zipPath); }
  await runPacLong(['solution', 'export', '--environment', envUrl, '--name', solutionName, '--path', zipPath]);
  await runPac(['solution', 'unpack', '--zipFile', zipPath, '--folder', unpackDir, '--allowDelete', 'true']);
}

export async function packAndImport(envUrl: string, solutionName: string, solutionLocalDir: string): Promise<void> {
  const zipPath = path.join(path.dirname(solutionLocalDir), `${solutionName}_packed.zip`);
  await runPac(['solution', 'pack', '--zipFile', zipPath, '--folder', solutionLocalDir]);
  await runPacLong(['solution', 'import', '--environment', envUrl, '--path', zipPath]);
}

export function listLocalFlows(solutionLocalDir: string): string[] {
  const workflowsDir = path.join(solutionLocalDir, 'Workflows');
  if (!fs.existsSync(workflowsDir)) { return []; }
  return fs.readdirSync(workflowsDir)
    .filter(f => f.endsWith('.json'))
    .map(f => path.basename(f, '.json'));
}

export async function createSolution(
  envUrl: string,
  uniqueName: string,
  displayName: string,
  publisherPrefix: string,
  publisherName: string,
  solutionsRoot: string
): Promise<void> {
  const solutionDir = path.join(solutionsRoot, uniqueName);
  const otherDir = path.join(solutionDir, 'Other');
  fs.mkdirSync(otherDir, { recursive: true });

  fs.writeFileSync(path.join(otherDir, 'Solution.xml'), solutionXml(uniqueName, displayName, publisherPrefix, publisherName), 'utf8');
  fs.writeFileSync(path.join(otherDir, 'customizations.xml'), CUSTOMIZATIONS_XML, 'utf8');

  const zipPath = path.join(solutionsRoot, `${uniqueName}_new.zip`);
  await runPac(['solution', 'pack', '--zipFile', zipPath, '--folder', solutionDir]);
  await runPacLong(['solution', 'import', '--environment', envUrl, '--path', zipPath]);
}

function solutionXml(uniqueName: string, displayName: string, publisherPrefix: string, publisherName: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.2.24021.183" SolutionPackageVersion="9.2" languagecode="1033" generatedBy="CrmLive" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <SolutionManifest>
    <UniqueName>${uniqueName}</UniqueName>
    <LocalizedNames>
      <LocalizedName description="${displayName}" languagecode="1033"/>
    </LocalizedNames>
    <Descriptions/>
    <Version>1.0.0.0</Version>
    <Managed>0</Managed>
    <Publisher>
      <UniqueName>${publisherPrefix}</UniqueName>
      <LocalizedNames>
        <LocalizedName description="${publisherName}" languagecode="1033"/>
      </LocalizedNames>
      <Descriptions/>
      <EMailAddress/>
      <SupportingWebsiteUrl/>
      <CustomizationPrefix>${publisherPrefix}</CustomizationPrefix>
      <CustomizationOptionValuePrefix>10000</CustomizationOptionValuePrefix>
      <Addresses>
        <Address>
          <AddressNumber>1</AddressNumber>
          <AddressTypeCode>1</AddressTypeCode>
          <City/><County/><Country/><Fax/>
          <FreightTermsCode/>
          <ImportSequenceNumber>0</ImportSequenceNumber>
          <Latitude>0</Latitude><Longitude>0</Longitude>
          <Name/><PostalCode/><PrimaryContactName/>
          <ShippingMethodCode>1</ShippingMethodCode>
          <StateOrProvince/><Telephone1/><Telephone2/><Telephone3/>
          <TimeZoneCode>0</TimeZoneCode>
          <UPSZone/><UTCOffset>0</UTCOffset>
          <Line1/><Line2/><Line3/>
        </Address>
      </Addresses>
    </Publisher>
    <RootComponents/>
    <MissingDependencies/>
  </SolutionManifest>
</ImportExportXml>`;
}

const CUSTOMIZATIONS_XML = `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.2.24021.183" SolutionPackageVersion="9.2" languagecode="1033" generatedBy="CrmLive" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Entities/><Roles/><Workflows/><FieldSecurityProfiles/>
  <Templates/><EntityMaps/><EntityRelationships/>
  <OrganizationSettings/><optionsets/><CustomControls/><EntityDataProviders/>
</ImportExportXml>`;
