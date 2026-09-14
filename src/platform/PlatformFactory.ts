import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import type { PlatformAdapter } from './PlatformAdapter';
import { MacOSPlatform } from './MacOSPlatform';
import { LinuxPlatform } from './LinuxPlatform';
import { WindowsPlatform } from './WindowsPlatform';

const execFileAsync = promisify(execFile);
let adapterPromise: Promise<PlatformAdapter> | undefined;

async function commandWorks(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args);
    return true;
  } catch {
    return false;
  }
}

export function getPlatformAdapter(): Promise<PlatformAdapter> {
  adapterPromise ??= createPlatformAdapter();
  return adapterPromise;
}

async function createPlatformAdapter(): Promise<PlatformAdapter> {
  const remoteName = vscode.env.remoteName ?? undefined;
  switch (process.platform) {
    case 'darwin': {
      const hasSetFile = await commandWorks('xcrun', ['--find', 'SetFile']);
      return new MacOSPlatform(remoteName, hasSetFile);
    }
    case 'linux':
      return new LinuxPlatform(remoteName);
    case 'win32':
      return new WindowsPlatform(remoteName);
    default:
      throw new Error(`CodeMeld does not support platform ${process.platform}.`);
  }
}
