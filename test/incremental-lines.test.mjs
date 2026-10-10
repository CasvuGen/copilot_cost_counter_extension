import assert from 'node:assert/strict';
import test from 'node:test';
import { takeCompleteLines } from '../dist/incrementalLines.js';

test('retains incomplete lines and UTF-8 bytes across chunks', () => {
  const state = { remainder: Buffer.alloc(0) };
  const first = Buffer.concat([Buffer.from('first-€\r'), Buffer.from([0x0a, 0xe2])]);
  assert.deepEqual(takeCompleteLines(state, first), ['first-€']);
  assert.deepEqual(takeCompleteLines(state, Buffer.from([0x82, 0xac, 0x0a])), ['€']);
  assert.equal(state.remainder.length, 0);
});

test('does not emit a trailing partial record', () => {
  const state = { remainder: Buffer.alloc(0) };
  assert.deepEqual(takeCompleteLines(state, Buffer.from('complete\npartial')), ['complete']);
  assert.equal(state.remainder.toString('utf8'), 'partial');
});