export interface MergeConflict {
  baseStartLine: number;
  baseEndLine: number;
  base: string[];
  local: string[];
  remote: string[];
}

export type ThreeWayMergeResult =
  | {
      status: 'clean';
      merged: string;
      conflicts: [];
    }
  | {
      status: 'conflict';
      merged: string;
      conflicts: MergeConflict[];
    };

type Hunk = { start: number; end: number; replacement: string[] };

function diffHunks(base: string[], updated: string[]): Hunk[] {
  // ponytail: line-level LCS is bounded for predictable editor latency; very large notes become one reviewable hunk.
  if (base.length * updated.length > 4_000_000) return [{ start: 0, end: base.length, replacement: updated }];
  const table = Array.from({ length: base.length + 1 }, () => new Uint32Array(updated.length + 1));
  for (let row = base.length - 1; row >= 0; row -= 1) {
    for (let column = updated.length - 1; column >= 0; column -= 1) {
      table[row]![column] = base[row] === updated[column] ? table[row + 1]![column + 1]! + 1 : Math.max(table[row + 1]![column]!, table[row]![column + 1]!);
    }
  }
  const operations: Array<{ kind: 'equal' | 'delete' | 'insert'; value: string }> = [];
  let row = 0;
  let column = 0;
  while (row < base.length || column < updated.length) {
    if (row < base.length && column < updated.length && base[row] === updated[column]) {
      operations.push({ kind: 'equal', value: base[row]! });
      row += 1;
      column += 1;
    } else if (column < updated.length && (row >= base.length || table[row]![column + 1]! >= table[row + 1]![column]!)) {
      operations.push({ kind: 'insert', value: updated[column]! });
      column += 1;
    } else {
      operations.push({ kind: 'delete', value: base[row]! });
      row += 1;
    }
  }

  const hunks: Hunk[] = [];
  let baseIndex = 0;
  for (let operationIndex = 0; operationIndex < operations.length;) {
    if (operations[operationIndex]!.kind === 'equal') {
      baseIndex += 1;
      operationIndex += 1;
      continue;
    }
    const start = baseIndex;
    const replacement: string[] = [];
    let end = baseIndex;
    while (operationIndex < operations.length && operations[operationIndex]!.kind !== 'equal') {
      const operation = operations[operationIndex]!;
      if (operation.kind === 'delete') {
        end += 1;
        baseIndex += 1;
      } else {
        replacement.push(operation.value);
      }
      operationIndex += 1;
    }
    hunks.push({ start, end, replacement });
  }
  return hunks;
}

function overlaps(left: Hunk, right: Hunk): boolean {
  if (left.start === left.end && right.start === right.end) return left.start === right.start;
  if (left.start === left.end) return left.start >= right.start && left.start < right.end;
  if (right.start === right.end) return right.start >= left.start && right.start < left.end;
  return left.start < right.end && right.start < left.end;
}

function overlapsRange(hunk: Hunk, start: number, end: number): boolean {
  if (start === end) return hunk.start === start && hunk.end === end;
  if (hunk.start === hunk.end) return hunk.start >= start && hunk.start < end;
  return hunk.start < end && start < hunk.end;
}

function applyHunks(base: string[], start: number, end: number, hunks: Hunk[]): string[] {
  const result: string[] = [];
  let cursor = start;
  for (const hunk of hunks) {
    if (hunk.start < start || hunk.start > end) continue;
    if (hunk.start > cursor) result.push(...base.slice(cursor, hunk.start));
    result.push(...hunk.replacement);
    cursor = Math.max(cursor, hunk.end);
  }
  if (cursor < end) result.push(...base.slice(cursor, end));
  return result;
}

export function threeWayMerge(baseValue: string, localValue: string, remoteValue: string): ThreeWayMergeResult {
  const baseText = baseValue.replace(/\r\n?/g, '\n');
  const localText = localValue.replace(/\r\n?/g, '\n');
  const remoteText = remoteValue.replace(/\r\n?/g, '\n');
  if (remoteText === baseText) return { status: 'clean', merged: localText, conflicts: [] };
  if (localText === baseText) return { status: 'clean', merged: remoteText, conflicts: [] };
  if (localText === remoteText) return { status: 'clean', merged: localText, conflicts: [] };

  const base = baseText.split('\n');
  const localHunks = diffHunks(base, localText.split('\n'));
  const remoteHunks = diffHunks(base, remoteText.split('\n'));
  const merged: string[] = [];
  const conflicts: MergeConflict[] = [];
  let cursor = 0;
  let localIndex = 0;
  let remoteIndex = 0;

  while (cursor < base.length || localIndex < localHunks.length || remoteIndex < remoteHunks.length) {
    const localHunk = localHunks[localIndex];
    const remoteHunk = remoteHunks[remoteIndex];
    const nextStart = Math.min(localHunk?.start ?? base.length, remoteHunk?.start ?? base.length);
    if (cursor < nextStart) {
      merged.push(...base.slice(cursor, nextStart));
      cursor = nextStart;
      continue;
    }
    if (!localHunk && !remoteHunk) {
      merged.push(...base.slice(cursor));
      break;
    }
    if (localHunk && (!remoteHunk || (localHunk.start <= remoteHunk.start && !overlaps(localHunk, remoteHunk)))) {
      merged.push(...localHunk.replacement);
      cursor = localHunk.end;
      localIndex += 1;
      continue;
    }
    if (remoteHunk && (!localHunk || (remoteHunk.start <= localHunk.start && !overlaps(localHunk, remoteHunk)))) {
      merged.push(...remoteHunk.replacement);
      cursor = remoteHunk.end;
      remoteIndex += 1;
      continue;
    }

    const conflictStart = cursor;
    let conflictEnd = Math.max(localHunk?.end ?? conflictStart, remoteHunk?.end ?? conflictStart);
    const localGroup: Hunk[] = [];
    const remoteGroup: Hunk[] = [];
    let expanded = true;
    while (expanded) {
      expanded = false;
      const nextLocal = localHunks[localIndex];
      if (nextLocal && overlapsRange(nextLocal, conflictStart, conflictEnd)) {
        localGroup.push(nextLocal);
        conflictEnd = Math.max(conflictEnd, nextLocal.end);
        localIndex += 1;
        expanded = true;
      }
      const nextRemote = remoteHunks[remoteIndex];
      if (nextRemote && overlapsRange(nextRemote, conflictStart, conflictEnd)) {
        remoteGroup.push(nextRemote);
        conflictEnd = Math.max(conflictEnd, nextRemote.end);
        remoteIndex += 1;
        expanded = true;
      }
    }
    const localLines = applyHunks(base, conflictStart, conflictEnd, localGroup);
    const remoteLines = applyHunks(base, conflictStart, conflictEnd, remoteGroup);
    if (localLines.join('\n') === remoteLines.join('\n')) {
      merged.push(...localLines);
    } else {
      conflicts.push({ baseStartLine: conflictStart, baseEndLine: conflictEnd, base: base.slice(conflictStart, conflictEnd), local: localLines, remote: remoteLines });
      merged.push('<<<<<<< LOCAL', ...localLines, '||||||| BASE', ...base.slice(conflictStart, conflictEnd), '=======', ...remoteLines, '>>>>>>> REMOTE');
    }
    cursor = conflictEnd;
  }

  return conflicts.length ? { status: 'conflict', merged: merged.join('\n'), conflicts } : { status: 'clean', merged: merged.join('\n'), conflicts: [] };
}
