import type { Assets } from '../core/Assets';
import type { WorldLayer } from '../core/WorldLayer';
import type { Track } from '../shared/Track';
import type { TexturePixels, TrackTextures } from './TrackPainter';
import { TrackPainter } from './TrackPainter';

/** 1 枚のチャンクの大きさ (ドット) */
const chunkSize = 256;
/** 覚えておくチャンクの最大数 (1 枚 256 KB。48 枚で約 12 MB) */
const maxCachedChunks = 48;
/** 画面の外側のこの範囲 (ドット) のチャンクを、1 フレームに 1 枚ずつ先に塗っておく */
const prefetchMargin = 128;

/**
 * コースの描画 (style-guide.md §5 のレイヤー 1〜9)。
 * ワールドは 3392×2288 ドットと大きいので、全体を 1 枚の画像にはせず、256×256 ドットのチャンクに分けて
 * 写ったときに初めて塗り、最近使ったものだけを覚えておく。コースの見た目は変わらないので、塗り直しはしない。
 */
export class TrackRenderer {
  private readonly painter: TrackPainter;
  private readonly cache = new Map<number, HTMLCanvasElement>();
  private readonly spare: HTMLCanvasElement[] = [];
  private readonly chunksX: number;
  private readonly chunksY: number;
  private readonly pixels: ImageData;

  constructor(track: Track, assets: Assets) {
    const textures: TrackTextures = {
      asphalt: readPixels(assets.getImage('tile-asphalt')),
      grass: readPixels(assets.getImage('tile-grass')),
      gravel: readPixels(assets.getImage('tile-gravel')),
      pit: readPixels(assets.getImage('tile-pit')),
    };
    this.painter = new TrackPainter(track, textures);
    this.chunksX = Math.ceil(this.painter.worldDotsWidth / chunkSize);
    this.chunksY = Math.ceil(this.painter.worldDotsHeight / chunkSize);
    this.pixels = new ImageData(chunkSize, chunkSize);
  }

  /** 開始位置の周りなど、最初に写る範囲を先に塗っておく (最初のフレームの引っかかりを減らす) */
  prepare(worldX: number, worldY: number): void {
    const cx = Math.floor(worldX / 2 / chunkSize);
    const cy = Math.floor(worldY / 2 / chunkSize);
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) this.chunk(x, y);
  }

  /** カメラが写す範囲のコースを描く (layer.setCamera の後に呼ぶ) */
  render(layer: WorldLayer): void {
    const left = layer.viewLeft / 2;
    const top = layer.viewTop / 2;
    const x0 = Math.max(0, Math.floor(left / chunkSize));
    const y0 = Math.max(0, Math.floor(top / chunkSize));
    const x1 = Math.min(this.chunksX - 1, Math.floor((left + layer.width - 1) / chunkSize));
    const y1 = Math.min(this.chunksY - 1, Math.floor((top + layer.height - 1) / chunkSize));
    const ctx = layer.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const canvas = this.chunk(cx, cy);
        if (canvas) ctx.drawImage(canvas, cx * chunkSize - left, cy * chunkSize - top);
      }
    }
    this.prefetch(left, top, layer.width, layer.height);
  }

  /** 画面のすぐ外のまだ塗っていないチャンクを 1 枚だけ塗る (走っていて新しいチャンクが写るときの引っかかりを防ぐ) */
  private prefetch(left: number, top: number, width: number, height: number): void {
    const x0 = Math.max(0, Math.floor((left - prefetchMargin) / chunkSize));
    const y0 = Math.max(0, Math.floor((top - prefetchMargin) / chunkSize));
    const x1 = Math.min(this.chunksX - 1, Math.floor((left + width + prefetchMargin) / chunkSize));
    const y1 = Math.min(this.chunksY - 1, Math.floor((top + height + prefetchMargin) / chunkSize));
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (this.cache.has(cy * this.chunksX + cx)) continue;
        this.chunk(cx, cy);
        return;
      }
    }
  }

  private chunk(cx: number, cy: number): HTMLCanvasElement | null {
    if (cx < 0 || cy < 0 || cx >= this.chunksX || cy >= this.chunksY) return null;
    const key = cy * this.chunksX + cx;
    const hit = this.cache.get(key);
    if (hit) {
      // 最近使ったものを Map の末尾に移す (先頭が最も古い)
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    if (this.cache.size >= maxCachedChunks) {
      const oldest = this.cache.keys().next().value as number;
      const canvas = this.cache.get(oldest);
      this.cache.delete(oldest);
      if (canvas) this.spare.push(canvas);
    }
    const canvas = this.spare.pop() ?? createChunkCanvas();
    this.painter.paint(cx * chunkSize, cy * chunkSize, chunkSize, chunkSize, this.pixels.data);
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.putImageData(this.pixels, 0, 0);
    this.cache.set(key, canvas);
    return canvas;
  }
}

function createChunkCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = chunkSize;
  canvas.height = chunkSize;
  return canvas;
}

/** 画像の画素を読む (テクスチャを 1 ドットずつ参照するため)。画像がなければ null (単色で代用する) */
function readPixels(image: HTMLImageElement | null): TexturePixels | null {
  if (!image || image.width === 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, image.width, image.height).data;
  return { width: image.width, height: image.height, data };
}
