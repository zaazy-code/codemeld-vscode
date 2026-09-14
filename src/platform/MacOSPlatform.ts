import type { Stats } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { UnixPlatform } from './UnixPlatform';
import type { PlatformCapabilities } from './types';

const execFileAsync = promisify(execFile);

export class MacOSPlatform extends UnixPlatform {
  readonly capabilities: PlatformCapabilities;

  constructor(remoteName: string | undefined, canWriteCreationTime: boolean) {
    super();
    this.capabilities = {
      platform: 'macos', remoteName, arch: process.arch,
      canReadCreationTime: true,
      canWriteCreationTime,
      canReadOwner: true,
      canWriteOwner: true,
      canReadGroup: true,
      canWriteGroup: true,
      posixPermissions: true,
      windowsAcl: false,
    };
  }

  protected override async setCreationTime(_source: string, target: string, stat: Stats): Promise<void> {
    if (!this.capabilities.canWriteCreationTime) throw new Error('Creation-time transfer requires Xcode Command Line Tools (SetFile).');
    const d = stat.birthtime;
    const pad = (v: number) => String(v).padStart(2, '0');
    const value = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    await execFileAsync('xcrun', ['SetFile', '-d', value, target]);
  }
}
