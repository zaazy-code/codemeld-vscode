export type DeltaType = 'add' | 'delete' | 'change';

export interface Chunk {
  /** Zero-based line index. */
  anchor: number;
  /** Number of lines in the chunk. */
  size: number;
}

export interface InnerChange {
  /** Zero-based line index within the full left document. */
  leftLine: number;
  /** Zero-based UTF-16 column within the left line. */
  leftStart: number;
  leftLength: number;
  /** Zero-based line index within the full right document. */
  rightLine: number;
  /** Zero-based UTF-16 column within the right line. */
  rightStart: number;
  rightLength: number;
}

export interface Delta {
  type: DeltaType;
  left: Chunk;
  right: Chunk;
  /** Character-level changes for paired lines inside a CHANGE delta. */
  innerChanges?: InnerChange[];
}

export interface Revision {
  leftLineCount: number;
  rightLineCount: number;
  deltas: Delta[];
}

export interface DiffOptions {
  ignoreWhitespace?: boolean;
  ignoreCase?: boolean;
}
