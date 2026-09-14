import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { getPlatformAdapter } from '../platform/PlatformFactory';
import type { FileMetadata, MetadataField, PlatformCapabilities } from '../platform/types';

export type { FileMetadata, MetadataField, PlatformCapabilities } from '../platform/types';

let directoryDiffLogger: ((message: string) => void) | undefined;

export function setDirectoryDiffLogger(logger: ((message: string) => void) | undefined): void {
  directoryDiffLogger = logger;
}

function logDirectoryDiff(message: string): void {
  directoryDiffLogger?.(message);
}


export interface DirectoryExcludeFilter {
  name: string;
  pattern: string;
}

const DIRECTORY_EXCLUDE_FILTERS_KEY = 'directory.excludeFilters';
const DIRECTORY_EXCLUDE_FILTERS_STATE_KEY = 'codemeld.directory.excludeFilters';

function normalizeDirectoryExcludeFilters(raw: unknown): DirectoryExcludeFilter[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const value = item as { name?: unknown; pattern?: unknown };
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    const pattern = typeof value.pattern === 'string' ? value.pattern.trim() : '';
    return pattern ? [{ name, pattern }] : [];
  });
}

export function readDirectoryExcludeFilters(context?: vscode.ExtensionContext): DirectoryExcludeFilter[] {
  const configuration = vscode.workspace.getConfiguration('codemeld');
  const inspected = configuration.inspect<unknown[]>(DIRECTORY_EXCLUDE_FILTERS_KEY);
  const hasExplicitConfiguration = inspected?.globalValue !== undefined ||
    inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined;

  if (hasExplicitConfiguration) {
    return normalizeDirectoryExcludeFilters(configuration.get<unknown[]>(DIRECTORY_EXCLUDE_FILTERS_KEY, []));
  }

  // globalState is a persistence fallback for remote/workspace extension hosts.
  // It also lets older builds recover rules if VS Code did not materialize the
  // contributed setting correctly. Explicit VS Code configuration always wins.
  return normalizeDirectoryExcludeFilters(context?.globalState.get<unknown[]>(DIRECTORY_EXCLUDE_FILTERS_STATE_KEY, []));
}

export async function writeDirectoryExcludeFilters(
  context: vscode.ExtensionContext,
  filters: DirectoryExcludeFilter[],
): Promise<DirectoryExcludeFilter[]> {
  const normalized = normalizeDirectoryExcludeFilters(filters);
  const configuration = vscode.workspace.getConfiguration('codemeld');

  const inspected = configuration.inspect<DirectoryExcludeFilter[]>(DIRECTORY_EXCLUDE_FILTERS_KEY);
  if (inspected?.workspaceFolderValue !== undefined) {
    await configuration.update(DIRECTORY_EXCLUDE_FILTERS_KEY, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  }
  if (inspected?.workspaceValue !== undefined) {
    await configuration.update(DIRECTORY_EXCLUDE_FILTERS_KEY, undefined, vscode.ConfigurationTarget.Workspace);
  }

  // Persist in both standard VS Code settings and extension globalState.
  // The setting remains visible/editable in Settings and participates in Sync;
  // globalState is only used when no explicit configuration value exists.
  await context.globalState.update(DIRECTORY_EXCLUDE_FILTERS_STATE_KEY, normalized);
  await configuration.update(DIRECTORY_EXCLUDE_FILTERS_KEY, normalized, vscode.ConfigurationTarget.Global);

  const inspectedAfter = vscode.workspace.getConfiguration('codemeld').inspect<unknown[]>(DIRECTORY_EXCLUDE_FILTERS_KEY);
  const rawAfter = vscode.workspace.getConfiguration('codemeld').get<unknown[]>(DIRECTORY_EXCLUDE_FILTERS_KEY, []);
  const effective = readDirectoryExcludeFilters(context);
  logDirectoryDiff(`[filters] saved request: ${JSON.stringify(normalized)}`);
  logDirectoryDiff(`[filters] raw config after save: ${JSON.stringify(rawAfter)}`);
  logDirectoryDiff(`[filters] global explicit after save: ${JSON.stringify(inspectedAfter?.globalValue ?? null)}`);
  logDirectoryDiff(`[filters] effective after save: ${JSON.stringify(effective)}`);
  return effective;
}

export type DirectoryDiffKind = 'same' | 'onlyLeft' | 'onlyRight' | 'content' | 'metadata' | 'content+metadata' | 'case' | 'type';

export interface DirectorySideEntry {
  uri: string;
  name: string;
  relativePath: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  metadata: FileMetadata;
}

export interface DirectoryPair {
  relativePath: string;
  depth: number;
  name: string;
  isDirectory: boolean;
  left?: DirectorySideEntry;
  right?: DirectorySideEntry;
  contentDifferent: boolean;
  metadataDifferent: boolean;
  timeMetadataDifferent: boolean;
  otherMetadataDifferent: boolean;
  caseDifferent: boolean;
  kind: DirectoryDiffKind;
}

export interface DirectoryComparison {
  leftRoot: string;
  rightRoot: string;
  pairs: DirectoryPair[];
  capabilities: PlatformCapabilities;
  leftCaseSensitive: boolean;
  rightCaseSensitive: boolean;
}

interface CollectedEntry extends DirectorySideEntry {
  nativePath: string;
}

export async function compareDirectories(leftRoot: vscode.Uri, rightRoot: vscode.Uri, excludeFilters: DirectoryExcludeFilter[] = readDirectoryExcludeFilters()): Promise<DirectoryComparison> {
  const adapter = await getPlatformAdapter();
  logDirectoryDiff(`Directory compare: ${leftRoot.fsPath} ↔ ${rightRoot.fsPath}`);
  if (excludeFilters.length) {
    logDirectoryDiff('Directory exclusions:');
    for (const filter of excludeFilters) logDirectoryDiff(`  ${filter.name || '(unnamed)'} -> ${filter.pattern}`);
  } else {
    logDirectoryDiff('Directory exclusions: none');
  }
  const [left, right] = await Promise.all([collect(leftRoot, excludeFilters), collect(rightRoot, excludeFilters)]);
  const [leftCaseSensitive, rightCaseSensitive] = await Promise.all([
    detectCaseSensitivity(leftRoot.fsPath, left),
    detectCaseSensitivity(rightRoot.fsPath, right),
  ]);

  const matched: Array<{ left?: CollectedEntry; right?: CollectedEntry }> = [];
  const usedLeft = new Set<string>();
  const usedRight = new Set<string>();

  // Pass 1: exact relative-path matches always win.
  for (const [relativePath, l] of left) {
    const r = right.get(relativePath);
    if (!r) continue;
    matched.push({ left: l, right: r });
    usedLeft.add(relativePath);
    usedRight.add(relativePath);
  }

  // Pass 2: on a case-insensitive side, match unique case-only variants.
  // Ambiguous groups are deliberately left unmatched.
  if (!leftCaseSensitive || !rightCaseSensitive) {
    const lGroups = groupUnmatchedByFoldedPath(left, usedLeft);
    const rGroups = groupUnmatchedByFoldedPath(right, usedRight);
    for (const [folded, ls] of lGroups) {
      const rs = rGroups.get(folded);
      if (!rs || ls.length !== 1 || rs.length !== 1) continue;
      const l = ls[0];
      const r = rs[0];
      matched.push({ left: l, right: r });
      usedLeft.add(l.relativePath);
      usedRight.add(r.relativePath);
    }
  }

  const rightDirectoryAliases = matched
    .filter(m => m.left?.type === 'directory' && m.right?.type === 'directory' && m.left.relativePath !== m.right.relativePath)
    .map(m => ({ right: m.right!.relativePath, left: m.left!.relativePath }))
    .sort((a, b) => b.right.length - a.right.length);

  for (const [relativePath, l] of left) if (!usedLeft.has(relativePath)) matched.push({ left: l });
  for (const [relativePath, r] of right) if (!usedRight.has(relativePath)) matched.push({ right: r });

  const pairs: DirectoryPair[] = [];
  for (const match of matched) {
    const l = match.left;
    const r = match.right;
    const relativePath = l?.relativePath ?? canonicalizeRightPath(r!.relativePath, rightDirectoryAliases);
    const name = l?.name ?? r!.name;
    const depth = relativePath.split('/').length - 1;
    const isDirectory = l?.type === 'directory' || r?.type === 'directory';
    const caseDifferent = !!l && !!r && l.relativePath !== r.relativePath && foldedPath(l.relativePath) === foldedPath(r.relativePath);
    let contentDifferent = false;
    let metadataDifferent = false;
    let timeMetadataDifferent = false;
    let otherMetadataDifferent = false;
    let kind: DirectoryDiffKind = 'same';

    if (!l) kind = 'onlyRight';
    else if (!r) kind = 'onlyLeft';
    else if (l.type !== r.type) kind = 'type';
    else {
      timeMetadataDifferent = timeMetadataDiffers(l.metadata, r.metadata, adapter.capabilities);
      otherMetadataDifferent = adapter.otherMetadataDiffers(l.metadata, r.metadata);
      metadataDifferent = timeMetadataDifferent || otherMetadataDifferent;
      if (l.type === 'file') contentDifferent = !(await sameFileContent(l.nativePath, r.nativePath, l.metadata, r.metadata));
      if (contentDifferent && metadataDifferent) kind = 'content+metadata';
      else if (contentDifferent) kind = 'content';
      else if (metadataDifferent) kind = 'metadata';
      else if (caseDifferent) kind = 'case';
    }

    pairs.push({
      relativePath,
      depth,
      name,
      isDirectory,
      left: l ? publicEntry(l) : undefined,
      right: r ? publicEntry(r) : undefined,
      contentDifferent,
      metadataDifferent,
      timeMetadataDifferent,
      otherMetadataDifferent,
      caseDifferent,
      kind,
    });
  }

  pairs.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true, sensitivity: 'variant' }));
  return {
    leftRoot: leftRoot.toString(),
    rightRoot: rightRoot.toString(),
    pairs,
    capabilities: adapter.capabilities,
    leftCaseSensitive,
    rightCaseSensitive,
  };
}


function canonicalizeRightPath(value: string, aliases: Array<{ right: string; left: string }>): string {
  for (const alias of aliases) {
    if (value === alias.right) return alias.left;
    if (value.startsWith(`${alias.right}/`)) return alias.left + value.slice(alias.right.length);
  }
  return value;
}

function foldedPath(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

function groupUnmatchedByFoldedPath(entries: Map<string, CollectedEntry>, used: Set<string>): Map<string, CollectedEntry[]> {
  const groups = new Map<string, CollectedEntry[]>();
  for (const [key, entry] of entries) {
    if (used.has(key)) continue;
    const folded = foldedPath(key);
    const group = groups.get(folded) ?? [];
    group.push(entry);
    groups.set(folded, group);
  }
  return groups;
}

async function detectCaseSensitivity(root: string, entries: Map<string, CollectedEntry>): Promise<boolean> {
  // Read-only probe: choose a direct child with an alphabetic character and try the same name with one letter's case toggled.
  const direct = [...entries.values()].find(e => !e.relativePath.includes('/') && /[A-Za-z]/.test(e.name));
  if (direct) {
    const toggledName = toggleOneAsciiLetter(direct.name);
    if (toggledName !== direct.name) {
      try {
        const [actual, alternate] = await Promise.all([fs.lstat(direct.nativePath), fs.lstat(path.join(root, toggledName))]);
        if (actual.dev === alternate.dev && actual.ino === alternate.ino) return false;
        return true;
      } catch (error: any) {
        if (error?.code === 'ENOENT') return true;
      }
    }
  }
  // Empty/unprobeable roots: conservative platform default. Linux is normally case-sensitive; macOS/Windows normally are not.
  return process.platform === 'linux';
}

function toggleOneAsciiLetter(value: string): string {
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c >= 'a' && c <= 'z') return value.slice(0, i) + c.toUpperCase() + value.slice(i + 1);
    if (c >= 'A' && c <= 'Z') return value.slice(0, i) + c.toLowerCase() + value.slice(i + 1);
  }
  return value;
}

async function collect(root: vscode.Uri, excludeFilters: DirectoryExcludeFilter[]): Promise<Map<string, CollectedEntry>> {
  const adapter = await getPlatformAdapter();
  const result = new Map<string, CollectedEntry>();
  await walk(root.fsPath, '');
  return result;

  async function walk(nativeDir: string, relativeDir: string): Promise<void> {
    const entries = await fs.readdir(nativeDir, { withFileTypes: true });
    for (const dirent of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${dirent.name}` : dirent.name;
      const matchedExclude = matchExcludedPath(relativePath, dirent.isDirectory(), excludeFilters);
      if (matchedExclude) {
        logDirectoryDiff(`  excluded ${dirent.isDirectory() ? 'directory' : 'file'}: ${relativePath} [${matchedExclude.pattern}]`);
        continue;
      }
      const nativePath = path.join(nativeDir, dirent.name);
      const stat = await fs.lstat(nativePath);
      const type: DirectorySideEntry['type'] = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other';
      const entry: CollectedEntry = {
        uri: vscode.Uri.file(nativePath).toString(),
        nativePath,
        name: dirent.name,
        relativePath,
        type,
        metadata: await adapter.enrichMetadata(nativePath, stat),
      };
      result.set(relativePath, entry);
      if (stat.isDirectory()) await walk(nativePath, relativePath);
    }
  }
}


function matchExcludedPath(relativePath: string, isDirectory: boolean, filters: DirectoryExcludeFilter[]): DirectoryExcludeFilter | undefined {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);

  for (const filter of filters) {
    let pattern = filter.pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!pattern) continue;

    const directoryOnly = pattern.endsWith('/');
    pattern = pattern.replace(/\/+$/, '').replace(/^\/+/, '');
    if (!pattern || (directoryOnly && !isDirectory)) continue;

    // A pattern without a slash is intentionally a basename rule and therefore
    // matches at any depth. This makes `.git`, `node_modules` and `*.log`
    // predictable and independent of the compared root path.
    if (!pattern.includes('/')) {
      if (globMatches(basename, pattern)) return filter;
      continue;
    }

    // `foo/**` excludes the directory itself as well as everything below it.
    if (pattern.endsWith('/**')) {
      const base = pattern.slice(0, -3).replace(/\/+$/, '');
      if (base && (normalized === base || normalized.startsWith(`${base}/`))) return filter;
      continue;
    }

    if (globMatches(normalized, pattern)) return filter;
  }
  return undefined;
}

function isExcludedPath(relativePath: string, isDirectory: boolean, filters: DirectoryExcludeFilter[]): boolean {
  return matchExcludedPath(relativePath, isDirectory, filters) !== undefined;
}

function globMatches(value: string, pattern: string): boolean {
  let source = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        while (pattern[i + 1] === '*') i++;
        source += '.*';
      } else source += '[^/]*';
    } else if (ch === '?') source += '[^/]';
    else if ('\\.^$+{}()|[]'.includes(ch)) source += '\\' + ch;
    else source += ch;
  }
  source += '$';
  try { return new RegExp(source).test(value); } catch { return false; }
}

function publicEntry(entry: CollectedEntry): DirectorySideEntry {
  const { nativePath: _nativePath, ...publicValue } = entry;
  return publicValue;
}

function timeMetadataDiffers(a: FileMetadata, b: FileMetadata, capabilities: PlatformCapabilities): boolean {
  if (Math.abs(a.mtimeMs - b.mtimeMs) > 1) return true;
  if (!capabilities.canReadCreationTime) return false;
  // Some Linux file systems report zero/epoch when birth time is unavailable. Treat that as unknown.
  if (a.birthtimeMs <= 0 || b.birthtimeMs <= 0) return false;
  return Math.abs(a.birthtimeMs - b.birthtimeMs) > 1;
}

async function sameFileContent(a: string, b: string, am: FileMetadata, bm: FileMetadata): Promise<boolean> {
  if (am.size !== bm.size) return false;
  if (am.size === 0) return true;
  const [ab, bb] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
  return ab.equals(bb);
}

export async function copyDirectoryPair(
  sourceRoot: vscode.Uri,
  targetRoot: vscode.Uri,
  sourceRelativePath: string,
  targetRelativePath: string = sourceRelativePath,
): Promise<void> {
  const source = path.join(sourceRoot.fsPath, ...sourceRelativePath.split('/'));
  const target = path.join(targetRoot.fsPath, ...targetRelativePath.split('/'));
  const stat = await fs.lstat(source);
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (stat.isDirectory()) {
    await fs.cp(source, target, { recursive: true, force: true, preserveTimestamps: true });
  } else {
    await fs.copyFile(source, target);
    await copyTransferableMetadata(source, target);
  }
}

export async function syncTargetCase(
  targetRoot: vscode.Uri,
  currentRelativePath: string,
  desiredRelativePath: string,
): Promise<void> {
  if (currentRelativePath === desiredRelativePath) return;
  const current = path.join(targetRoot.fsPath, ...currentRelativePath.split('/'));
  const desired = path.join(targetRoot.fsPath, ...desiredRelativePath.split('/'));
  await fs.mkdir(path.dirname(desired), { recursive: true });
  const temp = path.join(path.dirname(current), `.codemeld-case-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  // Two-step rename is required on the common case-insensitive APFS/NTFS configurations.
  await fs.rename(current, temp);
  try {
    await fs.rename(temp, desired);
  } catch (error) {
    try { await fs.rename(temp, current); } catch { /* best-effort rollback */ }
    throw error;
  }
}

export async function deleteDirectoryPair(root: vscode.Uri, relativePath: string): Promise<void> {
  const target = path.join(root.fsPath, ...relativePath.split('/'));
  await fs.rm(target, { recursive: true, force: true });
}

export async function copyMetadataField(sourceUri: vscode.Uri, targetUri: vscode.Uri, field: MetadataField): Promise<void> {
  const adapter = await getPlatformAdapter();
  await adapter.copyMetadataField(sourceUri.fsPath, targetUri.fsPath, field);
}

async function copyTransferableMetadata(source: string, target: string): Promise<void> {
  const adapter = await getPlatformAdapter();
  const s = await fs.lstat(source);
  try {
    if (adapter.capabilities.posixPermissions) await fs.chmod(target, s.mode & 0o7777);
  } catch { /* best effort */ }
  try { await fs.utimes(target, s.atime, s.mtime); } catch { /* best effort */ }
}
