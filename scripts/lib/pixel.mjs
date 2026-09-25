// ドット絵アセットを作るスクリプト共通の処理 (RGBA のピクセル配列、パレット確認、保存)

import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

export const palette = JSON.parse(await readFile('docs/art/palette.json', 'utf8')).colors;
export const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];
export const CLEAR = [0, 0, 0, 0];

export const makeImage = (width, height, fill = CLEAR) => {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(fill, i * 4);
  return { width, height, data };
};
export const setPx = (img, x, y, c) => img.data.set(c, (y * img.width + x) * 4);
export const getPx = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

export const assertPalette = (img, name) => {
  const allowed = new Set(palette.map((h) => h.toLowerCase()));
  for (let i = 0; i < img.width * img.height; i++) {
    const [r, g, b, a] = img.data.subarray(i * 4, i * 4 + 4);
    if (a === 0) continue;
    const h = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    if (a !== 255 || !allowed.has(h)) throw new Error(`${name}: パレット外の色 ${h} (alpha ${a})`);
  }
};

export const save = async (img, path) => {
  const raw = { raw: { width: img.width, height: img.height, channels: 4 } };
  // インデックスカラーで保存し、読み戻して色が変わっていないか確かめる (変わる場合は RGBA で保存)
  const indexed = await sharp(img.data, raw).png({ palette: true, colors: 256, dither: 0, effort: 10 }).toBuffer();
  const back = await sharp(indexed).ensureAlpha().raw().toBuffer();
  const same = back.length === img.data.length && back.every((v, i) => v === img.data[i] || (img.data[(i & ~3) + 3] === 0 && back[(i & ~3) + 3] === 0));
  const buf = same ? indexed : await sharp(img.data, raw).png().toBuffer();
  await sharp(buf).toFile(path);
  console.log(`${path} (${img.width}x${img.height}${buf === indexed ? ', indexed' : ', rgba'})`);
};

export const savePreview = async (img, path, scale) => {
  await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
    .resize(img.width * scale, img.height * scale, { kernel: 'nearest' })
    .png()
    .toFile(path);
  console.log(`${path} (preview x${scale})`);
};

export const blit = (dst, src, ox, oy) => {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const c = getPx(src, x, y);
      const dx = ox + x;
      const dy = oy + y;
      if (c[3] > 0 && dx >= 0 && dy >= 0 && dx < dst.width && dy < dst.height) setPx(dst, dx, dy, c);
    }
  }
};

// 固定 seed の乱数 (mulberry32)
export const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};


export const rotateNearest = (src, deg) => {
  const out = makeImage(src.width, src.height);
  const a = (deg * Math.PI) / 180;
  const c = src.width / 2;
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      const sx = Math.floor(Math.cos(a) * dx + Math.sin(a) * dy + c);
      const sy = Math.floor(-Math.sin(a) * dx + Math.cos(a) * dy + c);
      if (sx >= 0 && sy >= 0 && sx < src.width && sy < src.height) setPx(out, x, y, getPx(src, sx, sy));
    }
  }
  return out;
};

export const loadImage = async (path) => {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
};

// Scale2x (EPX): 輪郭の段差を保ったまま 2 倍にする
const scale2x = (src) => {
  const out = makeImage(src.width * 2, src.height * 2);
  const at = (x, y) => getPx(src, Math.max(0, Math.min(src.width - 1, x)), Math.max(0, Math.min(src.height - 1, y)));
  const eq = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const p = at(x, y); const a = at(x, y - 1); const b = at(x + 1, y); const c = at(x - 1, y); const d = at(x, y + 1);
      const e0 = eq(c, a) && !eq(c, d) && !eq(a, b) ? a : p;
      const e1 = eq(a, b) && !eq(a, c) && !eq(b, d) ? b : p;
      const e2 = eq(d, c) && !eq(d, b) && !eq(c, a) ? c : p;
      const e3 = eq(b, d) && !eq(b, a) && !eq(d, c) ? d : p;
      setPx(out, x * 2, y * 2, e0); setPx(out, x * 2 + 1, y * 2, e1); setPx(out, x * 2, y * 2 + 1, e2); setPx(out, x * 2 + 1, y * 2 + 1, e3);
    }
  }
  return out;
};

// RotSprite 風の回転: Scale2x で 8 倍にしてから回転し、各ドットの中心を拾って元の大きさに戻す。
// 最近傍の回転より輪郭の崩れが少ない (宣伝用の一枚絵など、止め絵で任意の角度に回す場合に使う)
export const rotateSmooth = (src, deg) => {
  const big = scale2x(scale2x(scale2x(src)));
  const out = makeImage(src.width, src.height);
  const a = (deg * Math.PI) / 180;
  const c = src.width / 2;
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      const sx = Math.cos(a) * dx + Math.sin(a) * dy + c;
      const sy = -Math.sin(a) * dx + Math.cos(a) * dy + c;
      const bx = Math.floor(sx * 8);
      const by = Math.floor(sy * 8);
      if (bx >= 0 && by >= 0 && bx < big.width && by < big.height) setPx(out, x, y, getPx(big, bx, by));
    }
  }
  return out;
};
