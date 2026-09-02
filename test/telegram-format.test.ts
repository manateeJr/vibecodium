import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkText, escapeMarkdownV2 } from '../src/telegram/format.js';

test('escapeMarkdownV2 escapes every reserved character and preserves plain text', () => {
  const reserved = '_*[]()~`>#+-=|{}.!';
  const expected = [...reserved].map((character) => `\\${character}`).join('');
  assert.equal(escapeMarkdownV2(reserved), expected);
  assert.equal(
    escapeMarkdownV2('A plain sentence stays unchanged'),
    'A plain sentence stays unchanged',
  );
});

test('chunkText packs paragraphs and splits at a paragraph boundary', () => {
  assert.deepEqual(chunkText('alpha\n\nbeta\n\ngamma', 12), ['alpha\n\nbeta', 'gamma']);
});

test('chunkText keeps the real Telegram limit', () => {
  const chunks = chunkText(`${'a'.repeat(4096)}\n${'b'.repeat(4096)}`);
  assert.deepEqual(chunks, ['a'.repeat(4096), 'b'.repeat(4096)]);
  assert.equal(
    chunks.every((chunk) => chunk.length <= 4096),
    true,
  );
});

test('chunkText splits long paragraphs on line boundaries', () => {
  assert.deepEqual(chunkText('1234\n5678\nx', 5), ['1234', '5678', 'x']);
});

test('chunkText hard-cuts an unbroken line', () => {
  assert.deepEqual(chunkText('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
});

test('chunkText returns a placeholder for empty or whitespace-only text', () => {
  assert.deepEqual(chunkText(''), ['(no output)']);
  assert.deepEqual(chunkText(' \n\t '), ['(no output)']);
});

test('chunkText preserves generated content apart from paragraph separators at boundaries', () => {
  const paragraphs = Array.from(
    { length: 200 },
    (_, index) => `paragraph-${index}\n${'x'.repeat(40)}`,
  );
  const input = paragraphs.join('\n\n');
  const chunks = chunkText(input);

  assert.equal(
    chunks.every((chunk) => chunk.length <= 4096),
    true,
  );
  assert.equal(
    chunks.every((chunk) => chunk.length > 0),
    true,
  );
  assert.equal(chunks.join('').replaceAll('\n\n', ''), input.replaceAll('\n\n', ''));
});
