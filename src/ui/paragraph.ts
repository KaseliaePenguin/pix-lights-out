import type { TextAlign } from './BitmapFont';
import { drawText, textAdvance } from './text';

/** 1 行の高さ (標準文字 14px + 行間 6px、style-guide.md §6 の 20px) */
export const paragraphLineHeight = 20;

/** 単語の区切りで maxChars 文字ごとに折り返す (長すぎる単語は途中で切る) */
export function wrapText(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    let w = word;
    while (w.length > maxChars) {
      if (line) {
        lines.push(line);
        line = '';
      }
      lines.push(w.slice(0, maxChars));
      w = w.slice(maxChars);
    }
    if (!line) line = w;
    else if (line.length + 1 + w.length <= maxChars) line += ` ${w}`;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * 幅 width (px) で折り返して描く。複数の段落を渡せる。描いた高さ (px) を返す。maxLines を超えた分は描かない
 */
export function drawParagraph(
  ctx: CanvasRenderingContext2D,
  text: string | readonly string[],
  x: number,
  y: number,
  width: number,
  options: { color: string; align?: TextAlign; maxLines?: number },
): number {
  const maxChars = Math.max(1, Math.floor((width + 2) / textAdvance()));
  const paragraphs = typeof text === 'string' ? [text] : text;
  const lines: string[] = [];
  for (const p of paragraphs) lines.push(...wrapText(p, maxChars));
  const count = Math.min(lines.length, options.maxLines ?? Infinity);
  const align = options.align ?? 'left';
  const ax = align === 'center' ? x + width / 2 : align === 'right' ? x + width : x;
  for (let i = 0; i < count; i++) drawText(ctx, lines[i], ax, y + i * paragraphLineHeight, { color: options.color, align });
  return count * paragraphLineHeight;
}
