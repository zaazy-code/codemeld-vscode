import type { Stats } from 'fs';
import type { FileMetadata, MetadataField, PlatformCapabilities } from './types';

export interface PlatformAdapter {
  readonly capabilities: PlatformCapabilities;
  enrichMetadata(nativePath: string, stat: Stats): Promise<FileMetadata>;
  otherMetadataDiffers(a: FileMetadata, b: FileMetadata): boolean;
  copyMetadataField(source: string, target: string, field: MetadataField): Promise<void>;
}
