// 生成した元画像をゲーム用のピクセルアートスプライトに変換する
//
// 例: node scripts/process-sprite.mjs --in assets-src/generated/player-idle-123.png --out public/assets/images/player-idle.png --size 32
//
// 処理: ピクセルグリッド復元 → 背景除去 → 余白トリム → 指定サイズに配置 → 減色 (パレット指定時はパレットに寄せる)

import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';

const { values: args } = parseArgs({
  options: {
    in: { type: 'string' },
    out: { type: 'string' },
    size: { type: 'string', default: '32' },
    'pixel-size': { type: 'string', default: '8' },
    colors: { type: 'string', default: '16' },
    palette: { type: 'string' },
    bg: { type: 'string', default: 'auto' },
    tolerance: { type: 'string', default: '48' },
    anchor: { type: 'string', default: 'bottom' },
    'preview-dir': { type: 'string', default: 'assets-src/previews' },
  },
});

if (!args.in || !args.out) {
  console.error('Usage: node scripts/process-sprite.mjs --in <generated.png> --out <public/assets/...png> [--size 32] [--palette palette.json]');
  process.exit(1);
}

const size = Number(args.size);
const pixelSize = Number(args['pixel-size']);
const tolerance = Number(args.tolerance);

const src = await sharp(args.in).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

// 1. ピクセルグリッド復元: pixel-art-xl は約 8px 単位で描くため、各ブロックの中心色を 1px にする
let img = { width: Math.floor(src.info.width / pixelSize), height: Math.floor(src.info.height / pixelSize) };
img.data = Buffer.alloc(img.width * img.height * 4);
for (let y = 0; y < img.height; y++) {
  for (let x = 0; x < img.width; x++) {
    const sx = x * pixelSize + (pixelSize >> 1);
    const sy = y * pixelSize + (pixelSize >> 1);
    src.data.copy(img.data, (y * img.width + x) * 4, (sy * src.info.width + sx) * 4, (sy * src.info.width + sx) * 4 + 4);
  }
}

// 2. 背景除去: 四隅の平均色に近い色を外周から塗りつぶして透明にする
if (args.bg === 'auto') {
  const { width, height, data } = img;
  const corners = [0, width - 1, (height - 1) * width, height * width - 1];
  const bg = [0, 1, 2].map((c) => corners.reduce((sum, i) => sum + data[i * 4 + c], 0) / 4);
  const isBg = (i) => Math.hypot(data[i * 4] - bg[0], data[i * 4 + 1] - bg[1], data[i * 4 + 2] - bg[2]) < tolerance;
  const visited = new Uint8Array(width * height);
  const stack = [];
  for (let x = 0; x < width; x++) stack.push(x, (height - 1) * width + x);
  for (let y = 0; y < height; y++) stack.push(y * width, y * width + width - 1);
  while (stack.length) {
    const i = stack.pop();
    if (visited[i] || !isBg(i)) continue;
    visited[i] = 1;
    data[i * 4 + 3] = 0;
    const x = i % width;
    if (x > 0) stack.push(i - 1);
    if (x < width - 1) stack.push(i + 1);
    if (i >= width) stack.push(i - width);
    if (i < width * (height - 1)) stack.push(i + width);
  }
}

// 半透明を無くす (ピクセルアートは不透明か完全透明のどちらか)
for (let i = 3; i < img.data.length; i += 4) img.data[i] = img.data[i] < 128 ? 0 : 255;

// 3. 余白トリム
let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
for (let y = 0; y < img.height; y++) {
  for (let x = 0; x < img.width; x++) {
    if (img.data[(y * img.width + x) * 4 + 3] === 0) continue;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
}
if (maxX < 0) throw new Error('不透明なピクセルが残りませんでした。--tolerance を下げるか --bg none を試してください');
const cropW = maxX - minX + 1;
const cropH = maxY - minY + 1;

// 4. size×size に収める (縮小は nearest でピクセルを保つ)。anchor=bottom なら足元を下端に揃える
const scale = Math.min(1, size / cropW, size / cropH);
const fitW = Math.max(1, Math.round(cropW * scale));
const fitH = Math.max(1, Math.round(cropH * scale));
const offX = Math.floor((size - fitW) / 2);
const offY = args.anchor === 'bottom' ? size - fitH : Math.floor((size - fitH) / 2);
const out = Buffer.alloc(size * size * 4);
for (let y = 0; y < fitH; y++) {
  for (let x = 0; x < fitW; x++) {
    const sx = minX + Math.min(cropW - 1, Math.floor((x + 0.5) / scale));
    const sy = minY + Math.min(cropH - 1, Math.floor((y + 0.5) / scale));
    img.data.copy(out, ((y + offY) * size + x + offX) * 4, (sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4);
  }
}

// 5. 減色: パレット指定があれば最も近いパレット色に置き換え、なければ指定色数に量子化する
let pngOptions = { palette: true, colours: Number(args.colors), dither: 0 };
if (args.palette) {
  const palette = JSON.parse(await readFile(args.palette, 'utf8')).colors.map((hex) =>
    [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)),
  );
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) continue;
    let best = palette[0];
    let bestDist = Infinity;
    for (const color of palette) {
      const dist = (out[i] - color[0]) ** 2 + (out[i + 1] - color[1]) ** 2 + (out[i + 2] - color[2]) ** 2;
      if (dist < bestDist) { best = color; bestDist = dist; }
    }
    out[i] = best[0]; out[i + 1] = best[1]; out[i + 2] = best[2];
  }
  pngOptions = { palette: true, colours: Math.min(256, palette.length + 1), dither: 0 };
}

await mkdir(dirname(args.out), { recursive: true });
await sharp(out, { raw: { width: size, height: size, channels: 4 } }).png(pngOptions).toFile(args.out);
console.log(args.out);

// 確認用に 8 倍拡大したプレビューを出力する (Claude や人が目視確認するため)
await mkdir(args['preview-dir'], { recursive: true });
const previewPath = join(args['preview-dir'], basename(args.out));
await sharp(args.out).resize(size * 8, size * 8, { kernel: 'nearest' }).png().toFile(previewPath);
console.log(previewPath);
