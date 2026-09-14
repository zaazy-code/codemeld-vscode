export type PlatformName = 'macos' | 'linux' | 'windows' | 'unsupported';

export interface PlatformCapabilities {
  platform: PlatformName;
  remoteName?: string;
  arch: string;
  canReadCreationTime: boolean;
  canWriteCreationTime: boolean;
  canReadOwner: boolean;
  canWriteOwner: boolean;
  canReadGroup: boolean;
  canWriteGroup: boolean;
  posixPermissions: boolean;
  windowsAcl: boolean;
}

export interface FileMetadata {
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
  mode?: number;
  uid?: number;
  gid?: number;
  userName?: string;
  groupName?: string;
  ownerName?: string;
  aclSddl?: string;
}

export type MetadataField =
  | 'mtime'
  | 'birthtime'
  | 'user'
  | 'group'
  | 'permRead'
  | 'permWrite'
  | 'permExecute'
  | 'permSpecial'
  | 'owner'
  | 'acl';
