import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as log from './log';

// Detect the environment-specific GUID suffix from existing exported flow filenames.
// Every environment stamps its flows with a fixed 3-segment suffix, e.g. f011-bec1-7c1e52fba4ce.
// A fully random GUID will be rejected on import.
function detectGuidSuffix(solutionsRoot: string): string | null {
  try {
    for (const sol of fs.readdirSync(solutionsRoot)) {
      const wfDir = path.join(solutionsRoot, sol, 'Workflows');
      if (!fs.existsSync(wfDir)) { continue; }
      for (const f of fs.readdirSync(wfDir)) {
        const m = f.match(/([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.json$/i);
        if (m) { return `${m[3]}-${m[4]}-${m[5]}`; }
      }
    }
  } catch { /* ignore */ }
  return null;
}

function generateEnvironmentGuid(solutionsRoot: string): string {
  const suffix = detectGuidSuffix(solutionsRoot);
  if (!suffix) { return randomUUID().toUpperCase(); }
  const [seg1, seg2] = randomUUID().split('-');
  return `${seg1}-${seg2}-${suffix}`.toUpperCase();
}

function buildTemplateFlow(flowDisplayName: string, solutionDisplayName: string): object {
  return {
    properties: {
      connectionReferences: {},
      definition: {
        $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
        contentVersion: '1.0.0.0',
        metadata: { defaultToEmbeddedConnections: true },
        parameters: {
          $authentication: { defaultValue: {}, type: 'SecureObject' },
          $connections: { defaultValue: {}, type: 'Object' },
        },
        triggers: {
          manual: {
            metadata: { operationMetadataId: randomUUID() },
            type: 'Request',
            kind: 'Button',
            inputs: { schema: {} },
          },
        },
        actions: {
          Try: {
            metadata: { operationMetadataId: randomUUID() },
            type: 'Scope',
            actions: {
              Solution_Name: {
                metadata: { operationMetadataId: randomUUID() },
                type: 'Compose',
                inputs: solutionDisplayName,
                runAfter: {},
              },
            },
            runAfter: {},
          },
          Catch: {
            metadata: { operationMetadataId: randomUUID() },
            type: 'Scope',
            actions: {
              Get_Error_Details: {
                metadata: { operationMetadataId: randomUUID() },
                type: 'Query',
                inputs: {
                  from: "@result('Try')",
                  where: "@equals(item()?['status'], 'Failed')",
                },
                runAfter: {},
              },
              Error_Details: {
                metadata: { operationMetadataId: randomUUID() },
                type: 'Compose',
                inputs: "@first(body('Get_Error_Details'))?['error']?['message']",
                runAfter: { Get_Error_Details: ['Succeeded'] },
              },
            },
            runAfter: { Try: ['Failed', 'TimedOut', 'Skipped'] },
          },
        },
      },
      displayName: flowDisplayName,
      templateName: null,
    },
    schemaVersion: '1.0.0.0',
  };
}

// Write a template flow into an existing unpacked solution directory.
// Returns { guid, filePath, fileName, displayName }.
export function writeTemplateFlow(solutionDir: string, solutionDisplayName: string): { guid: string; filePath: string; fileName: string; displayName: string } {
  const workflowsDir = path.join(solutionDir, 'Workflows');
  fs.mkdirSync(workflowsDir, { recursive: true });

  const solutionsRoot = path.dirname(solutionDir);
  const flowGuid = generateEnvironmentGuid(solutionsRoot);
  const displayName = `Template - ${solutionDisplayName}`;
  const safeName = displayName.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const fileName = `${safeName}-${flowGuid}.json`;
  const filePath = path.join(workflowsDir, fileName);

  fs.writeFileSync(
    filePath,
    JSON.stringify(buildTemplateFlow(displayName, solutionDisplayName), null, 2),
    'utf8'
  );
  log.info(`Template flow written: ${filePath}`);
  return { guid: flowGuid, filePath, fileName, displayName };
}

// Inject a workflow JSON file directly into an existing zip (pac pack excludes new flows).
async function injectWorkflowIntoZip(zipPath: string, workflowFilePath: string): Promise<void> {
  const entryName = `Workflows/${path.basename(workflowFilePath)}`;
  log.info(`Injecting ${entryName} into zip…`);
  const ps = [
    'Add-Type -AssemblyName System.IO.Compression;',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem;',
    `$z = [System.IO.Compression.ZipFile]::Open('${zipPath}', [System.IO.Compression.ZipArchiveMode]::Update);`,
    `$e = $z.CreateEntry('${entryName}');`,
    '$s = $e.Open();',
    `$b = [System.IO.File]::ReadAllBytes('${workflowFilePath}');`,
    '$s.Write($b, 0, $b.Length);',
    '$s.Close();',
    '$z.Dispose();',
  ].join(' ');
  const { stdout, stderr } = await execAsync(`powershell.exe -NoProfile -NonInteractive -Command "${ps}"`);
  if (stderr) { log.info(`  zip inject stderr: ${stderr.trim()}`); }
  if (stdout) { log.info(`  zip inject stdout: ${stdout.trim()}`); }
}

// Register a new workflow in both Solution.xml (RootComponent) and customizations.xml (<Workflow> entry).
// Both are required: Solution.xml links the entity to the solution; customizations.xml creates it.
export function addWorkflowComponent(solutionDir: string, flowGuid: string, displayName: string, fileName: string): void {
  const guid = flowGuid.toLowerCase();

  // ── Solution.xml: add RootComponent ──────────────────────────────────────────
  const solutionXmlPath = path.join(solutionDir, 'Other', 'Solution.xml');
  const solXml = fs.readFileSync(solutionXmlPath, 'utf8');
  const rcEntry = `<RootComponent type="29" id="{${guid}}" behavior="0" />`;
  const updatedSol = /<RootComponents\s*\/>/.test(solXml)
    ? solXml.replace(/<RootComponents\s*\/>/, `<RootComponents>\n      ${rcEntry}\n    </RootComponents>`)
    : solXml.replace(/(<RootComponents>)([\s\S]*?)(<\/RootComponents>)/, `$1$2  ${rcEntry}\n    $3`);
  fs.writeFileSync(solutionXmlPath, updatedSol, 'utf8');

  // ── customizations.xml: add <Workflow> entry ──────────────────────────────────
  const custXmlPath = path.join(solutionDir, 'Other', 'customizations.xml');
  const custXml = fs.readFileSync(custXmlPath, 'utf8');
  const wfEntry = `<Workflow WorkflowId="{${guid}}" Name="${xmlEsc(displayName)}">
      <JsonFileName>/Workflows/${fileName}</JsonFileName>
      <Type>1</Type>
      <Subprocess>0</Subprocess>
      <Category>5</Category>
      <Mode>0</Mode>
      <Scope>4</Scope>
      <OnDemand>1</OnDemand>
      <TriggerOnCreate>0</TriggerOnCreate>
      <TriggerOnDelete>0</TriggerOnDelete>
      <AsyncAutomatically>0</AsyncAutomatically>
      <SyncWorkflowLogOnFailure>0</SyncWorkflowLogOnFailure>
      <StateCode>1</StateCode>
      <StatusCode>2</StatusCode>
      <RunAs>1</RunAs>
      <IsTransacted>1</IsTransacted>
      <IntroducedVersion>1.0.0.0</IntroducedVersion>
      <IsCustomizable>1</IsCustomizable>
      <BusinessProcessType>0</BusinessProcessType>
      <IsCustomProcessingStepAllowedForOtherPublishers>1</IsCustomProcessingStepAllowedForOtherPublishers>
      <PrimaryEntity>none</PrimaryEntity>
      <LocalizedNames>
        <LocalizedName languagecode="1033" description="${xmlEsc(displayName)}" />
      </LocalizedNames>
    </Workflow>`;
  const updatedCust = /<Workflows\s*\/>/.test(custXml)
    ? custXml.replace(/<Workflows\s*\/>/, `<Workflows>\n    ${wfEntry}\n  </Workflows>`)
    : custXml.replace(/(<Workflows>)([\s\S]*?)(<\/Workflows>)/, `$1$2  ${wfEntry}\n  $3`);
  fs.writeFileSync(custXmlPath, updatedCust, 'utf8');

  log.info(`Workflow registered: ${guid} — Solution.xml + customizations.xml updated`);
}

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
  Id?: string;               // GUID from pac solution list --json
  SolutionId?: string;       // alternate field name in older pac versions
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
  publisherDisplayName: string,
  publisherUniqueName: string,
  solutionsRoot: string
): Promise<void> {
  const solutionDir = path.join(solutionsRoot, uniqueName);
  const otherDir = path.join(solutionDir, 'Other');
  fs.mkdirSync(otherDir, { recursive: true });

  const xml = solutionXml(uniqueName, displayName, publisherPrefix, publisherDisplayName, publisherUniqueName);
  log.info(`Solution.xml:\n${xml}`);
  fs.writeFileSync(path.join(otherDir, 'Solution.xml'), xml, 'utf8');
  fs.writeFileSync(path.join(otherDir, 'customizations.xml'), CUSTOMIZATIONS_XML, 'utf8');

  const zipPath = path.join(solutionsRoot, `${uniqueName}_new.zip`);
  await runPac(['solution', 'pack', '--zipFile', zipPath, '--folder', solutionDir]);
  await runPacLong(['solution', 'import', '--environment', envUrl, '--path', zipPath]);
}

function xmlEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function solutionXml(uniqueName: string, displayName: string, publisherPrefix: string, publisherDisplayName: string, publisherUniqueName: string, flowGuid?: string): string {
  const nilAttr = 'xsi:nil="true"';
  return `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.2.26054.00147" SolutionPackageVersion="9.2" languagecode="1033" generatedBy="CrmLive" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" OrganizationVersion="9.2.26054.00147" OrganizationSchemaType="Standard">
  <SolutionManifest>
    <UniqueName>${xmlEsc(uniqueName)}</UniqueName>
    <LocalizedNames>
      <LocalizedName description="${xmlEsc(displayName)}" languagecode="1033" />
    </LocalizedNames>
    <Descriptions />
    <Version>1.0.0.0</Version>
    <Managed>0</Managed>
    <Publisher>
      <UniqueName>${xmlEsc(publisherUniqueName)}</UniqueName>
      <LocalizedNames>
        <LocalizedName description="${xmlEsc(publisherDisplayName)}" languagecode="1033" />
      </LocalizedNames>
      <Descriptions>
        <Description description="${xmlEsc(publisherDisplayName)}" languagecode="1033" />
      </Descriptions>
      <EMailAddress ${nilAttr}></EMailAddress>
      <SupportingWebsiteUrl ${nilAttr}></SupportingWebsiteUrl>
      <CustomizationPrefix>${xmlEsc(publisherPrefix)}</CustomizationPrefix>
      <CustomizationOptionValuePrefix>78017</CustomizationOptionValuePrefix>
      <Addresses>
        <Address>
          <AddressNumber>1</AddressNumber>
          <AddressTypeCode>1</AddressTypeCode>
          <City ${nilAttr}></City>
          <County ${nilAttr}></County>
          <Country ${nilAttr}></Country>
          <Fax ${nilAttr}></Fax>
          <FreightTermsCode ${nilAttr}></FreightTermsCode>
          <ImportSequenceNumber ${nilAttr}></ImportSequenceNumber>
          <Latitude ${nilAttr}></Latitude>
          <Line1 ${nilAttr}></Line1>
          <Line2 ${nilAttr}></Line2>
          <Line3 ${nilAttr}></Line3>
          <Longitude ${nilAttr}></Longitude>
          <Name ${nilAttr}></Name>
          <PostalCode ${nilAttr}></PostalCode>
          <PostOfficeBox ${nilAttr}></PostOfficeBox>
          <PrimaryContactName ${nilAttr}></PrimaryContactName>
          <ShippingMethodCode>1</ShippingMethodCode>
          <StateOrProvince ${nilAttr}></StateOrProvince>
          <Telephone1 ${nilAttr}></Telephone1>
          <Telephone2 ${nilAttr}></Telephone2>
          <Telephone3 ${nilAttr}></Telephone3>
          <TimeZoneRuleVersionNumber ${nilAttr}></TimeZoneRuleVersionNumber>
          <UPSZone ${nilAttr}></UPSZone>
          <UTCOffset ${nilAttr}></UTCOffset>
          <UTCConversionTimeZoneCode ${nilAttr}></UTCConversionTimeZoneCode>
        </Address>
        <Address>
          <AddressNumber>2</AddressNumber>
          <AddressTypeCode>1</AddressTypeCode>
          <City ${nilAttr}></City>
          <County ${nilAttr}></County>
          <Country ${nilAttr}></Country>
          <Fax ${nilAttr}></Fax>
          <FreightTermsCode ${nilAttr}></FreightTermsCode>
          <ImportSequenceNumber ${nilAttr}></ImportSequenceNumber>
          <Latitude ${nilAttr}></Latitude>
          <Line1 ${nilAttr}></Line1>
          <Line2 ${nilAttr}></Line2>
          <Line3 ${nilAttr}></Line3>
          <Longitude ${nilAttr}></Longitude>
          <Name ${nilAttr}></Name>
          <PostalCode ${nilAttr}></PostalCode>
          <PostOfficeBox ${nilAttr}></PostOfficeBox>
          <PrimaryContactName ${nilAttr}></PrimaryContactName>
          <ShippingMethodCode>1</ShippingMethodCode>
          <StateOrProvince ${nilAttr}></StateOrProvince>
          <Telephone1 ${nilAttr}></Telephone1>
          <Telephone2 ${nilAttr}></Telephone2>
          <Telephone3 ${nilAttr}></Telephone3>
          <TimeZoneRuleVersionNumber ${nilAttr}></TimeZoneRuleVersionNumber>
          <UPSZone ${nilAttr}></UPSZone>
          <UTCOffset ${nilAttr}></UTCOffset>
          <UTCConversionTimeZoneCode ${nilAttr}></UTCConversionTimeZoneCode>
        </Address>
      </Addresses>
    </Publisher>
    <RootComponents>${flowGuid ? `\n      <RootComponent type="29" id="{${flowGuid.toLowerCase()}}" behavior="0" />` : ''}
    </RootComponents>
    <MissingDependencies />
  </SolutionManifest>
</ImportExportXml>`;
}

const CUSTOMIZATIONS_XML = `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" OrganizationVersion="9.2.26054.00147" OrganizationSchemaType="Standard" CRMServerServiceabilityVersion="9.2.26054.00147">
  <Entities />
  <Roles />
  <Workflows />
  <FieldSecurityProfiles />
  <Templates />
  <EntityMaps />
  <EntityRelationships />
  <OrganizationSettings />
  <optionsets />
  <CustomControls />
  <EntityDataProviders />
  <connectionreferences />
  <Languages>
    <Language>1033</Language>
  </Languages>
</ImportExportXml>`;
