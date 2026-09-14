import * as vscode from 'vscode';
import { DiffEngine } from '../core/DiffEngine';
import { Revision } from '../core/model';
import { compareDirectories, copyDirectoryPair, copyMetadataField, deleteDirectoryPair, syncTargetCase, DirectoryComparison, DirectoryExcludeFilter, FileMetadata, MetadataField, PlatformCapabilities, readDirectoryExcludeFilters, writeDirectoryExcludeFilters } from '../core/DirectoryDiff';

export interface ComparisonInput {
  leftUri: vscode.Uri;
  rightUri: vscode.Uri;
  leftText: string;
  rightText: string;
  revision: Revision;
}

export interface DirectoryComparisonInput {
  leftUri: vscode.Uri;
  rightUri: vscode.Uri;
  comparison: DirectoryComparison;
}

interface AppearanceSettings {
  /** null/undefined means: inherit from the active VS Code theme. */
  base?: string | null;
  add?: string | null;
  delete?: string | null;
  gutter?: string | null;
  editorBackground?: string | null;
  highlight: number;
}

const appearanceConfigurationKeys = {
  base: 'appearance.primary',
  add: 'appearance.add',
  delete: 'appearance.delete',
  gutter: 'appearance.gutter',
  editorBackground: 'appearance.editorBackground',
  highlight: 'appearance.highlight',
} as const;

function configuredColor(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function hasExplicitAppearanceConfiguration(): boolean {
  const configuration = vscode.workspace.getConfiguration('codemeld');
  return Object.values(appearanceConfigurationKeys).some(key => {
    const inspected = configuration.inspect(key);
    return inspected?.globalValue !== undefined || inspected?.workspaceValue !== undefined;
  });
}

function readAppearanceSettings(context?: vscode.ExtensionContext): AppearanceSettings {
  if (context && !hasExplicitAppearanceConfiguration()) {
    const legacy = context.globalState.get<AppearanceSettings>('codemeld.appearance');
    if (legacy) return { ...legacy, highlight: Number(legacy.highlight ?? 10) };
  }
  const configuration = vscode.workspace.getConfiguration('codemeld');
  return {
    base: configuredColor(configuration.get<string>(appearanceConfigurationKeys.base)),
    add: configuredColor(configuration.get<string>(appearanceConfigurationKeys.add)),
    delete: configuredColor(configuration.get<string>(appearanceConfigurationKeys.delete)),
    gutter: configuredColor(configuration.get<string>(appearanceConfigurationKeys.gutter)),
    editorBackground: configuredColor(configuration.get<string>(appearanceConfigurationKeys.editorBackground)),
    highlight: configuration.get<number>(appearanceConfigurationKeys.highlight, 10),
  };
}

function preferredConfigurationTarget(key: string): vscode.ConfigurationTarget {
  const inspected = vscode.workspace.getConfiguration('codemeld').inspect(key);
  if (inspected?.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
  return vscode.ConfigurationTarget.Global;
}

async function clearConfigurationAtAllScopes(key: string): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('codemeld');
  await configuration.update(key, undefined, vscode.ConfigurationTarget.Workspace);
  await configuration.update(key, undefined, vscode.ConfigurationTarget.Global);
}

async function writeAppearanceSettings(appearance: AppearanceSettings): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('codemeld');
  const colorEntries: Array<[string, string | null | undefined]> = [
    [appearanceConfigurationKeys.base, appearance.base],
    [appearanceConfigurationKeys.add, appearance.add],
    [appearanceConfigurationKeys.delete, appearance.delete],
    [appearanceConfigurationKeys.gutter, appearance.gutter],
    [appearanceConfigurationKeys.editorBackground, appearance.editorBackground],
  ];
  for (const [key, value] of colorEntries) {
    if (!value) await clearConfigurationAtAllScopes(key);
    else await configuration.update(key, value, preferredConfigurationTarget(key));
  }
  await configuration.update(
    appearanceConfigurationKeys.highlight,
    Math.max(5, Math.min(22, Number(appearance.highlight ?? 10))),
    preferredConfigurationTarget(appearanceConfigurationKeys.highlight),
  );
}

async function migrateLegacyAppearanceSettings(context: vscode.ExtensionContext): Promise<void> {
  const legacy = context.globalState.get<AppearanceSettings>('codemeld.appearance');
  if (!legacy || hasExplicitAppearanceConfiguration()) return;
  await writeAppearanceSettings({ ...legacy, highlight: Number(legacy.highlight ?? 10) });
  await context.globalState.update('codemeld.appearance', undefined);
}


interface ComparisonSession {
  type: 'file';
  id: string;
  leftUri: vscode.Uri;
  rightUri: vscode.Uri;
  leftText: string;
  rightText: string;
  savedLeftText: string;
  savedRightText: string;
  revision: Revision;
}


interface DirectorySession {
  type: 'directory';
  id: string;
  leftUri: vscode.Uri;
  rightUri: vscode.Uri;
  comparison: DirectoryComparison;
}

interface MetadataSession {
  type: 'metadata';
  id: string;
  parentSessionId: string;
  relativePath: string;
  leftUri: vscode.Uri;
  rightUri: vscode.Uri;
  leftName: string;
  rightName: string;
  isDirectory: boolean;
  leftMetadata: FileMetadata;
  rightMetadata: FileMetadata;
  capabilities: PlatformCapabilities;
}

type ManagerSession = ComparisonSession | DirectorySession | MetadataSession;
type WebviewMessage =
  | { type: 'ready' }
  | { type: 'contentChanged'; sessionId: string; leftText: string; rightText: string }
  | { type: 'recompute'; sessionId: string; leftText: string; rightText: string }
  | { type: 'save'; sessionId: string; side: 'left' | 'right'; leftText: string; rightText: string }
  | { type: 'closeSession'; sessionId: string }
  | { type: 'activateSession'; sessionId: string }
  | { type: 'appearance'; appearance: AppearanceSettings }
  | { type: 'directoryExcludeFilters'; filters: DirectoryExcludeFilter[] }
  | { type: 'directoryMerge'; sessionId: string; relativePath: string; targetSide: 'left' | 'right' }
  | { type: 'directoryDeleteUnmatched'; sessionId: string; relativePath: string; side: 'left' | 'right' }
  | { type: 'refreshDirectory'; sessionId: string }
  | { type: 'openDirectoryPair'; sessionId: string; relativePath: string; mode: 'content' | 'metadata' }
  | { type: 'openDirectoryPairModes'; sessionId: string; relativePath: string; modes: Array<'content' | 'metadata'> }
  | { type: 'openDirectoryPairAuto'; sessionId: string; relativePath: string; filters: string[] }
  | { type: 'copyMetadata'; sessionId: string; field: MetadataField; targetSide: 'left' | 'right' };

export class CompareManager {
  private static current: CompareManager | undefined;

  static showComparison(context: vscode.ExtensionContext, input: ComparisonInput): void {
    if (!CompareManager.current) {
      CompareManager.current = new CompareManager(context);
    }
    CompareManager.current.addComparison(input);
    CompareManager.current.panel.reveal(vscode.ViewColumn.Active, true);
  }

  static showDirectoryComparison(context: vscode.ExtensionContext, input: DirectoryComparisonInput): void {
    if (!CompareManager.current) {
      CompareManager.current = new CompareManager(context);
    }
    CompareManager.current.addDirectoryComparison(input);
    CompareManager.current.panel.reveal(vscode.ViewColumn.Active, true);
  }

  private readonly sessions = new Map<string, ManagerSession>();
  private readonly panel: vscode.WebviewPanel;
  private readonly engine = new DiffEngine();
  private webviewReady = false;
  private disposed = false;
  private closingAfterPrompt = false;
  private activeSessionId: string | undefined;
  private readonly configurationListener: vscode.Disposable;

  private constructor(private readonly context: vscode.ExtensionContext) {
    this.panel = this.createPanel();
    this.panel.webview.onDidReceiveMessage((message: unknown) => void this.onMessage(message));
    this.configurationListener = vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
      if (event.affectsConfiguration('codemeld.appearance')) {
        const appearance = readAppearanceSettings();
        if (this.webviewReady) void this.panel.webview.postMessage({ type: 'appearanceSettings', appearance });
      }
      if (event.affectsConfiguration('codemeld.directory.excludeFilters')) {
        const filters = readDirectoryExcludeFilters(this.context);
          if (this.webviewReady) void this.panel.webview.postMessage({ type: 'directoryExcludeFiltersSettings', filters });
        void this.refreshAllDirectorySessions();
      }
    });
    this.panel.onDidDispose(() => void this.onDisposed());
    void migrateLegacyAppearanceSettings(this.context);
  }

  private createPanel(): vscode.WebviewPanel {
    const extensionUri = this.context.extensionUri;
    const panel = vscode.window.createWebviewPanel(
      'codemeld.manager',
      'CodeMeld',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );
    const monacoVsUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'dist', 'monaco', 'vs'),
    );
    const appearance = readAppearanceSettings(this.context);
    panel.webview.html = managerHtml(panel.webview, monacoVsUri, appearance, readDirectoryExcludeFilters(this.context));
    return panel;
  }

  private addComparison(input: ComparisonInput): void {
    const existing = [...this.sessions.values()].find(
      session => session.type === 'file' && session.leftUri.toString() === input.leftUri.toString() && session.rightUri.toString() === input.rightUri.toString(),
    );
    if (existing) {
      this.activeSessionId = existing.id;
      if (this.webviewReady) {
        void this.panel.webview.postMessage({ type: 'activateSession', sessionId: existing.id });
      }
      return;
    }

    const session: ComparisonSession = {
      type: 'file',
      id: createSessionId(),
      leftUri: input.leftUri,
      rightUri: input.rightUri,
      leftText: input.leftText,
      rightText: input.rightText,
      savedLeftText: input.leftText,
      savedRightText: input.rightText,
      revision: input.revision,
    };
    this.sessions.set(session.id, session);
    this.activeSessionId = session.id;
    if (this.webviewReady) {
      void this.panel.webview.postMessage({ type: 'addSession', session: serializeSession(session), activate: true });
    }
  }


  private addDirectoryComparison(input: DirectoryComparisonInput): void {
    const existing = [...this.sessions.values()].find(session =>
      session.type === 'directory' && session.leftUri.toString() === input.leftUri.toString() && session.rightUri.toString() === input.rightUri.toString(),
    );
    if (existing) {
      this.activeSessionId = existing.id;
      if (this.webviewReady) void this.panel.webview.postMessage({ type: 'activateSession', sessionId: existing.id });
      return;
    }
    const session: DirectorySession = {
      type: 'directory', id: createSessionId(), leftUri: input.leftUri, rightUri: input.rightUri, comparison: input.comparison,
    };
    this.sessions.set(session.id, session);
    this.activeSessionId = session.id;
    if (this.webviewReady) void this.panel.webview.postMessage({ type: 'addSession', session: serializeSession(session), activate: true });
  }

  private async onMessage(message: unknown): Promise<void> {
    if (!isMessage(message)) return;

    if (message.type === 'ready') {
      this.webviewReady = true;
      for (const session of this.sessions.values()) {
        await this.panel.webview.postMessage({
          type: 'addSession',
          session: serializeSession(session),
          activate: session.id === this.activeSessionId,
        });
      }
      return;
    }

    if (message.type === 'appearance') {
      await writeAppearanceSettings(message.appearance);
      return;
    }

    if (message.type === 'directoryExcludeFilters') {
      const filters = await writeDirectoryExcludeFilters(this.context, message.filters);
      if (this.webviewReady) await this.panel.webview.postMessage({ type: 'directoryExcludeFiltersSettings', filters });
      // Refresh explicitly after Save. The configuration listener also covers
      // changes made through VS Code Settings, but the dialog must not depend
      // on configuration-event timing.
      await this.refreshAllDirectorySessions();
      return;
    }

    if (message.type === 'activateSession') {
      if (this.sessions.has(message.sessionId)) this.activeSessionId = message.sessionId;
      return;
    }

    const session = this.sessions.get(message.sessionId);
    if (!session) return;

    if (message.type === 'closeSession') {
      await this.requestCloseSession(session);
      return;
    }

    if (message.type === 'refreshDirectory' && session.type === 'directory') {
      await this.refreshDirectory(session);
      return;
    }
    if (message.type === 'directoryMerge' && session.type === 'directory') {
      await this.mergeDirectoryPair(session, message.relativePath, message.targetSide);
      return;
    }
    if (message.type === 'directoryDeleteUnmatched' && session.type === 'directory') {
      await this.deleteUnmatchedDirectoryItems(session, message.relativePath, message.side);
      return;
    }
    if (message.type === 'openDirectoryPair' && session.type === 'directory') {
      await this.openDirectoryPair(session, message.relativePath, message.mode);
      return;
    }
    if (message.type === 'openDirectoryPairModes' && session.type === 'directory') {
      for (const mode of message.modes) {
        await this.openDirectoryPair(session, message.relativePath, mode);
      }
      return;
    }
    if (message.type === 'openDirectoryPairAuto' && session.type === 'directory') {
      await this.openDirectoryPairAuto(session, message.relativePath, message.filters);
      return;
    }
    if (message.type === 'copyMetadata' && session.type === 'metadata') {
      await this.transferMetadata(session, message.field, message.targetSide);
      return;
    }
    if (session.type !== 'file') return;

    if (message.type === 'contentChanged') {
      session.leftText = message.leftText;
      session.rightText = message.rightText;
      return;
    }

    if (message.type === 'recompute') {
      session.leftText = message.leftText;
      session.rightText = message.rightText;
      session.revision = this.engine.diffText(session.leftText, session.rightText);
      await this.panel.webview.postMessage({
        type: 'revision',
        sessionId: session.id,
        revision: session.revision,
        leftDirty: session.leftText !== session.savedLeftText,
        rightDirty: session.rightText !== session.savedRightText,
      });
      return;
    }

    if (message.type === 'save') {
      session.leftText = message.leftText;
      session.rightText = message.rightText;
      await this.saveSide(session, message.side);
      await this.panel.webview.postMessage({
        type: 'saved',
        sessionId: session.id,
        side: message.side,
        savedText: message.side === 'left' ? session.savedLeftText : session.savedRightText,
      });
      return;
    }

  }

  private async saveSide(session: ComparisonSession, side: 'left' | 'right'): Promise<void> {
    const uri = side === 'left' ? session.leftUri : session.rightUri;
    const text = side === 'left' ? session.leftText : session.rightText;
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
    if (side === 'left') session.savedLeftText = text;
    else session.savedRightText = text;
    void vscode.window.setStatusBarMessage(`CodeMeld: saved ${vscode.workspace.asRelativePath(uri)}`, 1800);
  }

  private async saveDirtySides(session: ComparisonSession): Promise<void> {
    if (session.leftText !== session.savedLeftText) await this.saveSide(session, 'left');
    if (session.rightText !== session.savedRightText) await this.saveSide(session, 'right');
  }

  private async requestCloseSession(session: ManagerSession): Promise<void> {
    if (session.type !== 'file') {
      this.sessions.delete(session.id);
      if (this.activeSessionId === session.id) this.activeSessionId = undefined;
      await this.panel.webview.postMessage({ type: 'sessionClosed', sessionId: session.id });
      return;
    }
    const dirty = session.leftText !== session.savedLeftText || session.rightText !== session.savedRightText;
    if (dirty) {
      const choice = await vscode.window.showWarningMessage(
        `Save changes in ${basename(session.leftUri)} ↔ ${basename(session.rightUri)} before closing?`,
        { modal: true },
        'Save',
        "Don't Save",
      );
      if (!choice) {
        await this.panel.webview.postMessage({ type: 'closeCancelled', sessionId: session.id });
        return;
      }
      if (choice === 'Save') await this.saveDirtySides(session);
    }

    this.sessions.delete(session.id);
    if (this.activeSessionId === session.id) this.activeSessionId = undefined;
    await this.panel.webview.postMessage({ type: 'sessionClosed', sessionId: session.id });
  }


  private async refreshAllDirectorySessions(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.type === 'directory') await this.refreshDirectory(session, false);
    }
  }

  private async refreshDirectory(session: DirectorySession, showStatus = true): Promise<void> {
    try {
      session.comparison = await compareDirectories(session.leftUri, session.rightUri, readDirectoryExcludeFilters(this.context));
      await this.panel.webview.postMessage({ type: 'directoryUpdated', sessionId: session.id, comparison: session.comparison });
      if (showStatus) void vscode.window.setStatusBarMessage('CodeMeld: directory comparison refreshed', 1400);
    } catch (error) {
      void vscode.window.showErrorMessage(`CodeMeld: directory refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async mergeDirectoryPair(session: DirectorySession, relativePath: string, targetSide: 'left' | 'right'): Promise<void> {
    let selected = session.comparison.pairs.find(p => p.relativePath === relativePath);
    if (!selected) return;
    const sourceRoot = targetSide === 'left' ? session.rightUri : session.leftUri;
    const targetRoot = targetSide === 'left' ? session.leftUri : session.rightUri;
    const sourceKey = targetSide === 'left' ? 'right' : 'left';
    const targetKey = targetSide === 'left' ? 'left' : 'right';
    try {
      const sourceEntry = selected[sourceKey];
      const targetEntry = selected[targetKey];
      if (!sourceEntry) return;

      // A case conflict is a naming operation at directory-view level.
      // Do not copy/merge content here: double-click opens the file content merge separately.
      if (selected.caseDifferent && targetEntry) {
        await syncTargetCase(targetRoot, targetEntry.relativePath, sourceEntry.relativePath);
        session.comparison = await compareDirectories(session.leftUri, session.rightUri, readDirectoryExcludeFilters(this.context));
        await this.panel.webview.postMessage({ type: 'directoryUpdated', sessionId: session.id, comparison: session.comparison });
        return;
      }

      if (!selected.isDirectory) {
        const src = selected[sourceKey];
        const dst = selected[targetKey];
        if (!src) return;
        await copyDirectoryPair(sourceRoot, targetRoot, src.relativePath, dst?.relativePath ?? src.relativePath);
      } else {
        // For a selected directory, copy only entries missing on the target side.
        const selectedSourcePath = selected[sourceKey]?.relativePath ?? selected.relativePath;
        const prefix = `${selectedSourcePath}/`;
        const candidates = session.comparison.pairs.filter(p => {
          const sourcePath = p[sourceKey]?.relativePath;
          return !!sourcePath && (sourcePath === selectedSourcePath || sourcePath.startsWith(prefix)) && p[sourceKey] && !p[targetKey];
        });
        // Copy only top-most missing entries. Copying a missing directory recursively covers its children.
        const missing = candidates.filter(p => !candidates.some(parent => {
          const parentPath = parent[sourceKey]?.relativePath;
          const childPath = p[sourceKey]?.relativePath;
          return !!parentPath && !!childPath && parent.isDirectory && parentPath !== childPath && childPath.startsWith(`${parentPath}/`);
        }));
        for (const pair of missing) {
          const src = pair[sourceKey];
          if (src) await copyDirectoryPair(sourceRoot, targetRoot, src.relativePath, src.relativePath);
        }
      }
      session.comparison = await compareDirectories(session.leftUri, session.rightUri, readDirectoryExcludeFilters(this.context));
      await this.panel.webview.postMessage({ type: 'directoryUpdated', sessionId: session.id, comparison: session.comparison });
    } catch (error) {
      void vscode.window.showErrorMessage(`CodeMeld: directory transfer failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async deleteUnmatchedDirectoryItems(session: DirectorySession, relativePath: string, side: 'left' | 'right'): Promise<void> {
    const selected = session.comparison.pairs.find(p => p.relativePath === relativePath);
    if (!selected) return;
    const root = side === 'left' ? session.leftUri : session.rightUri;
    const sideKey = side;
    const otherKey = side === 'left' ? 'right' : 'left';
    try {
      const scope = selected.isDirectory
        ? session.comparison.pairs.filter(p => p.relativePath === relativePath || p.relativePath.startsWith(`${relativePath}/`))
        : [selected];
      const unmatched = scope.filter(p => p[sideKey] && !p[otherKey]);
      // Delete only top-most unmatched entries. Deleting an unmatched directory recursively covers its children.
      const roots = unmatched.filter(p => !unmatched.some(parent =>
        parent.isDirectory && parent.relativePath !== p.relativePath && p.relativePath.startsWith(`${parent.relativePath}/`),
      ));
      for (const pair of roots) { const entry = pair[sideKey]; if (entry) await deleteDirectoryPair(root, entry.relativePath); }
      session.comparison = await compareDirectories(session.leftUri, session.rightUri, readDirectoryExcludeFilters(this.context));
      await this.panel.webview.postMessage({ type: 'directoryUpdated', sessionId: session.id, comparison: session.comparison });
    } catch (error) {
      void vscode.window.showErrorMessage(`CodeMeld: delete failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }


  private async openDirectoryPairAuto(session: DirectorySession, relativePath: string, filters: string[]): Promise<void> {
    const pair = session.comparison.pairs.find(p => p.relativePath === relativePath);
    if (!pair?.left || !pair?.right) return;

    const active = new Set(filters);
    const noFilters = active.size === 0;
    const wantsContent = noFilters || active.has('content');
    const wantsMetadata = noFilters || active.has('timeMetadata') || active.has('otherMetadata');

    const modes: Array<'content' | 'metadata'> = [];
    if (wantsContent && !pair.isDirectory && (pair.contentDifferent || pair.caseDifferent)) modes.push('content');
    if (wantsMetadata && pair.metadataDifferent) modes.push('metadata');

    console.log(`[CodeMeld] open ${relativePath}: filters=[${filters.join(',')}], content=${pair.contentDifferent}, metadata=${pair.metadataDifferent}, modes=[${modes.join(',')}]`);

    for (const mode of modes) {
      await this.openDirectoryPair(session, relativePath, mode);
    }
  }

  private async openDirectoryPair(session: DirectorySession, relativePath: string, mode: 'content' | 'metadata'): Promise<void> {
    const pair = session.comparison.pairs.find(p => p.relativePath === relativePath);
    if (!pair?.left || !pair?.right) return;
    const leftUri = vscode.Uri.parse(pair.left.uri);
    const rightUri = vscode.Uri.parse(pair.right.uri);
    if (mode === 'content') {
      if (pair.isDirectory || (!pair.contentDifferent && !pair.caseDifferent)) return;
      const decoder = new TextDecoder('utf-8');
      const [lb, rb] = await Promise.all([vscode.workspace.fs.readFile(leftUri), vscode.workspace.fs.readFile(rightUri)]);
      this.addComparison({ leftUri, rightUri, leftText: decoder.decode(lb), rightText: decoder.decode(rb), revision: this.engine.diffText(decoder.decode(lb), decoder.decode(rb)) });
      return;
    }
    if (!pair.metadataDifferent) return;
    const existing = [...this.sessions.values()].find(s => s.type === 'metadata' && s.leftUri.toString() === leftUri.toString() && s.rightUri.toString() === rightUri.toString());
    if (existing) {
      this.activeSessionId = existing.id;
      await this.panel.webview.postMessage({ type: 'activateSession', sessionId: existing.id });
      return;
    }
    const meta: MetadataSession = {
      type: 'metadata', id: createSessionId(), parentSessionId: session.id, relativePath,
      leftUri, rightUri, leftName: pair.left.name, rightName: pair.right.name, isDirectory: pair.isDirectory,
      leftMetadata: pair.left.metadata, rightMetadata: pair.right.metadata, capabilities: session.comparison.capabilities,
    };
    this.sessions.set(meta.id, meta); this.activeSessionId = meta.id;
    await this.panel.webview.postMessage({ type: 'addSession', session: serializeSession(meta), activate: true });
  }

  private async transferMetadata(session: MetadataSession, field: MetadataField, targetSide: 'left' | 'right'): Promise<void> {
    const source = targetSide === 'left' ? session.rightUri : session.leftUri;
    const target = targetSide === 'left' ? session.leftUri : session.rightUri;
    try {
      await copyMetadataField(source, target, field);
      const parent = this.sessions.get(session.parentSessionId);
      if (parent?.type === 'directory') {
        parent.comparison = await compareDirectories(parent.leftUri, parent.rightUri, readDirectoryExcludeFilters(this.context));
        const pair = parent.comparison.pairs.find(p => p.relativePath === session.relativePath);
        if (pair?.left && pair.right) {
          session.leftMetadata = pair.left.metadata;
          session.rightMetadata = pair.right.metadata;
        }
        await this.panel.webview.postMessage({ type: 'directoryUpdated', sessionId: parent.id, comparison: parent.comparison });
      }
      await this.panel.webview.postMessage({ type: 'metadataUpdated', sessionId: session.id, leftMetadata: session.leftMetadata, rightMetadata: session.rightMetadata });
    } catch (error) {
      void vscode.window.showErrorMessage(`CodeMeld: cannot transfer metadata: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async onDisposed(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.configurationListener.dispose();
    this.webviewReady = false;
    CompareManager.current = undefined;

    if (this.closingAfterPrompt || this.sessions.size === 0) return;
    const dirtySessions = [...this.sessions.values()].filter(
      (session): session is ComparisonSession => session.type === 'file' && (session.leftText !== session.savedLeftText || session.rightText !== session.savedRightText),
    );
    if (dirtySessions.length === 0) return;

    const choice = await vscode.window.showWarningMessage(
      `CodeMeld has unsaved changes in ${dirtySessions.length} comparison${dirtySessions.length === 1 ? '' : 's'}. Save before closing?`,
      { modal: true },
      'Save All',
      "Don't Save",
    );

    if (choice === 'Save All') {
      for (const session of dirtySessions) await this.saveDirtySides(session);
      return;
    }
    if (choice === "Don't Save") return;

    // VS Code does not expose a cancellable WebviewPanel close event. Re-open the manager on Cancel.
    const replacement = new CompareManager(this.context);
    for (const session of this.sessions.values()) replacement.sessions.set(session.id, session);
    replacement.activeSessionId = this.activeSessionId;
    CompareManager.current = replacement;
    replacement.panel.reveal(vscode.ViewColumn.Active, true);
  }
}

function createSessionId(): string {
  return `cmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function basename(uri: vscode.Uri): string {
  return uri.path.split('/').filter(Boolean).at(-1) ?? uri.path;
}

function languageFor(uri: vscode.Uri): string {
  const name = basename(uri).toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  const map: Record<string, string> = {
    c: 'c', h: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml', html: 'html', css: 'css',
    sh: 'shell', bash: 'shell', zsh: 'shell', py: 'python', java: 'java', rs: 'rust', go: 'go',
    md: 'markdown', sql: 'sql', ini: 'ini', toml: 'ini', txt: 'plaintext',
  };
  return map[ext] ?? 'plaintext';
}

function serializeSession(session: ManagerSession) {
  if (session.type === 'directory') return {
    type: 'directory', id: session.id, leftName: basename(session.leftUri), rightName: basename(session.rightUri), comparison: session.comparison,
  };
  if (session.type === 'metadata') return {
    type: 'metadata', id: session.id, leftName: session.leftName, rightName: session.rightName, relativePath: session.relativePath, isDirectory: session.isDirectory,
    leftMetadata: session.leftMetadata, rightMetadata: session.rightMetadata, capabilities: session.capabilities,
  };
  return {
    type: 'file', id: session.id,
    leftName: basename(session.leftUri), rightName: basename(session.rightUri), leftText: session.leftText, rightText: session.rightText,
    savedLeftText: session.savedLeftText, savedRightText: session.savedRightText,
    leftLanguage: languageFor(session.leftUri), rightLanguage: languageFor(session.rightUri), revision: session.revision,
  };
}

function isMessage(value: unknown): value is WebviewMessage {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'ready' || type === 'contentChanged' || type === 'recompute' || type === 'save' ||
    type === 'closeSession' || type === 'activateSession' || type === 'appearance' || type === 'directoryExcludeFilters' || type === 'directoryMerge' || type === 'directoryDeleteUnmatched' || type === 'refreshDirectory' || type === 'openDirectoryPair' || type === 'openDirectoryPairModes' || type === 'openDirectoryPairAuto' || type === 'copyMetadata';
}

function managerHtml(webview: vscode.Webview, monacoVsUri: vscode.Uri, appearance: AppearanceSettings | undefined, directoryExcludeFilters: DirectoryExcludeFilter[]): string {
  const payload = JSON.stringify({ monacoVsUri: monacoVsUri.toString(), appearance, directoryExcludeFilters }).replace(/</g, '\\u003c');
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'unsafe-inline' 'unsafe-eval'`,
    `font-src ${webview.cspSource}`,
    `worker-src ${webview.cspSource} blob:`,
  ].join('; ');

  return `<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root {
  --codemeld-blue:var(--vscode-focusBorder, #4FA3FF);
  --codemeld-merge:var(--vscode-focusBorder, #67B3FF);
  --codemeld-add:var(--vscode-gitDecoration-addedResourceForeground, #34C759);
  --codemeld-delete:var(--vscode-gitDecoration-deletedResourceForeground, #FF453A);
  --codemeld-gutter:var(--vscode-editorWidget-background, var(--vscode-editor-background));
  --codemeld-editor-bg:var(--vscode-editor-background);
  --codemeld-row-alt:color-mix(in srgb,var(--codemeld-editor-bg) 94%,var(--vscode-editor-foreground) 6%);
  --codemeld-highlight-pct:10%;
}
*{box-sizing:border-box}
html,body{height:100%;margin:0;overflow:hidden;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}
button{font:inherit}
#manager{height:100%;display:flex;flex-direction:column;min-width:0}
#managerHeader{height:38px;flex:0 0 38px;display:flex;align-items:stretch;border-bottom:1px solid rgba(255,255,255,.08);background:color-mix(in srgb,var(--vscode-editor-background) 94%,black);min-width:0}
#tabsViewport{flex:1;min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.15) transparent}
#tabsViewport::-webkit-scrollbar{height:4px}#tabsViewport::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:4px}
#tabs{height:100%;display:flex;align-items:stretch;width:max-content;min-width:100%}
.compareTab{height:100%;min-width:150px;max-width:310px;display:flex;align-items:center;gap:7px;padding:0 8px 0 11px;border:0;border-right:1px solid rgba(255,255,255,.06);background:transparent;color:rgba(255,255,255,.58);cursor:pointer;position:relative}
.compareTab:hover{background:rgba(255,255,255,.035);color:rgba(255,255,255,.82)}
.compareTab.active{background:var(--vscode-editor-background);color:var(--vscode-editor-foreground)}
.compareTab.active::after{content:"";position:absolute;left:8px;right:8px;bottom:0;height:2px;background:var(--codemeld-blue);border-radius:2px 2px 0 0}
.tabLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:left;font-size:12px}
.dirtyDot{width:6px;height:6px;border-radius:50%;background:var(--codemeld-blue);box-shadow:0 0 6px color-mix(in srgb,var(--codemeld-blue) 45%,transparent);display:none;flex:0 0 6px}.compareTab.dirty .dirtyDot{display:block}
.tabClose{width:20px;height:20px;border:0;border-radius:5px;padding:0;display:grid;place-items:center;background:transparent;color:rgba(255,255,255,.45);cursor:pointer;font-size:16px;line-height:1}.tabClose:hover{background:rgba(255,255,255,.08);color:rgba(255,255,255,.9)}
#managerActions{flex:0 0 auto;display:flex;align-items:center;padding:0 6px;border-left:1px solid rgba(255,255,255,.07)}
.settingsButton,.iconButton,.applyAllButton{display:grid;place-items:center;padding:0;border:1px solid transparent;background:transparent;cursor:pointer;color:rgba(255,255,255,.58)}
.settingsButton{width:28px;height:28px;border-radius:8px}.settingsButton:hover,.settingsButton.active{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.08);color:rgba(255,255,255,.92)}
.settingsButton svg,.iconButton svg,.applyAllButton svg{fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round}
.settingsButton svg{width:17px;height:17px;stroke-width:1.65}
#workspace{flex:1;min-height:0;position:relative}
#emptyState{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--vscode-descriptionForeground);font-size:13px;user-select:none}.hasSessions #emptyState{display:none}
#sessionHost{position:absolute;inset:0}.comparisonView{position:absolute;inset:0;display:none}.comparisonView.active{display:block}
.compareGrid{height:100%;display:grid;grid-template-columns:minmax(0,1fr) 116px minmax(0,1fr)}
.pane{min-width:0;display:flex;flex-direction:column;overflow:hidden}.title{height:34px;flex:0 0 34px;display:flex;align-items:center;gap:6px;padding:0 8px 0 10px;border-bottom:1px solid rgba(255,255,255,.08);font-size:12px}.title .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.titleControls{display:flex;align-items:center;gap:2px}
.iconButton{width:28px;height:28px;border-radius:7px}.iconButton:hover{color:rgba(255,255,255,.92);background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.08)}.iconButton svg{width:17px;height:17px;stroke-width:1.65}.iconButton:active{transform:scale(.96)}
.saveButton{height:26px;padding:0 9px;border:1px solid var(--vscode-button-border,transparent);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-radius:6px;cursor:pointer}.saveButton:hover{background:var(--vscode-button-secondaryHoverBackground)}
.editor{flex:1;min-height:0;outline:1px solid transparent;outline-offset:-1px;background:var(--codemeld-editor-bg)}.codemeld-zebra-row{background:var(--codemeld-row-alt)}.editor.focused{outline-color:var(--vscode-focusBorder)}
.gutter{position:relative;background:var(--codemeld-gutter);border-left:1px solid rgba(255,255,255,.08);border-right:1px solid rgba(255,255,255,.08);overflow:hidden}.gutterTitle{height:34px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:center;gap:8px}.applyAllButton{width:30px;height:28px;border-radius:8px;color:color-mix(in srgb,var(--codemeld-blue) 78%,white)}.applyAllButton:hover{color:color-mix(in srgb,var(--codemeld-blue) 65%,white);background:color-mix(in srgb,var(--codemeld-blue) 18%,transparent);border-color:color-mix(in srgb,var(--codemeld-blue) 55%,transparent);box-shadow:0 0 12px color-mix(in srgb,var(--codemeld-blue) 22%,transparent)}.applyAllButton svg{width:19px;height:19px;stroke-width:1.7}
.diffSvg,.actions{position:absolute;top:34px;left:0;width:100%;height:calc(100% - 34px)}.diffSvg{pointer-events:none}.actions{pointer-events:none}
path.connector{fill:color-mix(in srgb,var(--codemeld-blue) 9%,transparent);stroke:none;opacity:.74;filter:url(#bridgeBlur);transition:opacity .12s ease,filter .12s ease,fill .12s ease}path.connector.hover-merge{fill:color-mix(in srgb,var(--codemeld-merge) 16%,transparent);opacity:.98}path.connector.hover-add{fill:color-mix(in srgb,var(--codemeld-add) 16%,transparent);opacity:.98}path.connector.hover-delete{fill:color-mix(in srgb,var(--codemeld-delete) 16%,transparent);opacity:.98}
circle.bridgeEndpoint{fill:var(--codemeld-blue);opacity:.68}circle.bridgeEndpoint.hover-merge{fill:var(--codemeld-merge);opacity:.92}circle.bridgeEndpoint.hover-add{fill:var(--codemeld-add);opacity:.92}circle.bridgeEndpoint.hover-delete{fill:var(--codemeld-delete);opacity:.92}
.actionZone{position:absolute;width:50%;min-height:30px;padding:0;margin:0;border:0;background:transparent;pointer-events:auto;z-index:3;cursor:pointer}.actionZone.left{left:0}.actionZone.right{right:0}.actionZone:focus-visible{outline:none}
.codemeld-row-default{background:color-mix(in srgb,var(--codemeld-blue) 7.5%,transparent);box-shadow:inset 2px 0 0 color-mix(in srgb,var(--codemeld-blue) 22%,transparent)}.codemeld-row-hover-merge{background:color-mix(in srgb,var(--codemeld-merge) 10%,transparent);box-shadow:inset 2px 0 0 color-mix(in srgb,var(--codemeld-merge) 35%,transparent)}.codemeld-row-hover-add{background:color-mix(in srgb,var(--codemeld-add) 9%,transparent);box-shadow:inset 2px 0 0 color-mix(in srgb,var(--codemeld-add) 32%,transparent)}.codemeld-row-hover-delete{background:color-mix(in srgb,var(--codemeld-delete) 8.5%,transparent);box-shadow:inset 2px 0 0 color-mix(in srgb,var(--codemeld-delete) 32%,transparent)}
.codemeld-inner-default{background:color-mix(in srgb,var(--codemeld-blue) 28%,transparent);border-radius:2px}.codemeld-inner-hover-merge{background:color-mix(in srgb,var(--codemeld-merge) 36%,transparent);border-radius:2px}.codemeld-inner-hover-add{background:color-mix(in srgb,var(--codemeld-add) 30%,transparent);border-radius:2px}.codemeld-inner-hover-delete{background:color-mix(in srgb,var(--codemeld-delete) 30%,transparent);border-radius:2px}

/* Directory comparison */
.directoryView{height:100%;display:flex;flex-direction:column;background:var(--vscode-editor-background)}
.dirToolbar{height:42px;flex:0 0 42px;display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:7px;padding:0 10px;border-bottom:1px solid rgba(255,255,255,.08);background:color-mix(in srgb,var(--vscode-editor-background) 96%,black)}
.dirFilters{display:flex;gap:6px;min-width:0;overflow-x:auto}.dirFilter{height:27px;padding:0 10px;border:1px solid rgba(255,255,255,.09);border-radius:7px;background:transparent;color:var(--vscode-descriptionForeground);cursor:pointer;white-space:nowrap;font-size:11px}.dirFilter:hover{background:rgba(255,255,255,.05);color:var(--vscode-foreground)}.dirFilter.active{background:color-mix(in srgb,var(--codemeld-blue) 15%,transparent);border-color:color-mix(in srgb,var(--codemeld-blue) 45%,transparent);color:color-mix(in srgb,var(--codemeld-blue) 55%,white)}
.dirMergeControls{display:flex;gap:4px;justify-self:center}.dirRefreshSlot{justify-self:end;display:flex;align-items:center;gap:5px}.dirMergeButton{width:30px;height:28px;display:grid;place-items:center;border:1px solid transparent;border-radius:8px;background:transparent;color:color-mix(in srgb,var(--codemeld-blue) 75%,white);cursor:pointer}.dirMergeButton.deleteButton{color:color-mix(in srgb,var(--codemeld-delete) 78%,white)}.dirMergeButton:disabled{opacity:.22;cursor:default}.dirMergeButton:not(:disabled):hover{background:color-mix(in srgb,var(--codemeld-blue) 16%,transparent);border-color:color-mix(in srgb,var(--codemeld-blue) 45%,transparent)}.dirMergeButton.deleteButton:not(:disabled):hover{background:color-mix(in srgb,var(--codemeld-delete) 14%,transparent);border-color:color-mix(in srgb,var(--codemeld-delete) 42%,transparent)}.dirMergeButton svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.dirGrid{flex:1 1 0;min-height:0;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr) 72px minmax(0,1fr)}.dirPane{min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}.dirPath{height:34px;flex:0 0 34px;display:flex;align-items:center;padding:0 11px;border-bottom:1px solid rgba(255,255,255,.08);font-size:11px;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dirCenter{min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:var(--codemeld-gutter);border-left:1px solid rgba(255,255,255,.07);border-right:1px solid rgba(255,255,255,.07)}.dirCenterHeader{height:34px;flex:0 0 34px;border-bottom:1px solid rgba(255,255,255,.08)}.dirCenterRows{flex:1 1 0;min-height:0;overflow:hidden;font-size:12px}.dirRows{flex:1 1 0;height:0;min-height:0;overflow-y:scroll;overflow-x:auto;overscroll-behavior:contain;font-size:12px;scrollbar-width:thin;scrollbar-gutter:stable}.dirRows::-webkit-scrollbar{width:8px;height:8px}.dirRows::-webkit-scrollbar-thumb{background:rgba(255,255,255,.18);border-radius:8px}.dirRows::-webkit-scrollbar-track{background:transparent}
.dirRow{height:25px;display:flex;align-items:center;gap:6px;padding-right:8px;border-bottom:1px solid rgba(255,255,255,.025);cursor:default;user-select:none;white-space:nowrap;background:var(--codemeld-editor-bg)}.dirRows .dirRow:nth-child(even){background:var(--codemeld-row-alt)}.dirRow:hover{background:rgba(255,255,255,.035)}.dirRow.selected{background:color-mix(in srgb,var(--codemeld-blue) 12%,transparent);box-shadow:inset 2px 0 color-mix(in srgb,var(--codemeld-blue) 42%,transparent)}.dirRow.missing{color:var(--vscode-descriptionForeground)}.dirIndent{display:inline-block;flex:0 0 auto}.dirTwisty{width:14px;height:18px;display:grid;place-items:center;color:var(--vscode-descriptionForeground);font-size:10px;cursor:pointer;flex:0 0 14px}.dirTwisty.empty{visibility:hidden}.dirStatus{width:9px;height:9px;border-radius:50%;flex:0 0 9px;background:#34C759;box-shadow:0 0 5px rgba(52,199,89,.22)}.dirStatus.missing{background:transparent;border:1px solid rgba(255,255,255,.22);box-shadow:none}.dirName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dirFolder{font-weight:500}.dirDiffRow{height:25px;display:flex;align-items:center;justify-content:center;gap:6px;border-bottom:1px solid rgba(255,255,255,.025);background:var(--codemeld-editor-bg);user-select:none}.dirCenterRows .dirDiffRow:nth-child(even){background:var(--codemeld-row-alt)}.dirDiffRow.selected{background:color-mix(in srgb,var(--codemeld-blue) 10%,transparent)}.dirDiffMarker{display:none;align-items:center;justify-content:center;flex:0 0 auto;cursor:default}.dirDiffMarker.visible{display:flex}.dirDiffMarker.content{width:9px;height:9px;border-radius:50%;background:#FF9F0A;box-shadow:0 0 5px rgba(255,159,10,.3)}.dirDiffMarker.metadata{width:9px;height:9px;border-radius:50%;background:#FF6FB5;box-shadow:0 0 5px rgba(255,111,181,.28);cursor:pointer}.dirDiffMarker.case{min-width:28px;height:16px;padding:0 4px;border-radius:5px;color:#C7A7FF;background:rgba(175,124,255,.10);font-size:9px;font-weight:700;letter-spacing:-.2px;cursor:default}
.directoryFiltersButton{height:28px;padding:0 9px;display:flex;align-items:center;gap:6px;border:1px solid rgba(255,255,255,.08);border-radius:8px;background:transparent;color:var(--vscode-descriptionForeground);font-size:11px;cursor:pointer}.directoryFiltersButton:hover{background:rgba(255,255,255,.05);color:var(--vscode-foreground)}.directoryFiltersButton.active{color:color-mix(in srgb,var(--codemeld-blue) 60%,white);border-color:color-mix(in srgb,var(--codemeld-blue) 35%,transparent);background:color-mix(in srgb,var(--codemeld-blue) 9%,transparent)}.directoryFiltersButton svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.filterCount{min-width:15px;height:15px;padding:0 4px;display:inline-grid;place-items:center;border-radius:8px;background:color-mix(in srgb,var(--codemeld-blue) 16%,transparent);font-size:9px}.filterCount:empty{display:none}.dirEmpty{padding:18px;color:var(--vscode-descriptionForeground);font-size:12px}
/* Metadata comparison */
.metadataView{height:100%;display:flex;flex-direction:column}.metadataHeader{height:40px;display:grid;grid-template-columns:1fr 100px 1fr;align-items:center;border-bottom:1px solid rgba(255,255,255,.08);font-size:12px}.metadataHeader>div{padding:0 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.metadataHeader .middle{text-align:center;color:var(--vscode-descriptionForeground)}.metadataTable{width:min(920px,calc(100% - 40px));margin:22px auto;border:1px solid rgba(255,255,255,.08);border-radius:10px;overflow:hidden}.metadataRow{min-height:42px;display:grid;grid-template-columns:minmax(0,1fr) 150px minmax(0,1fr);align-items:center;border-bottom:1px solid rgba(255,255,255,.06);background:var(--codemeld-editor-bg)}.metadataRow:nth-child(even){background:var(--codemeld-row-alt)}.metadataRow:last-child{border-bottom:0}.metadataValue{padding:8px 12px;font-family:var(--vscode-editor-font-family);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.metadataActions{display:flex;align-items:center;justify-content:center;gap:5px}.metaArrow{width:29px;height:27px;border:1px solid transparent;border-radius:7px;background:transparent;color:color-mix(in srgb,var(--codemeld-blue) 75%,white);cursor:pointer}.metaArrow:hover{background:color-mix(in srgb,var(--codemeld-blue) 14%,transparent);border-color:color-mix(in srgb,var(--codemeld-blue) 40%,transparent)}.metaLabel{display:block;text-align:center;font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:2px}.metadataDifferent{box-shadow:inset 3px 0 0 color-mix(in srgb,#FF6FB5 40%,transparent);background-image:linear-gradient(color-mix(in srgb,#FF6FB5 6%,transparent),color-mix(in srgb,#FF6FB5 6%,transparent))}
#settingsOverlay{position:fixed;inset:0;z-index:1000;display:none;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.18);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px)}#settingsOverlay.open{display:flex}#settingsDialog{width:320px;max-width:calc(100vw - 40px);max-height:calc(100vh - 40px);overflow:auto;padding:14px 16px 16px;border:1px solid rgba(255,255,255,.09);border-radius:14px;background:color-mix(in srgb,var(--vscode-editorWidget-background) 96%,transparent);color:var(--vscode-editorWidget-foreground);box-shadow:0 18px 50px rgba(0,0,0,.42),0 0 0 1px rgba(255,255,255,.03);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
.settingsHeader{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}.settingsTitle{font-size:12px;font-weight:600}.settingsClose{width:26px;height:26px;display:grid;place-items:center;border:0;border-radius:7px;background:transparent;color:var(--vscode-descriptionForeground);cursor:pointer;font-size:18px}.settingsClose:hover{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-foreground)}.settingRow{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;min-height:38px;font-size:12px;color:var(--vscode-foreground)}.settingControl{display:flex;align-items:center;gap:7px}.settingMode{height:25px;min-width:74px;border:1px solid var(--vscode-dropdown-border,transparent);border-radius:6px;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);padding:0 5px;font-size:11px}.settingRow input[type=color]{width:34px;height:25px;border:0;border-radius:7px;padding:0;background:transparent;cursor:pointer}.settingRow input[type=color]:disabled{opacity:.28;cursor:default}.settingRow input[type=range]{width:112px;accent-color:var(--codemeld-blue)}.settingsFooter{display:flex;justify-content:flex-end;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.07)}.resetButton{height:27px;padding:0 9px;border:1px solid rgba(255,255,255,.09);border-radius:7px;background:transparent;color:rgba(255,255,255,.68);cursor:pointer}.resetButton:hover{background:rgba(255,255,255,.06);color:white}
#directoryFiltersOverlay{position:fixed;inset:0;z-index:1001;display:none;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.22);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px)}#directoryFiltersOverlay.open{display:flex}#directoryFiltersDialog{width:min(650px,calc(100vw - 40px));max-height:calc(100vh - 40px);display:flex;flex-direction:column;border:1px solid rgba(255,255,255,.09);border-radius:14px;background:color-mix(in srgb,var(--vscode-editorWidget-background) 97%,transparent);color:var(--vscode-editorWidget-foreground);box-shadow:0 18px 50px rgba(0,0,0,.45);overflow:hidden}.excludeHelp{padding:0 16px 10px;color:var(--vscode-descriptionForeground);font-size:11px;line-height:1.45}.excludeTableHeader{display:grid;grid-template-columns:minmax(120px,.72fr) minmax(180px,1.28fr) 30px;gap:8px;padding:8px 16px;border-top:1px solid rgba(255,255,255,.07);border-bottom:1px solid rgba(255,255,255,.07);font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:var(--vscode-descriptionForeground)}#excludeRows{min-height:80px;max-height:44vh;overflow:auto;padding:8px 16px}.excludeRow{display:grid;grid-template-columns:minmax(120px,.72fr) minmax(180px,1.28fr) 30px;gap:8px;align-items:center;margin-bottom:7px}.excludeInput{height:29px;min-width:0;padding:0 8px;border:1px solid var(--vscode-input-border,rgba(255,255,255,.12));border-radius:6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit;font-size:11px;outline:none}.excludeInput:focus{border-color:var(--vscode-focusBorder)}.excludeDelete{width:28px;height:28px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--vscode-descriptionForeground);cursor:pointer;font-size:17px}.excludeDelete:hover{color:var(--codemeld-delete);background:color-mix(in srgb,var(--codemeld-delete) 10%,transparent)}.excludeEmpty{padding:18px 4px;color:var(--vscode-descriptionForeground);font-size:11px;text-align:center}.excludeFooter{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 16px 14px;border-top:1px solid rgba(255,255,255,.07)}.excludeFooterRight{display:flex;gap:7px}.dialogButton{height:29px;padding:0 11px;border:1px solid rgba(255,255,255,.10);border-radius:7px;background:transparent;color:var(--vscode-foreground);cursor:pointer}.dialogButton:hover{background:rgba(255,255,255,.06)}.dialogButton.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:var(--vscode-button-border,transparent)}.dialogButton.primary:hover{background:var(--vscode-button-hoverBackground)}
</style>
</head>
<body>
<div id="manager">
  <div id="managerHeader">
    <div id="tabsViewport"><div id="tabs"></div></div>
    <div id="managerActions"><button class="settingsButton" id="settingsButton" title="CodeMeld appearance" aria-label="CodeMeld appearance"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></svg></button></div>
  </div>
  <div id="workspace"><div id="emptyState">No comparisons open</div><div id="sessionHost"></div></div>
</div>
<div id="settingsOverlay" aria-hidden="true"><div id="settingsDialog" role="dialog" aria-modal="true" aria-label="CodeMeld appearance settings" tabindex="-1"><div class="settingsHeader"><div class="settingsTitle">Appearance</div><button id="settingsClose" class="settingsClose" aria-label="Close settings">×</button></div><div class="settingRow"><span>Primary</span><span class="settingControl"><select class="settingMode" id="baseMode"><option value="theme">VS Code</option><option value="custom">Custom</option></select><input id="baseColor" type="color" value="#4FA3FF"></span></div><div class="settingRow"><span>Add</span><span class="settingControl"><select class="settingMode" id="addMode"><option value="theme">VS Code</option><option value="custom">Custom</option></select><input id="addColor" type="color" value="#34C759"></span></div><div class="settingRow"><span>Delete</span><span class="settingControl"><select class="settingMode" id="deleteMode"><option value="theme">VS Code</option><option value="custom">Custom</option></select><input id="deleteColor" type="color" value="#FF453A"></span></div><div class="settingRow"><span>Editor background</span><span class="settingControl"><select class="settingMode" id="editorBackgroundMode"><option value="theme">VS Code</option><option value="custom">Custom</option></select><input id="editorBackgroundColor" type="color" value="#1E1E1E"></span></div><div class="settingRow"><span>Gutter</span><span class="settingControl"><select class="settingMode" id="gutterMode"><option value="theme">VS Code</option><option value="custom">Custom</option></select><input id="gutterColor" type="color" value="#181A1F"></span></div><label class="settingRow"><span>Highlight</span><input id="highlightOpacity" type="range" min="5" max="22" value="10"></label><div class="settingsFooter"><button id="resetAppearance" class="resetButton">Use VS Code theme</button></div></div></div>
<div id="directoryFiltersOverlay" aria-hidden="true"><div id="directoryFiltersDialog" role="dialog" aria-modal="true" aria-label="Directory exclusion filters" tabindex="-1"><div class="settingsHeader" style="padding:14px 16px 4px"><div class="settingsTitle">Directory exclusion filters</div><button id="directoryFiltersClose" class="settingsClose" aria-label="Close directory filters">×</button></div><div class="excludeHelp">Excluded before analysis. A mask without <code>/</code> matches any file or folder name. Use <code>*</code>, <code>?</code> and <code>**</code>; a trailing <code>/</code> means directories only. Examples: <code>.git/</code>, <code>node_modules/</code>, <code>*.log</code>, <code>build/**</code>.</div><div class="excludeTableHeader"><span>Name</span><span>Mask</span><span></span></div><div id="excludeRows"></div><div class="excludeFooter"><button id="addExcludeFilter" class="dialogButton">+ Add filter</button><div class="excludeFooterRight"><button id="cancelExcludeFilters" class="dialogButton">Cancel</button><button id="saveExcludeFilters" class="dialogButton primary">Save</button></div></div></div></div>
<script>
const vscode=acquireVsCodeApi();const boot=${payload};window.require={paths:{vs:boot.monacoVsUri}};
</script>
<script src="${monacoVsUri.toString()}/loader.js"></script>
<script>
require(['vs/editor/editor.main'],function(){
const manager=document.getElementById('manager');const tabs=document.getElementById('tabs');const tabsViewport=document.getElementById('tabsViewport');const host=document.getElementById('sessionHost');const sessionMap=new Map();let activeId=null;
const appearanceDefaults={base:null,add:null,delete:null,gutter:null,editorBackground:null,highlight:10};
const persistedState=vscode.getState()||{};
function migrateAppearance(raw){if(!raw)return{...appearanceDefaults};return{...appearanceDefaults,...raw,highlight:Number(raw.highlight??10)}}
let appearance=migrateAppearance(boot.appearance||{});
function normalizeDirectoryExcludeFilters(raw){if(!Array.isArray(raw))return[];return raw.map(x=>({name:String(x&&x.name||'').trim(),pattern:String(x&&x.pattern||'').trim()})).filter(x=>x.pattern)}
let directoryExcludeFilters=normalizeDirectoryExcludeFilters(boot.directoryExcludeFilters||[]);
const settingsButton=document.getElementById('settingsButton'),settingsOverlay=document.getElementById('settingsOverlay'),settingsDialog=document.getElementById('settingsDialog');
const appearanceInputs={
  base:{mode:document.getElementById('baseMode'),color:document.getElementById('baseColor'),themeVar:'--vscode-focusBorder',fallback:'#4FA3FF'},
  add:{mode:document.getElementById('addMode'),color:document.getElementById('addColor'),themeVar:'--vscode-gitDecoration-addedResourceForeground',fallback:'#34C759'},
  delete:{mode:document.getElementById('deleteMode'),color:document.getElementById('deleteColor'),themeVar:'--vscode-gitDecoration-deletedResourceForeground',fallback:'#FF453A'},
  editorBackground:{mode:document.getElementById('editorBackgroundMode'),color:document.getElementById('editorBackgroundColor'),themeVar:'--vscode-editor-background',fallback:'#1E1E1E'},
  gutter:{mode:document.getElementById('gutterMode'),color:document.getElementById('gutterColor'),themeVar:'--vscode-editorWidget-background',fallback:'#181A1F'},
};
const highlightInput=document.getElementById('highlightOpacity');
function themeCss(variable,fallback){return 'var('+variable+', '+fallback+')'}
function resolvedThemeColor(variable,fallback){const v=getComputedStyle(document.documentElement).getPropertyValue(variable).trim()||getComputedStyle(document.body).getPropertyValue(variable).trim();return normalizeColor(v||fallback,fallback)}
function normalizeColor(value,fallback){if(/^#[0-9a-f]{6}$/i.test(value))return value;if(/^#[0-9a-f]{8}$/i.test(value))return value.slice(0,7);const m=value.match(/^rgba?\(([^)]+)\)$/i);if(m){const p=m[1].split(',').map(x=>Number.parseFloat(x.trim()));if(p.length>=3&&p.slice(0,3).every(Number.isFinite))return'#'+p.slice(0,3).map(n=>Math.max(0,Math.min(255,Math.round(n))).toString(16).padStart(2,'0')).join('')}return fallback}
function lighten(hex,amount){const color=hex.replace('#',''),n=color.length===3?color.split('').map(c=>c+c).join(''):color,r=parseInt(n.slice(0,2),16),g=parseInt(n.slice(2,4),16),b=parseInt(n.slice(4,6),16),mix=v=>Math.max(0,Math.min(255,Math.round(v+(255-v)*amount)));return'#'+[mix(r),mix(g),mix(b)].map(v=>v.toString(16).padStart(2,'0')).join('')}
function customOrTheme(key){const c=appearanceInputs[key];return appearance[key]?appearance[key]:themeCss(c.themeVar,c.fallback)}
function updateAppearanceControls(){for(const [key,c] of Object.entries(appearanceInputs)){const custom=!!appearance[key];c.mode.value=custom?'custom':'theme';c.color.disabled=!custom;c.color.value=custom?appearance[key]:resolvedThemeColor(c.themeVar,c.fallback)}highlightInput.value=String(appearance.highlight)}
function currentEditorBackground(){const c=appearanceInputs.editorBackground;return appearance.editorBackground||resolvedThemeColor(c.themeVar,c.fallback)}
function applyMonacoTheme(){const isLight=document.body.classList.contains('vscode-light');const isHC=document.body.classList.contains('vscode-high-contrast')||document.body.classList.contains('vscode-high-contrast-light');const base=isHC?(isLight?'hc-light':'hc-black'):(isLight?'vs':'vs-dark');const editorBg=normalizeColor(currentEditorBackground(),'#1E1E1E');monaco.editor.defineTheme('codemeld-custom',{base,inherit:true,rules:[],colors:{'editor.background':editorBg,'editor.lineHighlightBackground':editorBg}});monaco.editor.setTheme('codemeld-custom')}
function applyAppearance(save=true){const root=document.documentElement.style;const primary=customOrTheme('base');root.setProperty('--codemeld-blue',primary);root.setProperty('--codemeld-merge',appearance.base?lighten(appearance.base,.12):themeCss('--vscode-focusBorder','#67B3FF'));root.setProperty('--codemeld-add',customOrTheme('add'));root.setProperty('--codemeld-delete',customOrTheme('delete'));root.setProperty('--codemeld-gutter',customOrTheme('gutter'));root.setProperty('--codemeld-editor-bg',customOrTheme('editorBackground'));root.setProperty('--codemeld-row-alt','color-mix(in srgb,var(--codemeld-editor-bg) 94%,var(--vscode-editor-foreground) 6%)');root.setProperty('--codemeld-highlight-pct',String(appearance.highlight)+'%');updateAppearanceControls();applyMonacoTheme();if(save){vscode.postMessage({type:'appearance',appearance})}}
function openSettings(){settingsOverlay.classList.add('open');settingsOverlay.setAttribute('aria-hidden','false');settingsButton.classList.add('active');updateAppearanceControls();setTimeout(()=>settingsDialog.focus(),0)}function closeSettings(){settingsOverlay.classList.remove('open');settingsOverlay.setAttribute('aria-hidden','true');settingsButton.classList.remove('active');settingsButton.focus()}settingsButton.addEventListener('click',openSettings);document.getElementById('settingsClose').addEventListener('click',closeSettings);settingsOverlay.addEventListener('mousedown',e=>{if(e.target===settingsOverlay)closeSettings()});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&settingsOverlay.classList.contains('open')){e.preventDefault();closeSettings()}});function refreshAppearanceViews(){sessionMap.forEach(s=>{if(s.type==='file'){decorate(s);draw(s)}else if(s.type==='directory')renderDirectory(s);else if(s.type==='metadata')renderMetadata(s)})}for(const [key,c] of Object.entries(appearanceInputs)){c.mode.addEventListener('change',()=>{appearance[key]=c.mode.value==='custom'?resolvedThemeColor(c.themeVar,c.fallback):null;applyAppearance();refreshAppearanceViews()});c.color.addEventListener('input',()=>{appearance[key]=c.color.value;applyAppearance();refreshAppearanceViews()})}highlightInput.addEventListener('input',()=>{appearance.highlight=Number(highlightInput.value);applyAppearance();refreshAppearanceViews()});document.getElementById('resetAppearance').addEventListener('click',()=>{appearance={...appearanceDefaults};applyAppearance();refreshAppearanceViews()});const themeObserver=new MutationObserver(()=>{if(Object.values(appearanceInputs).some((c,i)=>true)){applyAppearance(false);refreshAppearanceViews()}});themeObserver.observe(document.body,{attributes:true,attributeFilter:['class','style']});applyAppearance(false);
const directoryFiltersOverlay=document.getElementById('directoryFiltersOverlay'),directoryFiltersDialog=document.getElementById('directoryFiltersDialog'),excludeRows=document.getElementById('excludeRows');
function updateDirectoryFilterBadges(){document.querySelectorAll('.directoryFiltersButton').forEach(b=>{const count=b.querySelector('.filterCount');if(count)count.textContent=directoryExcludeFilters.length?String(directoryExcludeFilters.length):'';b.classList.toggle('active',directoryExcludeFilters.length>0)})}
function addExcludeRow(filter={name:'',pattern:''},focus=false){const row=document.createElement('div');row.className='excludeRow';row.innerHTML='<input class="excludeInput excludeName" type="text" placeholder="e.g. Build output"><input class="excludeInput excludePattern" type="text" placeholder="e.g. build/**"><button class="excludeDelete" title="Delete filter" aria-label="Delete filter">×</button>';row.querySelector('.excludeName').value=filter.name||'';row.querySelector('.excludePattern').value=filter.pattern||'';row.querySelector('.excludeDelete').addEventListener('click',()=>{row.remove();if(!excludeRows.querySelector('.excludeRow'))excludeRows.innerHTML='<div class="excludeEmpty">No exclusion filters. All files and folders will be analysed.</div>'});const empty=excludeRows.querySelector('.excludeEmpty');if(empty)empty.remove();excludeRows.appendChild(row);if(focus)setTimeout(()=>row.querySelector('.excludeName').focus(),0)}
function renderExcludeRows(){excludeRows.innerHTML='';if(!directoryExcludeFilters.length){excludeRows.innerHTML='<div class="excludeEmpty">No exclusion filters. All files and folders will be analysed.</div>';return}directoryExcludeFilters.forEach(f=>addExcludeRow(f))}
function openDirectoryFilters(){renderExcludeRows();directoryFiltersOverlay.classList.add('open');directoryFiltersOverlay.setAttribute('aria-hidden','false');setTimeout(()=>directoryFiltersDialog.focus(),0)}
function closeDirectoryFilters(){directoryFiltersOverlay.classList.remove('open');directoryFiltersOverlay.setAttribute('aria-hidden','true')}
function saveDirectoryFilters(){const filters=[...excludeRows.querySelectorAll('.excludeRow')].map(row=>({name:row.querySelector('.excludeName').value.trim(),pattern:row.querySelector('.excludePattern').value.trim()})).filter(x=>x.pattern);directoryExcludeFilters=filters;updateDirectoryFilterBadges();closeDirectoryFilters();vscode.postMessage({type:'directoryExcludeFilters',filters})}
document.getElementById('directoryFiltersClose').addEventListener('click',closeDirectoryFilters);document.getElementById('cancelExcludeFilters').addEventListener('click',closeDirectoryFilters);document.getElementById('saveExcludeFilters').addEventListener('click',saveDirectoryFilters);document.getElementById('addExcludeFilter').addEventListener('click',()=>addExcludeRow({},true));directoryFiltersOverlay.addEventListener('mousedown',e=>{if(e.target===directoryFiltersOverlay)closeDirectoryFilters()});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&directoryFiltersOverlay.classList.contains('open')){e.preventDefault();closeDirectoryFilters()}});updateDirectoryFilterBadges();
tabsViewport.addEventListener('wheel',e=>{if(Math.abs(e.deltaY)>Math.abs(e.deltaX)){tabsViewport.scrollLeft+=e.deltaY;e.preventDefault()}},{passive:false});
function updateEmpty(){manager.classList.toggle('hasSessions',sessionMap.size>0)}function updateTabDirty(s){if(s.type!=='file'){s.tab.classList.remove('dirty');return}const dirty=s.leftEditor.getValue()!==s.savedLeftText||s.rightEditor.getValue()!==s.savedRightText;s.tab.classList.toggle('dirty',dirty)}
function activateSession(id){const s=sessionMap.get(id);if(!s)return;activeId=id;sessionMap.forEach(x=>{x.tab.classList.toggle('active',x.id===id);x.view.classList.toggle('active',x.id===id)});s.tab.scrollIntoView({block:'nearest',inline:'nearest'});requestAnimationFrame(()=>{if(s.type==='file'){s.leftEditor.layout();s.rightEditor.layout();draw(s)}});vscode.postMessage({type:'activateSession',sessionId:id})}
function closeTab(id){const s=sessionMap.get(id);if(!s)return;s.tab.classList.add('pendingClose');vscode.postMessage({type:'closeSession',sessionId:id})}
function removeSession(id){const s=sessionMap.get(id);if(!s)return;const order=[...tabs.children];const index=order.indexOf(s.tab);if(s.type==='file'){s.leftEditor.dispose();s.rightEditor.dispose()}s.tab.remove();s.view.remove();sessionMap.delete(id);if(activeId===id){const remaining=[...sessionMap.values()];const next=remaining[Math.min(index,Math.max(0,remaining.length-1))]||remaining[remaining.length-1];activeId=null;if(next)activateSession(next.id)}updateEmpty()}
function addSession(data,activate){if(sessionMap.has(data.id)){if(activate)activateSession(data.id);return}const tab=document.createElement('div');tab.className='compareTab';tab.innerHTML='<span class="dirtyDot"></span><span class="tabLabel"></span><button class="tabClose" title="Close comparison" aria-label="Close comparison">×</button>';const prefix=data.type==='directory'?'⌘ ':data.type==='metadata'?'ⓘ ':'';tab.querySelector('.tabLabel').textContent=prefix+data.leftName+' ↔ '+data.rightName;tab.title=data.leftName+' ↔ '+data.rightName;tab.addEventListener('click',e=>{if(!e.target.closest('.tabClose'))activateSession(data.id)});tab.querySelector('.tabClose').addEventListener('click',e=>{e.stopPropagation();closeTab(data.id)});tabs.appendChild(tab);const view=document.createElement('div');view.className='comparisonView';host.appendChild(view);let s;if(data.type==='directory')s=createDirectorySession(data,tab,view);else if(data.type==='metadata')s=createMetadataSession(data,tab,view);else{view.innerHTML=comparisonMarkup(data);s=createSession(data,tab,view)}sessionMap.set(data.id,s);updateTabDirty(s);updateEmpty();if(activate||!activeId)activateSession(data.id)}
function comparisonMarkup(data){return '<div class="compareGrid"><section class="pane"><div class="title"><span class="name leftName"></span><div class="titleControls"><button class="iconButton undoLeft" title="Undo left"><svg viewBox="0 0 24 24"><path d="M9 8H5V4"/><path d="M5 8c2-3 5-4 8-3 4 1 6 5 5 9-1 4-5 6-9 5"/></svg></button><button class="iconButton redoLeft" title="Redo left"><svg viewBox="0 0 24 24"><path d="M15 8h4V4"/><path d="M19 8c-2-3-5-4-8-3-4 1-6 5-5 9 1 4 5 6 9 5"/></svg></button><button class="saveButton saveLeft">Save</button></div></div><div class="editor leftEditor"></div></section><section class="gutter"><div class="gutterTitle"><button class="applyAllButton applyAllLeft" title="Apply all right → left"><svg viewBox="0 0 24 24"><path d="M11 5 4 12l7 7"/><path d="M4 12h16"/></svg></button><button class="applyAllButton applyAllRight" title="Apply all left → right"><svg viewBox="0 0 24 24"><path d="m13 5 7 7-7 7"/><path d="M20 12H4"/></svg></button></div><svg class="diffSvg" preserveAspectRatio="none"></svg><div class="actions"></div></section><section class="pane"><div class="title"><span class="name rightName"></span><div class="titleControls"><button class="iconButton undoRight" title="Undo right"><svg viewBox="0 0 24 24"><path d="M9 8H5V4"/><path d="M5 8c2-3 5-4 8-3 4 1 6 5 5 9-1 4-5 6-9 5"/></svg></button><button class="iconButton redoRight" title="Redo right"><svg viewBox="0 0 24 24"><path d="M15 8h4V4"/><path d="M19 8c-2-3-5-4-8-3-4 1-6 5-5 9 1 4 5 6 9 5"/></svg></button><button class="saveButton saveRight">Save</button></div></div><div class="editor rightEditor"></div></section></div>'}
function createSession(data,tab,view){view.querySelector('.leftName').textContent=data.leftName;view.querySelector('.rightName').textContent=data.rightName;const common={automaticLayout:true,minimap:{enabled:false},scrollBeyondLastLine:false,renderWhitespace:'selection',wordWrap:'off',fontSize:13,lineNumbersMinChars:4,glyphMargin:false,folding:true,padding:{top:4,bottom:4},readOnly:false,domReadOnly:false};const leftHost=view.querySelector('.leftEditor'),rightHost=view.querySelector('.rightEditor');const leftEditor=monaco.editor.create(leftHost,{...common,value:data.leftText,language:data.leftLanguage});const rightEditor=monaco.editor.create(rightHost,{...common,value:data.rightText,language:data.rightLanguage});const s={type:'file',id:data.id,tab,view,leftEditor,rightEditor,revision:data.revision,savedLeftText:data.savedLeftText,savedRightText:data.savedRightText,leftDecorations:[],rightDecorations:[],hoveredAction:null,recomputeTimer:null,syncing:false,gutterWheelAccum:0,gutterWheelLocked:false,svg:view.querySelector('.diffSvg'),actions:view.querySelector('.actions')};leftHost.addEventListener('mousedown',()=>leftEditor.focus());rightHost.addEventListener('mousedown',()=>rightEditor.focus());leftEditor.onDidFocusEditorText(()=>leftHost.classList.add('focused'));leftEditor.onDidBlurEditorText(()=>leftHost.classList.remove('focused'));rightEditor.onDidFocusEditorText(()=>rightHost.classList.add('focused'));rightEditor.onDidBlurEditorText(()=>rightHost.classList.remove('focused'));const changed=()=>{updateTabDirty(s);vscode.postMessage({type:'contentChanged',sessionId:s.id,leftText:leftEditor.getValue(),rightText:rightEditor.getValue()});clearTimeout(s.recomputeTimer);s.recomputeTimer=setTimeout(()=>vscode.postMessage({type:'recompute',sessionId:s.id,leftText:leftEditor.getValue(),rightText:rightEditor.getValue()}),180)};leftEditor.onDidChangeModelContent(changed);rightEditor.onDidChangeModelContent(changed);view.querySelector('.saveLeft').addEventListener('click',()=>save(s,'left'));view.querySelector('.saveRight').addEventListener('click',()=>save(s,'right'));view.querySelector('.undoLeft').addEventListener('click',()=>leftEditor.trigger('codemeld','undo',null));view.querySelector('.redoLeft').addEventListener('click',()=>leftEditor.trigger('codemeld','redo',null));view.querySelector('.undoRight').addEventListener('click',()=>rightEditor.trigger('codemeld','undo',null));view.querySelector('.redoRight').addEventListener('click',()=>rightEditor.trigger('codemeld','redo',null));view.querySelector('.applyAllLeft').addEventListener('click',()=>applyAll(s,'left'));view.querySelector('.applyAllRight').addEventListener('click',()=>applyAll(s,'right'));leftEditor.onDidScrollChange(()=>syncAndDraw(s,leftEditor,rightEditor,'left'));rightEditor.onDidScrollChange(()=>syncAndDraw(s,rightEditor,leftEditor,'right'));leftEditor.onDidLayoutChange(()=>draw(s));rightEditor.onDidLayoutChange(()=>draw(s));const gutter=view.querySelector('.gutter');gutter.addEventListener('wheel',e=>handleGutterWheel(s,e),{passive:false});decorate(s);draw(s);return s}

function prettyRoot(uri){try{const u=new URL(uri);return decodeURIComponent(u.pathname)}catch{return uri}}
function createDirectorySession(data,tab,view){view.innerHTML='<div class="directoryView"><div class="dirToolbar"><div class="dirFilters"><button class="dirFilter" data-filter="onlyLeft">Only left</button><button class="dirFilter" data-filter="onlyRight">Only right</button><button class="dirFilter active" data-filter="content">Content</button><button class="dirFilter" data-filter="timeMetadata">Time</button><button class="dirFilter" data-filter="otherMetadata">Metadata</button></div><div class="dirMergeControls"><button class="dirMergeButton deleteButton deleteLeft" disabled title="Delete selected unmatched items on left" aria-label="Delete unmatched items on left"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg></button><button class="dirMergeButton mergeLeft" disabled title="Transfer selected right → left"><svg viewBox="0 0 24 24"><path d="M11 5 4 12l7 7"/><path d="M4 12h16"/></svg></button><button class="dirMergeButton mergeRight" disabled title="Transfer selected left → right"><svg viewBox="0 0 24 24"><path d="m13 5 7 7-7 7"/><path d="M20 12H4"/></svg></button><button class="dirMergeButton deleteButton deleteRight" disabled title="Delete selected unmatched items on right" aria-label="Delete unmatched items on right"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg></button></div><div class="dirRefreshSlot"><button class="directoryFiltersButton" title="Exclusion filters used before directory analysis"><svg viewBox="0 0 24 24"><path d="M4 5h16l-6.4 7.2V19l-3.2 1v-7.8Z"/></svg><span>Filters</span><span class="filterCount"></span></button><button class="dirMergeButton refreshDirectory" title="Refresh directory comparison" aria-label="Refresh directory comparison"><svg viewBox="0 0 24 24"><path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M18.5 9A7 7 0 0 0 6 6.5L4 11"/><path d="M5.5 15A7 7 0 0 0 18 17.5l2-4.5"/></svg></button></div></div><div class="dirGrid"><section class="dirPane"><div class="dirPath leftRoot"></div><div class="dirRows leftRows"></div></section><div class="dirCenter"><div class="dirCenterHeader"></div><div class="dirCenterRows"></div></div><section class="dirPane"><div class="dirPath rightRoot"></div><div class="dirRows rightRows"></div></section></div></div>';const s={type:'directory',id:data.id,data,tab,view,comparison:data.comparison,filters:new Set(['content']),selected:null,collapsed:new Set()};view.querySelector('.leftRoot').textContent=prettyRoot(data.comparison.leftRoot);view.querySelector('.rightRoot').textContent=prettyRoot(data.comparison.rightRoot);view.querySelectorAll('.dirFilter').forEach(b=>b.addEventListener('click',()=>{const key=b.dataset.filter;if(s.filters.has(key))s.filters.delete(key);else s.filters.add(key);b.classList.toggle('active',s.filters.has(key));renderDirectory(s)}));view.querySelector('.directoryFiltersButton').addEventListener('click',openDirectoryFilters);view.querySelector('.refreshDirectory').addEventListener('click',()=>vscode.postMessage({type:'refreshDirectory',sessionId:s.id}));view.querySelector('.mergeLeft').addEventListener('click',()=>transferSelectedDirectory(s,'left'));view.querySelector('.mergeRight').addEventListener('click',()=>transferSelectedDirectory(s,'right'));view.querySelector('.deleteLeft').addEventListener('click',()=>deleteSelectedUnmatched(s,'left'));view.querySelector('.deleteRight').addEventListener('click',()=>deleteSelectedUnmatched(s,'right'));updateDirectoryFilterBadges();renderDirectory(s);return s}

function selectedDirectoryPair(s){return s.selected?s.comparison.pairs.find(p=>p.relativePath===s.selected):null}
function subtreePairs(s,p){if(!p)return[];if(!p.isDirectory)return[p];const prefix=p.relativePath+'/';return s.comparison.pairs.filter(x=>x.relativePath===p.relativePath||x.relativePath.startsWith(prefix))}
function updateDirectorySelection(s){const selected=selectedDirectoryPair(s);s.view.querySelectorAll('.dirRow,.dirDiffRow').forEach(row=>row.classList.toggle('selected',!!selected&&row.dataset.path===selected.relativePath));const buttons={mergeLeft:s.view.querySelector('.mergeLeft'),mergeRight:s.view.querySelector('.mergeRight'),deleteLeft:s.view.querySelector('.deleteLeft'),deleteRight:s.view.querySelector('.deleteRight')};if(!selected){Object.values(buttons).forEach(b=>b.disabled=true);return}const scope=subtreePairs(s,selected);const rightSource=selected.isDirectory?(selected.caseDifferent&&!!selected.right)||scope.some(p=>p.right&&!p.left):!!selected.right;const leftSource=selected.isDirectory?(selected.caseDifferent&&!!selected.left)||scope.some(p=>p.left&&!p.right):!!selected.left;buttons.mergeLeft.disabled=!rightSource;buttons.mergeRight.disabled=!leftSource;buttons.deleteLeft.disabled=!scope.some(p=>p.left&&!p.right);buttons.deleteRight.disabled=!scope.some(p=>p.right&&!p.left)}
function transferSelectedDirectory(s,targetSide){if(!s.selected)return;vscode.postMessage({type:'directoryMerge',sessionId:s.id,relativePath:s.selected,targetSide})}
function deleteSelectedUnmatched(s,side){if(!s.selected)return;vscode.postMessage({type:'directoryDeleteUnmatched',sessionId:s.id,relativePath:s.selected,side})}

function pairMatchesFilters(s,p){if(s.filters.size===0)return true;return (s.filters.has('onlyLeft')&&p.kind==='onlyLeft')||(s.filters.has('onlyRight')&&p.kind==='onlyRight')||(s.filters.has('content')&&!p.isDirectory&&(p.contentDifferent||p.caseDifferent))||(s.filters.has('timeMetadata')&&p.timeMetadataDifferent)||(s.filters.has('otherMetadata')&&p.otherMetadataDifferent)}
function visibleDirectoryPairs(s){const pairs=s.comparison.pairs;const match=new Set(pairs.filter(p=>pairMatchesFilters(s,p)).map(p=>p.relativePath));for(const path of [...match]){const parts=path.split('/');while(parts.length>1){parts.pop();match.add(parts.join('/'))}}return pairs.filter(p=>match.has(p.relativePath)).filter(p=>{const parts=p.relativePath.split('/');parts.pop();let cur='';for(const part of parts){cur=cur?cur+'/'+part:part;if(s.collapsed.has(cur))return false}return true})}
function statusClass(p,entry){return entry?'':'missing'}
function renderDirectory(s){const left=s.view.querySelector('.leftRows'),right=s.view.querySelector('.rightRows'),center=s.view.querySelector('.dirCenterRows');left.innerHTML='';right.innerHTML='';center.innerHTML='';const pairs=visibleDirectoryPairs(s);if(!pairs.length){left.innerHTML='<div class="dirEmpty">No entries match the selected modes.</div>';right.innerHTML='<div class="dirEmpty">No entries match the selected modes.</div>';updateDirectorySelection(s);return}for(const p of pairs){left.appendChild(makeDirRow(s,p,'left'));center.appendChild(makeDiffRow(s,p));right.appendChild(makeDirRow(s,p,'right'))}syncDirScroll(s,left,right,center);syncDirScroll(s,right,left,center);updateDirectorySelection(s)}
function syncDirScroll(s,a,b,center){if(a.dataset.syncBound)return;a.dataset.syncBound='1';a.addEventListener('scroll',()=>{if(s.dirSync)return;s.dirSync=true;b.scrollTop=a.scrollTop;center.style.transform='translateY(' + (-a.scrollTop) + 'px)';requestAnimationFrame(()=>s.dirSync=false)},{passive:true})}
function makeDirRow(s,p,side){const entry=side==='left'?p.left:p.right;const row=document.createElement('div');row.className='dirRow '+(!entry?'missing ':'')+(p.isDirectory?'dirFolder ':'');row.dataset.path=p.relativePath;row.style.paddingLeft=(7+p.depth*16)+'px';const hasChildren=p.isDirectory&&s.comparison.pairs.some(x=>x.relativePath.startsWith(p.relativePath+'/'));row.innerHTML='<span class="dirTwisty '+(!hasChildren?'empty':'')+'">'+(s.collapsed.has(p.relativePath)?'▶':'▼')+'</span><span class="dirStatus '+statusClass(p,entry)+'"></span><span class="dirName"></span>';row.querySelector('.dirName').textContent=entry?entry.name:p.name;row.querySelector('.dirTwisty').addEventListener('click',e=>{e.stopPropagation();if(!hasChildren)return;if(s.collapsed.has(p.relativePath))s.collapsed.delete(p.relativePath);else s.collapsed.add(p.relativePath);renderDirectory(s)});row.addEventListener('click',()=>{s.selected=p.relativePath;updateDirectorySelection(s)});row.addEventListener('dblclick',()=>{if(!p.left||!p.right)return;vscode.postMessage({type:'openDirectoryPairAuto',sessionId:s.id,relativePath:p.relativePath,filters:[...s.filters]})});return row}
function makeDiffRow(s,p){const row=document.createElement('div');row.className='dirDiffRow';row.dataset.path=p.relativePath;row.innerHTML='<span class="dirDiffMarker content" title="Content differs"></span><span class="dirDiffMarker metadata" title="Metadata or time differs"></span><span class="dirDiffMarker case" title="Name differs only by letter case">A≠a</span>';const content=row.querySelector('.content'),metadata=row.querySelector('.metadata'),caseMarker=row.querySelector('.case');content.classList.toggle('visible',!!p.contentDifferent);metadata.classList.toggle('visible',!!p.metadataDifferent);caseMarker.classList.toggle('visible',!!p.caseDifferent);row.addEventListener('click',()=>{s.selected=p.relativePath;updateDirectorySelection(s)});row.addEventListener('dblclick',e=>{if(e.target.closest('.metadata'))return;if(!p.left||!p.right)return;vscode.postMessage({type:'openDirectoryPairAuto',sessionId:s.id,relativePath:p.relativePath,filters:[...s.filters]})});metadata.addEventListener('dblclick',e=>{e.stopPropagation();if(p.left&&p.right&&p.metadataDifferent)vscode.postMessage({type:'openDirectoryPair',sessionId:s.id,relativePath:p.relativePath,mode:'metadata'})});return row}
function createMetadataSession(data,tab,view){view.innerHTML='<div class="metadataView"><div class="metadataHeader"><div class="leftMetaName"></div><div class="middle"></div><div class="rightMetaName"></div></div><div class="metadataTable"></div></div>';const s={type:'metadata',id:data.id,data,tab,view,leftMetadata:data.leftMetadata,rightMetadata:data.rightMetadata,isDirectory:!!data.isDirectory,capabilities:data.capabilities||{platform:'unsupported'}};view.querySelector('.leftMetaName').textContent=data.leftName;view.querySelector('.rightMetaName').textContent=data.rightName;const platformLabel=s.capabilities.platform==='macos'?'macOS':s.capabilities.platform==='windows'?'Windows':s.capabilities.platform==='linux'?'Linux':'Unknown';view.querySelector('.middle').textContent='Metadata · '+platformLabel;renderMetadata(s);return s}
function metaFormat(field,v){if(v===undefined||v===null)return'—';if(field==='mtime'||field==='birthtime'){if(Number(v)<=0)return'Unavailable';return new Date(v).toLocaleString()}return String(v)}
function permTriplet(mode,mask){const m=Number(mode||0);if(mask==='r')return'u:'+(m&0o400?'r':'-')+'  g:'+(m&0o040?'r':'-')+'  o:'+(m&0o004?'r':'-');if(mask==='w')return'u:'+(m&0o200?'w':'-')+'  g:'+(m&0o020?'w':'-')+'  o:'+(m&0o002?'w':'-');if(mask==='x')return'u:'+(m&0o100?'x':'-')+'  g:'+(m&0o010?'x':'-')+'  o:'+(m&0o001?'x':'-');return'setuid:'+(m&0o4000?'on':'off')+'  setgid:'+(m&0o2000?'on':'off')+'  sticky:'+(m&0o1000?'on':'off')}
function identityLabel(name,id){if(id===undefined||id===null)return name||'—';return name?name+' ('+id+')':String(id)}
function renderMetadata(s){const table=s.view.querySelector('.metadataTable');table.innerHTML='';const lm=s.leftMetadata,rm=s.rightMetadata,c=s.capabilities||{};const rows=[];rows.push(['mtime','Modified time',lm.mtimeMs,rm.mtimeMs,true]);rows.push(['birthtime','Creation time',lm.birthtimeMs,rm.birthtimeMs,!!c.canWriteCreationTime]);if(c.posixPermissions){rows.push(['user','User',identityLabel(lm.userName,lm.uid),identityLabel(rm.userName,rm.uid),!!c.canWriteOwner]);rows.push(['group','Group',identityLabel(lm.groupName,lm.gid),identityLabel(rm.groupName,rm.gid),!!c.canWriteGroup]);rows.push(['permRead','Permissions · r',permTriplet(lm.mode,'r'),permTriplet(rm.mode,'r'),true]);rows.push(['permWrite','Permissions · w',permTriplet(lm.mode,'w'),permTriplet(rm.mode,'w'),true]);rows.push(['permExecute','Permissions · x',permTriplet(lm.mode,'x'),permTriplet(rm.mode,'x'),true]);rows.push(['permSpecial','Permissions · s',permTriplet(lm.mode,'s'),permTriplet(rm.mode,'s'),true])}if(c.windowsAcl){rows.push(['owner','Owner',lm.ownerName||'—',rm.ownerName||'—',!!c.canWriteOwner]);rows.push(['acl','ACL (SDDL)',lm.aclSddl||'—',rm.aclSddl||'—',true])}if(!s.isDirectory)rows.push(['size','Size',lm.size,rm.size,false]);for(const [field,label,lv,rv,transferable] of rows){const diff=String(lv)!==String(rv);const row=document.createElement('div');row.className='metadataRow '+(diff?'metadataDifferent':'');const controls=transferable?'<div><span class="metaLabel"></span><button class="metaArrow toLeft">←</button><button class="metaArrow toRight">→</button></div>':'<div><span class="metaLabel"></span></div>';row.innerHTML='<div class="metadataValue left"></div><div class="metadataActions">'+controls+'</div><div class="metadataValue right"></div>';row.querySelector('.left').textContent=(field==='mtime'||field==='birthtime'||field==='size')?metaFormat(field,lv):String(lv);row.querySelector('.right').textContent=(field==='mtime'||field==='birthtime'||field==='size')?metaFormat(field,rv):String(rv);row.querySelector('.metaLabel').textContent=label;if(transferable){row.querySelector('.toLeft').addEventListener('click',()=>vscode.postMessage({type:'copyMetadata',sessionId:s.id,field,targetSide:'left'}));row.querySelector('.toRight').addEventListener('click',()=>vscode.postMessage({type:'copyMetadata',sessionId:s.id,field,targetSide:'right'}))}table.appendChild(row)}}
function save(s,side){vscode.postMessage({type:'save',sessionId:s.id,side,leftText:s.leftEditor.getValue(),rightText:s.rightEditor.getValue()})}
function syncAndDraw(s,from,to,side){if(!s.syncing){s.syncing=true;const visible=from.getVisibleRanges()[0];if(visible){const srcLine0=visible.startLineNumber-1,mapped0=mapLine(s,srcLine0,side),srcTop=from.getTopForLineNumber(visible.startLineNumber),within=from.getScrollTop()-srcTop,dstLine=Math.max(1,Math.min(to.getModel().getLineCount(),Math.floor(mapped0)+1));to.setScrollTop(to.getTopForLineNumber(dstLine)+within,monaco.editor.ScrollType.Immediate)}requestAnimationFrame(()=>s.syncing=false)}draw(s)}
function mapLine(s,line,fromSide){let offset=0;const fromKey=fromSide==='left'?'left':'right',toKey=fromSide==='left'?'right':'left';for(const d of s.revision.deltas){const a=d[fromKey],b=d[toKey];if(line<a.anchor)return line+offset;if(line<a.anchor+Math.max(1,a.size)){if(a.size<=1||b.size<=1)return b.anchor;const ratio=(line-a.anchor)/Math.max(1,a.size-1);return b.anchor+ratio*Math.max(0,b.size-1)}offset=(b.anchor+b.size)-(a.anchor+a.size)}return line+offset}
function handleGutterWheel(s,e){e.preventDefault();e.stopPropagation();if(!s.revision.deltas.length)return;if(Math.abs(e.deltaX)>Math.abs(e.deltaY))return;s.gutterWheelAccum+=e.deltaY;if(s.gutterWheelLocked||Math.abs(s.gutterWheelAccum)<18)return;const direction=s.gutterWheelAccum>0?1:-1;s.gutterWheelAccum=0;s.gutterWheelLocked=true;navigateDifference(s,direction);setTimeout(()=>{s.gutterWheelLocked=false},180)}
function navigateDifference(s,direction){const deltas=s.revision.deltas;if(!deltas.length)return;const editor=s.leftEditor;const scrollTop=editor.getScrollTop();const threshold=24;let index=-1;if(direction>0){for(let i=0;i<deltas.length;i++){const line=Math.max(1,Math.min(editor.getModel().getLineCount(),deltas[i].left.anchor+1));const top=editor.getTopForLineNumber(line);if(top>scrollTop+threshold){index=i;break}}if(index<0)index=0}else{for(let i=deltas.length-1;i>=0;i--){const line=Math.max(1,Math.min(editor.getModel().getLineCount(),deltas[i].left.anchor+1));const top=editor.getTopForLineNumber(line);if(top<scrollTop-threshold){index=i;break}}if(index<0)index=deltas.length-1}scrollToDifference(s,index)}
function scrollToDifference(s,index){const d=s.revision.deltas[index];if(!d)return;const leftLine=Math.max(1,Math.min(s.leftEditor.getModel().getLineCount(),d.left.anchor+1));const rightLine=Math.max(1,Math.min(s.rightEditor.getModel().getLineCount(),d.right.anchor+1));const leftHeight=s.leftEditor.getLayoutInfo().height;const rightHeight=s.rightEditor.getLayoutInfo().height;const leftTop=Math.max(0,s.leftEditor.getTopForLineNumber(leftLine)-Math.round(leftHeight*.22));const rightTop=Math.max(0,s.rightEditor.getTopForLineNumber(rightLine)-Math.round(rightHeight*.22));s.syncing=true;s.leftEditor.setScrollTop(leftTop,monaco.editor.ScrollType.Smooth);s.rightEditor.setScrollTop(rightTop,monaco.editor.ScrollType.Smooth);setTimeout(()=>{s.syncing=false;draw(s)},220)}
function yFor(editor,anchor){const model=editor.getModel(),count=model.getLineCount(),lineHeight=editor.getOption(monaco.editor.EditorOption.lineHeight);if(anchor>=count)return editor.getTopForLineNumber(count)+lineHeight-editor.getScrollTop();return editor.getTopForLineNumber(Math.max(1,anchor+1))-editor.getScrollTop()}
function decorate(s){const left=[],right=[];addZebraDecorations(left,s.leftEditor);addZebraDecorations(right,s.rightEditor);for(let index=0;index<s.revision.deltas.length;index++){const d=s.revision.deltas[index],semantic=s.hoveredAction&&s.hoveredAction.index===index?s.hoveredAction.semantic:null,rowClass=semantic?'codemeld-row-hover-'+semantic:'codemeld-row-default',innerClass=semantic?'codemeld-inner-hover-'+semantic:'codemeld-inner-default';addLineDecorations(left,d.left,rowClass);addLineDecorations(right,d.right,rowClass);for(const inner of d.innerChanges||[]){addInnerDecoration(left,inner.leftLine,inner.leftStart,inner.leftLength,innerClass);addInnerDecoration(right,inner.rightLine,inner.rightStart,inner.rightLength,innerClass)}}s.leftDecorations=s.leftEditor.deltaDecorations(s.leftDecorations,left);s.rightDecorations=s.rightEditor.deltaDecorations(s.rightDecorations,right)}
function addZebraDecorations(target,editor){const count=editor.getModel().getLineCount();for(let line=2;line<=count;line+=2)target.push({range:new monaco.Range(line,1,line,1),options:{isWholeLine:true,className:'codemeld-zebra-row'}})}function addLineDecorations(target,chunk,cls){if(chunk.size<=0)return;const start=Math.max(1,chunk.anchor+1),end=Math.max(start,chunk.anchor+chunk.size);target.push({range:new monaco.Range(start,1,end,1),options:{isWholeLine:true,className:cls}})}function addInnerDecoration(target,line0,start0,length,cls){if(length<=0)return;const line=line0+1,start=start0+1,end=start+length;target.push({range:new monaco.Range(line,start,line,end),options:{inlineClassName:cls,inlineClassNameAffectsLetterSpacing:false}})}
function semanticFor(d,targetSide){if(d.type==='change')return'merge';const source=targetSide==='left'?d.right:d.left,target=targetSide==='left'?d.left:d.right;if(target.size===0&&source.size>0)return'add';if(source.size===0&&target.size>0)return'delete';return'merge'}
function setHover(s,index,semantic,active){s.hoveredAction=active?{index,semantic}:null;const connector=s.svg.querySelector('[data-delta-index="'+index+'"]');if(connector){connector.classList.remove('hover-merge','hover-add','hover-delete');if(active)connector.classList.add('hover-'+semantic)}s.svg.querySelectorAll('[data-endpoint-index="'+index+'"]').forEach(endpoint=>{endpoint.classList.remove('hover-merge','hover-add','hover-delete');if(active)endpoint.classList.add('hover-'+semantic)});decorate(s)}
function draw(s){if(!s.view.classList.contains('active'))return;const svg=s.svg,actions=s.actions,h=svg.clientHeight;svg.setAttribute('viewBox','0 0 116 '+h);svg.innerHTML='<defs><filter id="bridgeBlur" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="1.5"/></filter></defs>';actions.innerHTML='';s.revision.deltas.forEach((d,index)=>{const l0=yFor(s.leftEditor,d.left.anchor),l1=yFor(s.leftEditor,d.left.anchor+d.left.size),r0=yFor(s.rightEditor,d.right.anchor),r1=yFor(s.rightEditor,d.right.anchor+d.right.size);if(Math.max(l1,r1)<0||Math.min(l0,r0)>h)return;const path=document.createElementNS('http://www.w3.org/2000/svg','path'),W=116,c=39,pinch=1.5,leftTop=d.left.size===0?l0-pinch:l0,leftBottom=d.left.size===0?l0+pinch:l1,rightTop=d.right.size===0?r0-pinch:r0,rightBottom=d.right.size===0?r0+pinch:r1,leftMid=(leftTop+leftBottom)/2,rightMid=(rightTop+rightBottom)/2;path.setAttribute('class','connector');path.setAttribute('data-delta-index',String(index));path.setAttribute('d','M 0 '+leftTop+' C '+c+' '+leftTop+' '+(W-c)+' '+rightTop+' '+W+' '+rightTop+' L '+W+' '+rightBottom+' C '+(W-c)+' '+rightBottom+' '+c+' '+leftBottom+' 0 '+leftBottom+' Z');svg.appendChild(path);svg.appendChild(endpoint(0,leftMid,index));svg.appendChild(endpoint(W,rightMid,index));const lh=Math.max(32,Math.abs(leftBottom-leftTop)+12),rh=Math.max(32,Math.abs(rightBottom-rightTop)+12),lt=Math.max(0,Math.min(h-lh,leftMid-lh/2)),rt=Math.max(0,Math.min(h-rh,rightMid-rh/2));actions.appendChild(actionZone(s,'left',lt,lh,index,semanticFor(d,'left'),()=>applyDelta(s,index,'left')));actions.appendChild(actionZone(s,'right',rt,rh,index,semanticFor(d,'right'),()=>applyDelta(s,index,'right')))} )}
function endpoint(x,y,index){const circle=document.createElementNS('http://www.w3.org/2000/svg','circle');circle.setAttribute('class','bridgeEndpoint');circle.setAttribute('data-endpoint-index',String(index));circle.setAttribute('cx',String(x));circle.setAttribute('cy',String(y));circle.setAttribute('r','2.5');return circle}function actionZone(s,side,top,height,index,semantic,handler){const b=document.createElement('button');b.className='actionZone '+side;b.style.top=top+'px';b.style.height=height+'px';b.addEventListener('mouseenter',()=>setHover(s,index,semantic,true));b.addEventListener('mouseleave',()=>setHover(s,index,semantic,false));b.addEventListener('focus',()=>setHover(s,index,semantic,true));b.addEventListener('blur',()=>setHover(s,index,semantic,false));b.addEventListener('click',handler);return b}
function buildChunkEdit(targetEditor,sourceEditor,targetChunk,sourceChunk){const targetModel=targetEditor.getModel(),sourceLines=sourceEditor.getValue().split('\\n'),replacementLines=sourceLines.slice(sourceChunk.anchor,sourceChunk.anchor+sourceChunk.size),eol=targetModel.getEOL(),lineCount=targetModel.getLineCount();let range,text;if(targetChunk.size===0){if(targetChunk.anchor<lineCount){const line=targetChunk.anchor+1;range=new monaco.Range(line,1,line,1);text=replacementLines.length?replacementLines.join(eol)+eol:''}else{const line=Math.max(1,lineCount),column=targetModel.getLineMaxColumn(line);range=new monaco.Range(line,column,line,column);const prefix=targetModel.getValueLength()>0&&replacementLines.length?eol:'';text=prefix+replacementLines.join(eol)}}else{const startLine=Math.min(lineCount,targetChunk.anchor+1),endExclusive=targetChunk.anchor+targetChunk.size;if(endExclusive<lineCount){range=new monaco.Range(startLine,1,endExclusive+1,1);text=replacementLines.length?replacementLines.join(eol)+eol:''}else{const endLine=lineCount;range=new monaco.Range(startLine,1,endLine,targetModel.getLineMaxColumn(endLine));text=replacementLines.join(eol)}}return{range,text,forceMoveMarkers:true}}
function applyDelta(s,index,targetSide){const d=s.revision.deltas[index];if(!d)return;const sourceEditor=targetSide==='left'?s.rightEditor:s.leftEditor,targetEditor=targetSide==='left'?s.leftEditor:s.rightEditor,sourceChunk=targetSide==='left'?d.right:d.left,targetChunk=targetSide==='left'?d.left:d.right,edit=buildChunkEdit(targetEditor,sourceEditor,targetChunk,sourceChunk);targetEditor.pushUndoStop();targetEditor.executeEdits('codemeld.merge',[edit]);targetEditor.pushUndoStop();targetEditor.focus()}
function applyAll(s,targetSide){if(!s.revision.deltas.length)return;const sourceEditor=targetSide==='left'?s.rightEditor:s.leftEditor,targetEditor=targetSide==='left'?s.leftEditor:s.rightEditor,edits=s.revision.deltas.map(d=>buildChunkEdit(targetEditor,sourceEditor,targetSide==='left'?d.left:d.right,targetSide==='left'?d.right:d.left));targetEditor.pushUndoStop();targetEditor.executeEdits('codemeld.applyAll',edits);targetEditor.pushUndoStop();targetEditor.focus()}
window.addEventListener('resize',()=>{const s=sessionMap.get(activeId);if(s&&s.type==='file')draw(s)});window.addEventListener('message',event=>{const m=event.data;if(m.type==='addSession')addSession(m.session,m.activate);else if(m.type==='activateSession')activateSession(m.sessionId);else if(m.type==='revision'){const s=sessionMap.get(m.sessionId);if(s&&s.type==='file'){s.revision=m.revision;decorate(s);draw(s);updateTabDirty(s)}}else if(m.type==='saved'){const s=sessionMap.get(m.sessionId);if(s&&s.type==='file'){if(m.side==='left')s.savedLeftText=m.savedText;else s.savedRightText=m.savedText;updateTabDirty(s)}}else if(m.type==='directoryUpdated'){const s=sessionMap.get(m.sessionId);if(s&&s.type==='directory'){s.comparison=m.comparison;s.data.comparison=m.comparison;if(s.selected&&!m.comparison.pairs.some(p=>p.relativePath===s.selected))s.selected=null;renderDirectory(s)}}else if(m.type==='metadataUpdated'){const s=sessionMap.get(m.sessionId);if(s&&s.type==='metadata'){s.leftMetadata=m.leftMetadata;s.rightMetadata=m.rightMetadata;renderMetadata(s)}}else if(m.type==='appearanceSettings'){appearance=migrateAppearance(m.appearance);applyAppearance(false);refreshAppearanceViews()}else if(m.type==='directoryExcludeFiltersSettings'){directoryExcludeFilters=normalizeDirectoryExcludeFilters(m.filters);updateDirectoryFilterBadges();if(directoryFiltersOverlay.classList.contains('open'))renderExcludeRows()}else if(m.type==='sessionClosed')removeSession(m.sessionId);else if(m.type==='closeCancelled'){const s=sessionMap.get(m.sessionId);if(s)s.tab.classList.remove('pendingClose')}});updateEmpty();vscode.postMessage({type:'ready'});
});
</script>
</body>
</html>`;
}
