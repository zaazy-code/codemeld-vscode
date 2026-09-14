import { UnixPlatform } from './UnixPlatform';
import type { PlatformCapabilities } from './types';

export class LinuxPlatform extends UnixPlatform {
  readonly capabilities: PlatformCapabilities;

  constructor(remoteName?: string) {
    super();
    this.capabilities = {
      platform: 'linux', remoteName, arch: process.arch,
      canReadCreationTime: true,
      canWriteCreationTime: false,
      canReadOwner: true,
      canWriteOwner: true,
      canReadGroup: true,
      canWriteGroup: true,
      posixPermissions: true,
      windowsAcl: false,
    };
  }
}
