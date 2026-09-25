import { BitmapFont } from './BitmapFont';
import type { TextOptions } from './BitmapFont';

let uiFont = new BitmapFont(null);

/**
 * フォント画像を設定する。起動時の読み込みが終わったら、アセットローダーの ui-font-5x7 を渡す
 * (それまでと、読めなかった場合は等幅のシステムフォントで描く)
 */
export function setUiFontImage(image: HTMLImageElement | null): void {
  uiFont = new BitmapFont(image);
}

/** HUD・メニュー共通のフォント */
export function getUiFont(): BitmapFont {
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
