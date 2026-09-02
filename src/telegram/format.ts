const MARKDOWN_V2_RESERVED = '_*[]()~`>#+-=|{}.!';

export function escapeMarkdownV2(text: string): string {
  let escaped = '';
  for (const character of text) {
    escaped += MARKDOWN_V2_RESERVED.includes(character) ? `\\${character}` : character;
  }
  return escaped;
}

export function chunkText(text: string, max = 4096): string[] {
  if (!text.trim()) return ['(no output)'];
  if (!Number.isInteger(max) || max < 1) throw new RangeError('max must be a positive integer');

  const chunks: string[] = [];
  const paragraphs = text.split('\n\n');
  let current = '';

  for (const paragraph of paragraphs) {
    if (paragraph.length <= max) {
      const separator = current.length === 0 ? '' : '\n\n';
      const candidate = `${current}${separator}${paragraph}`;
      if (candidate.length <= max) {
        current = candidate;
      } else {
        if (current.length > 0) chunks.push(current);
        current = paragraph;
      }
      continue;
    }

    const lines = paragraph.split('\n');
    for (const [lineIndex, line] of lines.entries()) {
      if (line.length > max) {
        if (current.length > 0) chunks.push(current);
        current = '';
        for (let offset = 0; offset < line.length; offset += max) {
          chunks.push(line.slice(offset, offset + max));
        }
        continue;
      }

      const separator = current.length === 0 ? '' : lineIndex === 0 ? '\n\n' : '\n';
      const candidate = `${current}${separator}${line}`;
      if (candidate.length <= max) {
        current = candidate;
      } else {
        if (current.length > 0) chunks.push(current);
        current = line;
      }
    }
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}
