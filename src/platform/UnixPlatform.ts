import * as fs from 'fs/promises';
import type { Stats } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { PlatformAdapter } from './PlatformAdapter';
import type { FileMetadata, MetadataField, PlatformCapabilities } from './types';

const execFileAsync = promisify(execFile);

export abstract class UnixPlatform implements PlatformAdapter {
  protected readonly userNameCache = new Map<number, string | undefined>();
  protected readonly groupNameCache = new Map<number, string | undefined>();

  abstract readonly capabilities: PlatformCapabilities;

  protected async resolveUserName(uid: number): Promise<string | undefined> {
    if (this.userNameCache.has(uid)) return this.userNameCache.get(uid);
    let value: string | undefined;
    try {
      if (this.capabilities.platform === 'linux') {
        const { stdout } = await execFileAsync('getent', ['passwd', String(uid)]);
        value = stdout.trim().split(':')[0] || undefined;
      } else {
        const { stdout } = await execFileAsync('id', ['-nu', String(uid)]);
        value = stdout.trim() || undefined;
      }
    } catch {
      try {
        const { stdout } = await execFileAsync('id', ['-nu', String(uid)]);
        value = stdout.trim() || undefined;
      } catch {
        value = undefined;
      }
    }
    this.userNameCache.set(uid, value);
    return value;
  }

  protected async resolveGroupName(gid: number): Promise<string | undefined> {
    if (this.groupNameCache.has(gid)) return this.groupNameCache.get(gid);
    let value: string | undefined;
    try {
      if (this.capabilities.platform === 'macos') {
        const { stdout } = await execFileAsync('dscl', ['.', '-search', '/Groups', 'PrimaryGroupID', String(gid)]);
        value = stdout.trim().split(/\s+/)[0] || undefined;
      } else {
        const { stdout } = await execFileAsync('getent', ['group', String(gid)]);
        value = stdout.trim().split(':')[0] || undefined;
      }
    } catch {
      value = undefined;
    }
    this.groupNameCache.set(gid, value);
    return value;
  }

  async enrichMetadata(_nativePath: string, stat: Stats): Promise<FileMetadata> {
    const uid = typeof stat.uid === 'number' ? stat.uid : undefined;
    const gid = typeof stat.gid === 'number' ? stat.gid : undefined;
    const [userName, groupName] = await Promise.all([
      uid === undefined ? undefined : this.resolveUserName(uid),
      gid === undefined ? undefined : this.resolveGroupName(gid),
    ]);
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      birthtimeMs: stat.birthtimeMs,
      mode: stat.mode & 0o7777,
      uid,
      gid,
      userName,
      groupName,
    };
  }

  otherMetadataDiffers(a: FileMetadata, b: FileMetadata): boolean {
    return a.mode !== b.mode || a.uid !== b.uid || a.gid !== b.gid;
  }

  async copyMetadataField(source: string, target: string, field: MetadataField): Promise<void> {
    const stat = await fs.lstat(source);
    if (field === 'mtime') {
      const targetStat = await fs.lstat(target);
      await fs.utimes(target, targetStat.atime, stat.mtime);
      return;
    }
    if (field === 'birthtime') {
      await this.setCreationTime(source, target, stat);
      return;
    }
    if (field === 'user') {
      const targetStat = await fs.lstat(target);
      await fs.chown(target, stat.uid, targetStat.gid);
      return;
    }
    if (field === 'group') {
      const targetStat = await fs.lstat(target);
      await fs.chown(target, targetStat.uid, stat.gid);
      return;
    }
    if (field === 'permRead' || field === 'permWrite' || field === 'permExecute' || field === 'permSpecial') {
      const targetStat = await fs.lstat(target);
      const sourceMode = stat.mode & 0o7777;
      const targetMode = targetStat.mode & 0o7777;
      const mask = field === 'permRead' ? 0o444 : field === 'permWrite' ? 0o222 : field === 'permExecute' ? 0o111 : 0o7000;
      const mergedMode = (targetMode & ~mask) | (sourceMode & mask);
      await fs.chmod(target, mergedMode);
      return;
    }
    throw new Error(`Metadata field ${field} is not supported on ${this.capabilities.platform}.`);
  }

  protected async setCreationTime(_source: string, _target: string, _stat: Stats): Promise<void> {
    throw new Error(`Creation-time transfer is not supported on ${this.capabilities.platform}.`);
  }
}
