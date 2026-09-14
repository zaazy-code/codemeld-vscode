import * as vscode from 'vscode';
import { DiffEngine } from '../core/DiffEngine';
import { compareDirectories, readDirectoryExcludeFilters, setDirectoryDiffLogger } from '../core/DirectoryDiff';
import { CompareManager } from '../webview/CompareManager';
import { getPlatformAdapter } from '../platform/PlatformFactory';

let selectedForCompare: vscode.Uri | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('CodeMeld');
  context.subscriptions.push(output);
  setDirectoryDiffLogger(message => output.appendLine(message));
  try {
    const adapter = await getPlatformAdapter();
    const c = adapter.capabilities;
    output.appendLine(`CodeMeld runtime:`);
    output.appendLine(`  Platform: ${c.platform}`);
    output.appendLine(`  Architecture: ${c.arch}`);
    output.appendLine(`  Execution: ${c.remoteName ? `Remote (${c.remoteName})` : 'Local'}`);
    output.appendLine(`  Creation time: ${c.canReadCreationTime ? 'read' : 'unavailable'}${c.canWriteCreationTime ? '/write' : ' only'}`);
    output.appendLine(`  POSIX permissions: ${c.posixPermissions ? 'yes' : 'no'}`);
    output.appendLine(`  Windows ACL: ${c.windowsAcl ? 'yes' : 'no'}`);
  } catch (error) {
    output.appendLine(`Platform initialization failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('codemeld.selectForCompare', (uri?: vscode.Uri) => {
      selectedForCompare = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!selectedForCompare) {
        void vscode.window.showWarningMessage('CodeMeld: no file or directory selected.');
        return;
      }
      void vscode.window.setStatusBarMessage(`CodeMeld: selected ${vscode.workspace.asRelativePath(selectedForCompare)}`, 2500);
    }),

    vscode.commands.registerCommand('codemeld.compareWithSelected', async (uri?: vscode.Uri) => {
      const right = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!selectedForCompare || !right) {
        void vscode.window.showWarningMessage('CodeMeld: select the first file or directory with “Select for Compare”.');
        return;
      }
      if (selectedForCompare.toString() === right.toString()) {
        void vscode.window.showWarningMessage('CodeMeld: choose a different second item.');
        return;
      }

      const left = selectedForCompare;
      const [leftStat, rightStat] = await Promise.all([
        vscode.workspace.fs.stat(left),
        vscode.workspace.fs.stat(right),
      ]);
      const leftIsDir = (leftStat.type & vscode.FileType.Directory) !== 0;
      const rightIsDir = (rightStat.type & vscode.FileType.Directory) !== 0;

      if (leftIsDir !== rightIsDir) {
        void vscode.window.showErrorMessage('CodeMeld: a file cannot be compared with a directory. Select two files or two directories.');
        return;
      }

      if (leftIsDir) {
        try {
          const comparison = await compareDirectories(left, right, readDirectoryExcludeFilters(context));
          CompareManager.showDirectoryComparison(context, { leftUri: left, rightUri: right, comparison });
        } catch (error) {
          void vscode.window.showErrorMessage(`CodeMeld: directory comparison failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }

      const [leftBytes, rightBytes] = await Promise.all([
        vscode.workspace.fs.readFile(left),
        vscode.workspace.fs.readFile(right),
      ]);
      const decoder = new TextDecoder('utf-8');
      const leftText = decoder.decode(leftBytes);
      const rightText = decoder.decode(rightBytes);
      const revision = new DiffEngine().diffText(leftText, rightText);

      CompareManager.showComparison(context, {
        leftUri: left,
        rightUri: right,
        leftText,
        rightText,
        revision,
      });
    }),
  );
}

export function deactivate(): void {}
