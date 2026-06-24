import * as vscode from 'vscode';
import { PublicClientApplication, AccountInfo } from '@azure/msal-node';
import { info, error as logError } from './log';

// Public identifiers — not sensitive
const CLIENT_ID  = 'a1ad88e2-9326-4f01-bacc-d0c69818ca6a';
const TENANT_ID  = '1bf22423-77fd-4a29-b26c-0140e0b78126';
const AUTHORITY  = `https://login.microsoftonline.com/${TENANT_ID}`;

const GRAPH_BASE    = 'https://graph.microsoft.com/v1.0';
const SP_HOSTNAME   = 'prepaypower.sharepoint.com';
const SP_SITE_PATH  = '/sites/Omni-ChannelToolIntegration';
const SP_ROOT_FOLDER = 'DXT Power Automate Toolkit';

const SCOPES     = [
  'https://graph.microsoft.com/Files.ReadWrite.All',
  'https://graph.microsoft.com/Sites.ReadWrite.All',
];
const CACHE_KEY  = 'dxt-msal-token-cache';
const SECRET_KEY = 'dxt-sp-client-secret';

let _context: vscode.ExtensionContext | undefined;
let _pca: PublicClientApplication | undefined;
let _account: AccountInfo | null = null;
let _siteId: string | null = null;
let _driveId: string | null = null;

// ── Initialisation ────────────────────────────────────────────────────────────

export function initSharePoint(context: vscode.ExtensionContext): void {
  _context = context;
  _pca = new PublicClientApplication({
    auth: { clientId: CLIENT_ID, authority: AUTHORITY },
  });

  // Restore persisted token cache so users don't sign in on every VS Code launch
  const cached = context.globalState.get<string>(CACHE_KEY);
  if (cached) {
    try { _pca.getTokenCache().deserialize(cached); } catch { /* ignore corrupt cache */ }
  }
}

/** Store the client secret IT provided — called once, remembered forever. */
export async function storeClientSecret(secret: string): Promise<void> {
  await _context?.secrets.store(SECRET_KEY, secret);
}

/** Retrieve the stored client secret (for use in PA flows / future web app). */
export async function getStoredClientSecret(): Promise<string | undefined> {
  return _context?.secrets.get(SECRET_KEY);
}

// ── Authentication ────────────────────────────────────────────────────────────

async function persistCache(): Promise<void> {
  if (!_pca || !_context) { return; }
  await _context.globalState.update(CACHE_KEY, _pca.getTokenCache().serialize());
}

// In-flight dedup: if multiple callers ask for the same scopes simultaneously,
// they all wait on the same promise instead of each launching a device code flow.
const _tokenInFlight = new Map<string, Promise<string>>();

async function getToken(scopes: string[] = SCOPES): Promise<string> {
  if (!_pca) { throw new Error('SharePoint not initialised — open a workspace first'); }

  const scopeKey = scopes.slice().sort().join(' ');
  const inflight = _tokenInFlight.get(scopeKey);
  if (inflight) { return inflight; }

  const promise = _getTokenImpl(scopes).finally(() => _tokenInFlight.delete(scopeKey));
  _tokenInFlight.set(scopeKey, promise);
  return promise;
}

async function _getTokenImpl(scopes: string[]): Promise<string> {
  if (!_pca) { throw new Error('SharePoint not initialised — open a workspace first'); }

  // 1. Silent — use cached account if we have one
  if (_account) {
    try {
      info(`SharePoint: acquiring token silently for ${scopes[0]}…`);
      const r = await _pca.acquireTokenSilent({ account: _account, scopes });
      if (r?.accessToken) { info('SharePoint: token acquired silently'); return r.accessToken; }
    } catch (e: any) { info(`SharePoint: silent token failed — ${e.message}`); }
  }

  // 2. Silent — try any account from the persisted cache
  const accounts = await _pca.getTokenCache().getAllAccounts();
  info(`SharePoint: checking persisted cache (${accounts.length} account(s))`);
  for (const account of accounts) {
    try {
      const r = await _pca.acquireTokenSilent({ account, scopes });
      if (r?.accessToken) {
        _account = account;
        info(`SharePoint: token acquired from cache for ${account.username}`);
        return r.accessToken;
      }
    } catch { /* try next */ }
  }

  // 3. Device code flow — VS Code shows a code, user pastes it at microsoft.com/devicelogin
  info('SharePoint: no cached token — starting device code flow…');
  const result = await _pca.acquireTokenByDeviceCode({
    scopes,
    deviceCodeCallback: async (response) => {
      info(`SharePoint: device code = ${response.userCode} — waiting for sign-in at ${response.verificationUri}`);
      await vscode.env.clipboard.writeText(response.userCode);
      const action = await vscode.window.showInformationMessage(
        `SharePoint sign-in: code  ${response.userCode}  has been copied to your clipboard.`,
        'Open Browser'
      );
      if (action === 'Open Browser') {
        await vscode.env.openExternal(vscode.Uri.parse(response.verificationUri));
      }
    },
  });

  if (!result?.accessToken) { throw new Error('SharePoint sign-in was cancelled or failed'); }
  info(`SharePoint: signed in as ${result.account?.username}`);
  _account = result.account;
  await persistCache();
  return result.accessToken;
}

// ── Graph API helpers ─────────────────────────────────────────────────────────

async function graphGet<T>(apiPath: string): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${GRAPH_BASE}${apiPath}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    logError(`Graph GET ${apiPath} → ${res.status}: ${body}`);
    throw new Error(`Graph GET failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<T>;
}

async function graphPut(apiPath: string, content: string): Promise<void> {
  const token = await getToken();
  const res = await fetch(`${GRAPH_BASE}${apiPath}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body: Buffer.from(content, 'utf8'),
  });
  if (!res.ok) {
    const body = await res.text();
    logError(`Graph PUT ${apiPath} → ${res.status}: ${body}`);
    throw new Error(`Graph PUT failed: ${res.status} ${body}`);
  }
}

async function getSiteAndDriveIds(): Promise<{ siteId: string; driveId: string }> {
  if (_siteId && _driveId) { return { siteId: _siteId, driveId: _driveId }; }

  info(`SharePoint: resolving site ID for ${SP_HOSTNAME}${SP_SITE_PATH}…`);
  const site = await graphGet<{ id: string }>(`/sites/${SP_HOSTNAME}:${SP_SITE_PATH}`);
  _siteId = site.id;
  info(`SharePoint: site ID = ${_siteId}`);

  info('SharePoint: listing drives…');
  const drives = await graphGet<{ value: Array<{ id: string; name: string }> }>(`/sites/${_siteId}/drives`);
  info(`SharePoint: found drives: ${drives.value.map(d => d.name).join(', ')}`);
  const drive = drives.value.find(d => d.name === 'Documents' || d.name === 'Shared Documents');
  if (!drive) { throw new Error('Could not find Shared Documents library on the SharePoint site'); }
  _driveId = drive.id;
  info(`SharePoint: using drive "${drive.name}" (${_driveId})`);

  return { siteId: _siteId, driveId: _driveId };
}

function encodePath(p: string): string {
  return p.split('/').map(s => encodeURIComponent(s)).join('/');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Upload a text file to SharePoint.
 * @param relativePath  Relative to the DXT toolkit folder, e.g. "cloud-index.md" or "solutions/MySolution/FLOWS.md"
 */
export async function spUpload(relativePath: string, content: string): Promise<void> {
  info(`SharePoint: uploading → ${relativePath} (${content.length} chars)…`);
  const { driveId } = await getSiteAndDriveIds();
  const fullPath = `${SP_ROOT_FOLDER}/${relativePath}`;
  await graphPut(`/drives/${driveId}/root:/${encodePath(fullPath)}:/content`, content);
  info(`SharePoint: upload complete → ${relativePath}`);
}

/**
 * Download a text file from SharePoint.
 * Returns null if the file does not exist or cannot be read.
 */
export async function spDownload(relativePath: string): Promise<string | null> {
  info(`SharePoint: downloading ← ${relativePath}…`);
  try {
    const { driveId } = await getSiteAndDriveIds();
    const fullPath = `${SP_ROOT_FOLDER}/${relativePath}`;
    const meta = await graphGet<{ '@microsoft.graph.downloadUrl': string }>(
      `/drives/${driveId}/root:/${encodePath(fullPath)}`
    );
    const res = await fetch(meta['@microsoft.graph.downloadUrl']);
    if (!res.ok) { info(`SharePoint: download failed (${res.status}) for ${relativePath}`); return null; }
    const text = await res.text();
    info(`SharePoint: download complete ← ${relativePath} (${text.length} chars)`);
    return text;
  } catch (e: any) {
    info(`SharePoint: download skipped for ${relativePath} — ${e.message}`);
    return null;
  }
}

/**
 * List item names inside a SharePoint folder.
 * @param relativePath  Relative to the DXT toolkit folder. Pass '' for the root folder.
 */
export async function spListFolder(relativePath: string): Promise<string[]> {
  const displayPath = relativePath || '(root)';
  info(`SharePoint: listing folder "${displayPath}"…`);
  try {
    const { driveId } = await getSiteAndDriveIds();
    const fullPath = relativePath ? `${SP_ROOT_FOLDER}/${relativePath}` : SP_ROOT_FOLDER;
    const res = await graphGet<{ value: Array<{ name: string }> }>(
      `/drives/${driveId}/root:/${encodePath(fullPath)}:/children`
    );
    const names = res.value.map(i => i.name);
    info(`SharePoint: folder "${displayPath}" contains ${names.length} item(s): ${names.join(', ') || '(empty)'}`);
    return names;
  } catch (e: any) {
    info(`SharePoint: could not list folder "${displayPath}" — ${e.message}`);
    return [];
  }
}

// ── Discovery API ─────────────────────────────────────────────────────────────

export interface SpSite {
  id: string;
  displayName: string;
  webUrl: string;
}

export interface SpList {
  id: string;
  displayName: string;
  name: string;
}

export interface SpColumn {
  name: string;
  displayName: string;
  type: string;
}

/** Returns all SharePoint sites the signed-in user has access to. */
export async function spDiscoverSites(): Promise<SpSite[]> {
  info('SharePoint discovery: listing accessible sites…');
  const res = await graphGet<{ value: Array<{ id: string; displayName: string; webUrl: string }> }>(
    '/sites?search=*&$select=id,displayName,webUrl&$top=100'
  );
  const sites = res.value.map(s => ({ id: s.id, displayName: s.displayName, webUrl: s.webUrl }));
  info(`SharePoint discovery: found ${sites.length} site(s)`);
  for (const s of sites) { info(`  • ${s.displayName} — ${s.webUrl}`); }
  return sites;
}

const SYSTEM_LISTS = new Set([
  'Site Pages', 'Site Assets', 'Style Library', 'Form Templates',
  'Master Page Gallery', 'Composed Looks', 'Theme Gallery', 'Solution Gallery',
  'Web Part Gallery', 'List Template Gallery', 'User Information List',
  'Content and Structure Reports', 'Reusable Content', 'TaxonomyHiddenList',
  'Workflow Tasks', 'Workflow History', 'MicroFeed', 'Social',
]);

/** Returns non-system lists for a given site. */
export async function spDiscoverLists(siteId: string): Promise<SpList[]> {
  info(`SharePoint discovery: listing lists in site ${siteId}…`);
  const res = await graphGet<{ value: Array<{ id: string; displayName: string; name: string; list?: { hidden?: boolean } }> }>(
    `/sites/${siteId}/lists?$select=id,displayName,name,list&$top=200`
  );
  const lists = res.value
    .filter(l => !l.list?.hidden && !SYSTEM_LISTS.has(l.displayName))
    .map(l => ({ id: l.id, displayName: l.displayName, name: l.name }));
  info(`SharePoint discovery: found ${lists.length} list(s) (system lists excluded)`);
  for (const l of lists) { info(`    - ${l.displayName}`); }
  return lists;
}

/** Returns visible columns for a given list. */
export async function spDiscoverColumns(siteId: string, listId: string): Promise<SpColumn[]> {
  // Fetch without $select so all type-definition sub-objects are returned
  const res = await graphGet<{ value: Array<Record<string, any>> }>(
    `/sites/${siteId}/lists/${listId}/columns?$top=200`
  );
  const SKIP_NAMES = new Set(['ContentType', 'Attachments', 'Edit', 'LinkTitle', 'LinkTitleNoMenu', 'DocIcon', 'ItemChildCount', 'FolderChildCount', 'AppAuthor', 'AppEditor']);
  const cols = res.value
    .filter(c => !c.hidden && !c.readOnly && !c.name.startsWith('_') && !SKIP_NAMES.has(c.name))
    .map(c => {
      let type = 'text';
      if ('number'        in c) { type = 'number'; }
      else if ('dateTime' in c) { type = 'dateTime'; }
      else if ('choice'   in c) { type = 'choice'; }
      else if ('lookup'   in c) { type = 'lookup'; }
      else if ('personOrGroup' in c) { type = 'person'; }
      else if ('boolean'  in c) { type = 'boolean'; }
      else if ('calculated' in c) { type = 'calculated'; }
      else if ('hyperlinkOrPicture' in c) { type = 'hyperlink'; }
      else if ('currency' in c) { type = 'currency'; }
      return { name: c.name, displayName: c.displayName, type };
    });
  return cols;
}

/**
 * Acquire a token for any set of scopes using the same signed-in account.
 * Used by paApi.ts to get Power Automate API tokens without a second sign-in.
 */
export async function getTokenForScopes(scopes: string[]): Promise<string> {
  return getToken(scopes);
}

/** Sign out — clears cached tokens. Next SharePoint action will prompt sign-in again. */
export async function spSignOut(): Promise<void> {
  if (_pca && _account) {
    await _pca.getTokenCache().removeAccount(_account);
    await persistCache();
  }
  _account = null;
  _siteId = null;
  _driveId = null;
}
