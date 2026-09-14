import * as fs from 'fs/promises';
import type { Stats } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { PlatformAdapter } from './PlatformAdapter';
import type { FileMetadata, MetadataField, PlatformCapabilities } from './types';

const execFileAsync = promisify(execFile);

async function powershell(script: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script, ...args], { windowsHide: true });
  return stdout.trim();
}

export class WindowsPlatform implements PlatformAdapter {
  readonly capabilities: PlatformCapabilities;

  constructor(remoteName?: string) {
    this.capabilities = {
      platform: 'windows', remoteName, arch: process.arch,
      canReadCreationTime: true,
      canWriteCreationTime: true,
      canReadOwner: true,
      canWriteOwner: true,
      canReadGroup: false,
      canWriteGroup: false,
      posixPermissions: false,
      windowsAcl: true,
    };
  }

  async enrichMetadata(nativePath: string, stat: Stats): Promise<FileMetadata> {
    let ownerName: string | undefined;
    let aclSddl: string | undefined;
    try {
      const out = await powershell(
        "& { param($p) $a = Get-Acl -LiteralPath $p; [Console]::WriteLine($a.Owner); [Console]::WriteLine($a.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)) }",
        nativePath,
      );
      const lines = out.split(/\r?\n/);
      ownerName = lines.shift()?.trim() || undefined;
      aclSddl = lines.join('\n').trim() || undefined;
    } catch {
      ownerName = undefined;
      aclSddl = undefined;
    }
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      birthtimeMs: stat.birthtimeMs,
      ownerName,
      aclSddl,
    };
  }

  otherMetadataDiffers(a: FileMetadata, b: FileMetadata): boolean {
    return a.ownerName !== b.ownerName || a.aclSddl !== b.aclSddl;
  }

  async copyMetadataField(source: string, target: string, field: MetadataField): Promise<void> {
    const stat = await fs.lstat(source);
    if (field === 'mtime') {
      const targetStat = await fs.lstat(target);
      await fs.utimes(target, targetStat.atime, stat.mtime);
      return;
    }
    if (field === 'birthtime') {
      const iso = stat.birthtime.toISOString();
      await powershell(
        "& { param($p,$iso) $dt=[DateTime]::Parse($iso).ToLocalTime(); if ((Get-Item -LiteralPath $p).PSIsContainer) {[IO.Directory]::SetCreationTime($p,$dt)} else {[IO.File]::SetCreationTime($p,$dt)} }",
        target, iso,
      );
      return;
    }
    if (field === 'owner') {
      const owner = await powershell("& { param($p) (Get-Acl -LiteralPath $p).Owner }", source);
      await powershell(
        "& { param($p,$owner) $acl=Get-Acl -LiteralPath $p; $acl.SetOwner([System.Security.Principal.NTAccount]$owner); Set-Acl -LiteralPath $p -AclObject $acl }",
        target, owner,
      );
      return;
    }
    if (field === 'acl') {
      await powershell(
        "& { param($src,$dst) $s=Get-Acl -LiteralPath $src; $t=Get-Acl -LiteralPath $dst; $section=[System.Security.AccessControl.AccessControlSections]::Access; $t.SetSecurityDescriptorSddlForm($s.GetSecurityDescriptorSddlForm($section),$section); Set-Acl -LiteralPath $dst -AclObject $t }",
        source, target,
      );
      return;
    }
    throw new Error(`Metadata field ${field} is not supported on Windows.`);
  }
}
