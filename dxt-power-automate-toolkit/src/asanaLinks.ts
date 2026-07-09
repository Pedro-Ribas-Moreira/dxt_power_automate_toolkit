// Solution ↔ Asana-task link store. Links are team knowledge ("which ticket
// does this solution serve"), so they live in a shareable workspace file
// (asana-links.json, keyed by SolutionUniqueName → [task GIDs]) synced to the
// team SharePoint folder like company-context.json / pa-library.json.
// The PAT NEVER goes in this file.
//
// Merge semantics: link/unlink use download-modify-upload so an unlink wins —
// a plain union merge would resurrect removed GIDs from the shared copy.
// Simultaneous edits are last-writer-wins (fine for a 3-person team).
import * as fs from 'fs';
import * as path from 'path';
import { spDownload, spUpload } from './sharepoint';
import { info } from './log';

const LINKS_FILE = 'asana-links.json';

interface LinkStore {
  links: Record<string, string[]>;
}

function linksPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, LINKS_FILE);
}

function readStore(raw: string | null | undefined): LinkStore {
  if (!raw) { return { links: {} }; }
  try {
    const parsed = JSON.parse(raw);
    return { links: parsed.links && typeof parsed.links === 'object' ? parsed.links : {} };
  } catch {
    return { links: {} };
  }
}

function loadLocal(workspaceRoot: string): LinkStore {
  try { return readStore(fs.readFileSync(linksPath(workspaceRoot), 'utf8')); }
  catch { return { links: {} }; }
}

function saveLocal(workspaceRoot: string, store: LinkStore): void {
  fs.writeFileSync(linksPath(workspaceRoot), JSON.stringify(store, null, 2), 'utf8');
}

function unionMerge(a: LinkStore, b: LinkStore): LinkStore {
  const links: Record<string, string[]> = {};
  for (const store of [a, b]) {
    for (const [sol, gids] of Object.entries(store.links)) {
      if (!links[sol]) { links[sol] = []; }
      for (const gid of gids) {
        if (!links[sol].includes(gid)) { links[sol].push(gid); }
      }
    }
  }
  return { links };
}

export function loadLinks(workspaceRoot: string): Record<string, string[]> {
  return loadLocal(workspaceRoot).links;
}

/** Download-merge-modify-upload. `mutate` runs on the merged store. */
async function updateStore(workspaceRoot: string, mutate: (store: LinkStore) => void): Promise<void> {
  let shared: LinkStore = { links: {} };
  let sharePointAvailable = true;
  try {
    shared = readStore(await spDownload(LINKS_FILE));
  } catch {
    sharePointAvailable = false; // offline / not signed in — keep working locally
  }
  const merged = unionMerge(shared, loadLocal(workspaceRoot));
  mutate(merged);
  saveLocal(workspaceRoot, merged);
  if (sharePointAvailable) {
    try { await spUpload(LINKS_FILE, JSON.stringify(merged, null, 2)); }
    catch (e: any) { info(`asana-links SharePoint sync skipped: ${e.message}`); }
  }
}

export async function linkTask(workspaceRoot: string, solutionUniqueName: string, gid: string): Promise<void> {
  await updateStore(workspaceRoot, store => {
    if (!store.links[solutionUniqueName]) { store.links[solutionUniqueName] = []; }
    if (!store.links[solutionUniqueName].includes(gid)) { store.links[solutionUniqueName].push(gid); }
  });
}

export async function unlinkTask(workspaceRoot: string, solutionUniqueName: string, gid: string): Promise<void> {
  await updateStore(workspaceRoot, store => {
    store.links[solutionUniqueName] = (store.links[solutionUniqueName] ?? []).filter(g => g !== gid);
    if (!store.links[solutionUniqueName].length) { delete store.links[solutionUniqueName]; }
  });
}

/** Startup: pull the shared copy and union-merge into the local file. */
export async function pullSharedLinks(workspaceRoot: string): Promise<void> {
  const raw = await spDownload(LINKS_FILE);
  if (!raw) { return; }
  const merged = unionMerge(readStore(raw), loadLocal(workspaceRoot));
  saveLocal(workspaceRoot, merged);
}

/** One-time migration from a dxt-bridge .asana.json. Imports ONLY the links
 *  map — the plaintext PAT in that file is deliberately ignored. */
export async function importBridgeLinks(workspaceRoot: string, bridgeAsanaJsonPath: string): Promise<number> {
  const raw = fs.readFileSync(bridgeAsanaJsonPath, 'utf8');
  const bridge = readStore(raw);
  let count = 0;
  await updateStore(workspaceRoot, store => {
    for (const [sol, gids] of Object.entries(bridge.links)) {
      if (!store.links[sol]) { store.links[sol] = []; }
      for (const gid of gids) {
        if (!store.links[sol].includes(gid)) {
          store.links[sol].push(gid);
          count++;
        }
      }
    }
  });
  return count;
}
