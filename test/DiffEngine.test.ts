import assert from 'node:assert/strict';
import test from 'node:test';
import { DiffEngine } from '../src/core/DiffEngine';

const engine = new DiffEngine();

test('equal files have no deltas', () => {
  assert.deepEqual(engine.diffText('a\nb\n', 'a\nb\n').deltas, []);
});

test('detects insertion', () => {
  assert.deepEqual(engine.diffText('a\nc\n', 'a\nb\nc\n').deltas, [
    { type: 'add', left: { anchor: 1, size: 0 }, right: { anchor: 1, size: 1 } },
  ]);
});

test('detects deletion', () => {
  assert.deepEqual(engine.diffText('a\nb\nc\n', 'a\nc\n').deltas, [
    { type: 'delete', left: { anchor: 1, size: 1 }, right: { anchor: 1, size: 0 } },
  ]);
});

test('coalesces replacement into change and creates intra-line diff', () => {
  const deltas = engine.diffText('a\nconst value = 10;\nc\n', 'a\nconst value = 20;\nc\n').deltas;
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].type, 'change');
  assert.deepEqual(deltas[0].left, { anchor: 1, size: 1 });
  assert.deepEqual(deltas[0].right, { anchor: 1, size: 1 });
  assert.deepEqual(deltas[0].innerChanges, [
    { leftLine: 1, leftStart: 14, leftLength: 1, rightLine: 1, rightStart: 14, rightLength: 1 },
  ]);
});

test('can ignore whitespace', () => {
  assert.equal(engine.diffText('a   b\n', 'a b\n', { ignoreWhitespace: true }).deltas.length, 0);
});
