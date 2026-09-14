import { Delta, DiffOptions, InnerChange, Revision } from './model';

type Op = { kind: 'equal' | 'delete' | 'insert'; left?: number; right?: number };

export class DiffEngine {
  diffText(leftText: string, rightText: string, options: DiffOptions = {}): Revision {
    const left = splitLines(leftText);
    const right = splitLines(rightText);
    return this.diffLines(left, right, options);
  }

  diffLines(left: string[], right: string[], options: DiffOptions = {}): Revision {
    const a = left.map((line) => normalize(line, options));
    const b = right.map((line) => normalize(line, options));
    const operations = myers(a, b);
    const deltas = coalesce(operations);

    for (const delta of deltas) {
      if (delta.type !== 'change') continue;
      const pairedLines = Math.min(delta.left.size, delta.right.size);
      const innerChanges: InnerChange[] = [];

      for (let i = 0; i < pairedLines; i++) {
        const leftLineIndex = delta.left.anchor + i;
        const rightLineIndex = delta.right.anchor + i;
        innerChanges.push(...diffCharacters(
          left[leftLineIndex] ?? '',
          right[rightLineIndex] ?? '',
          leftLineIndex,
          rightLineIndex,
        ));
      }

      if (innerChanges.length > 0) delta.innerChanges = innerChanges;
    }

    return {
      leftLineCount: left.length,
      rightLineCount: right.length,
      deltas,
    };
  }
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function normalize(line: string, options: DiffOptions): string {
  let result = line;
  if (options.ignoreWhitespace) result = result.replace(/\s+/g, ' ').trim();
  if (options.ignoreCase) result = result.toLocaleLowerCase();
  return result;
}

/** Standard Myers O((N+M)D) shortest-edit-script implementation. */
function myers(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const offset = max;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];

  v[offset + 1] = 0;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const idx = offset + k;
      let x: number;
      if (k === -d || (k !== d && v[idx - 1] < v[idx + 1])) {
        x = v[idx + 1];
      } else {
        x = v[idx - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[idx] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d, offset);
    }
  }
  return [];
}

function backtrack(trace: Int32Array[], a: string[], b: string[], maxD: number, offset: number): Op[] {
  let x = a.length;
  let y = b.length;
  const result: Op[] = [];

  for (let d = maxD; d > 0; d--) {
    const previous = trace[d];
    const k = x - y;
    const idx = offset + k;
    const previousK = k === -d || (k !== d && previous[idx - 1] < previous[idx + 1]) ? k + 1 : k - 1;
    const previousX = previous[offset + previousK];
    const previousY = previousX - previousK;

    while (x > previousX && y > previousY) {
      result.push({ kind: 'equal', left: x - 1, right: y - 1 });
      x--;
      y--;
    }

    if (x === previousX) {
      result.push({ kind: 'insert', right: y - 1 });
      y--;
    } else {
      result.push({ kind: 'delete', left: x - 1 });
      x--;
    }
  }

  while (x > 0 && y > 0) {
    result.push({ kind: 'equal', left: x - 1, right: y - 1 });
    x--;
    y--;
  }
  while (x > 0) result.push({ kind: 'delete', left: --x });
  while (y > 0) result.push({ kind: 'insert', right: --y });

  return result.reverse();
}

function coalesce(ops: Op[]): Delta[] {
  const deltas: Delta[] = [];
  let leftPos = 0;
  let rightPos = 0;
  let leftStart = 0;
  let rightStart = 0;
  let deletes = 0;
  let inserts = 0;
  let active = false;

  const flush = () => {
    if (!active) return;
    deltas.push({
      type: deletes > 0 && inserts > 0 ? 'change' : deletes > 0 ? 'delete' : 'add',
      left: { anchor: leftStart, size: deletes },
      right: { anchor: rightStart, size: inserts },
    });
    active = false;
    deletes = 0;
    inserts = 0;
  };

  for (const op of ops) {
    if (op.kind === 'equal') {
      flush();
      leftPos++;
      rightPos++;
      continue;
    }
    if (!active) {
      active = true;
      leftStart = leftPos;
      rightStart = rightPos;
    }
    if (op.kind === 'delete') {
      deletes++;
      leftPos++;
    } else {
      inserts++;
      rightPos++;
    }
  }
  flush();
  return deltas;
}

/** Character-level Myers diff for one paired changed line. */
function diffCharacters(left: string, right: string, leftLine: number, rightLine: number): InnerChange[] {
  if (left === right) return [];

  // Monaco columns are UTF-16 based, therefore split into UTF-16 code units rather than code points.
  const a = left.split('');
  const b = right.split('');
  const ops = myers(a, b);
  const result: InnerChange[] = [];

  let leftPos = 0;
  let rightPos = 0;
  let leftStart = 0;
  let rightStart = 0;
  let deletes = 0;
  let inserts = 0;
  let active = false;

  const flush = () => {
    if (!active) return;
    result.push({
      leftLine,
      leftStart,
      leftLength: deletes,
      rightLine,
      rightStart,
      rightLength: inserts,
    });
    active = false;
    deletes = 0;
    inserts = 0;
  };

  for (const op of ops) {
    if (op.kind === 'equal') {
      flush();
      leftPos++;
      rightPos++;
      continue;
    }

    if (!active) {
      active = true;
      leftStart = leftPos;
      rightStart = rightPos;
    }

    if (op.kind === 'delete') {
      deletes++;
      leftPos++;
    } else {
      inserts++;
      rightPos++;
    }
  }
  flush();
  return result;
}
