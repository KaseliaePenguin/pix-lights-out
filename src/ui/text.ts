import { BitmapFont } from './BitmapFont';
import type { TextOptions } from './BitmapFont';

// TODO(assets): game-engineer のアセットローダーができたら、読み込み済みの画像を使う形に差し替える
const fontPath = '/assets/ui/ui-font-5x7.png';

let uiFont: BitmapFont | null = null;

/** HUD・メニュー共通のフォント (初回呼び出し時に読み込みを始める) */
export function getUiFont(): BitmapFont {
  uiFont ??= new BitmapFont(fontPath);
  return uiFont;
}

/** (x, y) は align に応じた基準点の x と、文字の上端の y */
export function drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, options?: TextOptions): void {
  getUiFont().draw(ctx, text, x, y, options);
}

export function measureText(text: string, scale = 2): number {
  return getUiFont().measure(text, scale);
}

/** 1 文字の送り幅 (px)。等幅なので、n 文字目の位置は left + n × advance */
export function textAdvance(scale = 2): number {
  return getUiFont().advance(scale);
}
