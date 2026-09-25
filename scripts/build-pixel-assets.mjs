// ドット単位で作るアセット (基準車・路面テクスチャ・5x7 フォント) を書き出す
//
// 例: node scripts/build-pixel-assets.mjs
//
// 生成 AI では 10x20 の車・継ぎ目なしテクスチャ・フォントが作れないため (style-guide.md §2・§5・§7)、
// 設計図と固定 seed の乱数から直接ピクセルを打つ。確認用の拡大プレビューは assets-src/previews/ に出す。

import { mkdir, readFile } from 'node:fs/promises';
import sharp from 'sharp';

const IMG_DIR = 'public/assets/images';
const UI_DIR = 'public/assets/ui';
const PREVIEW_DIR = 'assets-src/previews';

const palette = JSON.parse(await readFile('docs/art/palette.json', 'utf8')).colors;
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];
const CLEAR = [0, 0, 0, 0];

// ---- 画像ユーティリティ (RGBA の配列) ----
const makeImage = (width, height, fill = CLEAR) => {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(fill, i * 4);
  return { width, height, data };
};
const setPx = (img, x, y, c) => img.data.set(c, (y * img.width + x) * 4);
const getPx = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

const assertPalette = (img, name) => {
  const allowed = new Set(palette.map((h) => h.toLowerCase()));
  for (let i = 0; i < img.width * img.height; i++) {
    const [r, g, b, a] = img.data.subarray(i * 4, i * 4 + 4);
    if (a === 0) continue;
    const h = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    if (a !== 255 || !allowed.has(h)) throw new Error(`${name}: パレット外の色 ${h} (alpha ${a})`);
  }
};

const save = async (img, path) => {
  const raw = { raw: { width: img.width, height: img.height, channels: 4 } };
  // インデックスカラーで保存し、読み戻して色が変わっていないか確かめる (変わる場合は RGBA で保存)
  const indexed = await sharp(img.data, raw).png({ palette: true, colors: 256, dither: 0, effort: 10 }).toBuffer();
  const back = await sharp(indexed).ensureAlpha().raw().toBuffer();
  const same = back.length === img.data.length && back.every((v, i) => v === img.data[i] || (img.data[(i & ~3) + 3] === 0 && back[(i & ~3) + 3] === 0));
  const buf = same ? indexed : await sharp(img.data, raw).png().toBuffer();
  await sharp(buf).toFile(path);
  console.log(`${path} (${img.width}x${img.height}${buf === indexed ? ', indexed' : ', rgba'})`);
};

const savePreview = async (img, path, scale) => {
  await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
    .resize(img.width * scale, img.height * scale, { kernel: 'nearest' })
    .png()
    .toFile(path);
  console.log(`${path} (preview x${scale})`);
};

const blit = (dst, src, ox, oy) => {
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
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

await mkdir(IMG_DIR, { recursive: true });
await mkdir(UI_DIR, { recursive: true });
await mkdir(PREVIEW_DIR, { recursive: true });

// ---- 1. 基準車 car-base.png (style-guide.md §2 の設計図そのまま、24x24 の中央) ----
const CAR_BLUEPRINT = [
  '.KPPPPPPK.',
  '.KKKPPKKK.',
  'TT..PP..TT',
  'TT..PP..TT',
  'TT.KPPK.TT',
  '...KPPK...',
  '..KPPPPK..',
  '.KPPKKPPK.',
  '.KPKHHKPK.',
  '.KPKKKKPK.',
  '.KPPPPPPK.',
  '.KPPPPPPK.',
  '.KPPPPPPK.',
  '..KPPPPK..',
  'TTKPPPPKTT',
  'TT.KPPK.TT',
  'TT.KPPK.TT',
  'TT..KK..TT',
  'KPPPPPPPPK',
  'KKKKKKKKKK',
];
// タイヤの外側の列に 1 ドットのハイライト (前輪 r03、後輪 r15)
const TYRE_HIGHLIGHTS = [[0, 3], [9, 3], [0, 15], [9, 15]];
const CAR_COLORS = { K: hex('#11111b'), T: hex('#11111b'), P: hex('#e8322b'), H: hex('#cdd6f4'), '.': CLEAR };

const car = makeImage(24, 24);
const CAR_X = 7; // 24x24 の中心 (12, 12) が車体の中心 (列 4-5 の間、行 9-10 の間) に来る位置
const CAR_Y = 2;
CAR_BLUEPRINT.forEach((row, y) => [...row].forEach((ch, x) => setPx(car, CAR_X + x, CAR_Y + y, CAR_COLORS[ch])));
for (const [x, y] of TYRE_HIGHLIGHTS) setPx(car, CAR_X + x, CAR_Y + y, hex('#313244'));
assertPalette(car, 'car-base');
await save(car, `${IMG_DIR}/car-base.png`);

// ---- 2. 路面テクスチャ (32x32、上下左右がつながる) ----
// 粒は「トーラス上で互いに一定距離以上離す」ランダム配置にし、固まり・縦横の並びを避ける
const scatter = (tile, rand, color, count, minDist, taken) => {
  const n = tile.width;
  const dist2 = (a, b) => {
    const dx = Math.min(Math.abs(a[0] - b[0]), n - Math.abs(a[0] - b[0]));
    const dy = Math.min(Math.abs(a[1] - b[1]), n - Math.abs(a[1] - b[1]));
    return dx * dx + dy * dy;
  };
  let placed = 0;
  for (let tries = 0; placed < count && tries < 200000; tries++) {
    const p = [Math.floor(rand() * n), Math.floor(rand() * n)];
    if (taken.some((q) => dist2(p, q) < minDist * minDist)) continue;
    taken.push(p);
    setPx(tile, p[0], p[1], color);
    placed++;
  }
  // 距離の条件で置ききれない密度 (砂利) は、残りを空いているドットに置く (2 ドットの粒になる)
  for (let tries = 0; placed < count && tries < 200000; tries++) {
    const p = [Math.floor(rand() * n), Math.floor(rand() * n)];
    if (taken.some((q) => q[0] === p[0] && q[1] === p[1])) continue;
    taken.push(p);
    setPx(tile, p[0], p[1], color);
    placed++;
  }
  if (placed < count) throw new Error(`粒を ${count} 個置けなかった (${placed})`);
};

const TILE = 32;
const AREA = TILE * TILE;

const asphalt = makeImage(TILE, TILE, hex('#3c3c46'));
{
  const rand = rng(1001);
  const taken = [];
  scatter(asphalt, rand, hex('#4b4b57'), Math.round(AREA * 0.08), 2, taken);
  scatter(asphalt, rand, hex('#2a2a33'), Math.round(AREA * 0.06), 2, taken);
}

const grass = makeImage(TILE, TILE);
{
  // 上半分 (行 0-15) が明るい縞、下半分が暗い縞。粒は各縞の中に反対の色を 5%
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) setPx(grass, x, y, hex(y < 16 ? '#3e7a33' : '#2e5e2a'));
  const rand = rng(2002);
  const taken = [];
  const count = Math.round(AREA * 0.05);
  const n = TILE;
  let placed = 0;
  for (let tries = 0; placed < count && tries < 200000; tries++) {
    const p = [Math.floor(rand() * n), Math.floor(rand() * n)];
    // 縞の境界の行には置かない (境界がギザギザに見えるのを避ける)
    if (p[1] === 0 || p[1] === 15 || p[1] === 16 || p[1] === 31) continue;
    const ok = taken.every((q) => {
      const dx = Math.min(Math.abs(p[0] - q[0]), n - Math.abs(p[0] - q[0]));
      const dy = Math.min(Math.abs(p[1] - q[1]), n - Math.abs(p[1] - q[1]));
      return dx * dx + dy * dy >= 9;
    });
    if (!ok) continue;
    taken.push(p);
    setPx(grass, p[0], p[1], hex(p[1] < 16 ? '#2e5e2a' : '#3e7a33'));
    placed++;
  }
}

const gravel = makeImage(TILE, TILE, hex('#b8a37a'));
{
  const rand = rng(3003);
  const taken = [];
  // 白い粒は少ないので大きく離す
  scatter(gravel, rand, hex('#ffffff'), Math.round(AREA * 0.02), 5, taken);
  // 暗い粒は 20% と密なため距離の条件では置ききれず、条件付きだと斜めの点線が目立つ。
  // 代わりに「同じ色が縦・横・斜めに 3 つ並ばない」だけを条件にランダムに置く (2 ドットの粒は許す)
  const dark = hex('#8a7550');
  const n = TILE;
  const occupied = new Uint8Array(AREA);
  const isDark = new Uint8Array(AREA);
  for (const [x, y] of taken) occupied[y * n + x] = 1;
  const at = (x, y) => isDark[((y + n) % n) * n + ((x + n) % n)];
  const makesLine = (x, y) =>
    [[1, 0], [0, 1], [1, 1], [1, -1]].some(([dx, dy]) => {
      const run = (s) => (at(x + s * dx, y + s * dy) ? 1 + (at(x + 2 * s * dx, y + 2 * s * dy) ? 1 : 0) : 0);
      return 1 + run(1) + run(-1) >= 3;
    });
  const count = Math.round(AREA * 0.2);
  let placed = 0;
  for (let tries = 0; placed < count && tries < 200000; tries++) {
    const x = Math.floor(rand() * n);
    const y = Math.floor(rand() * n);
    if (occupied[y * n + x] || makesLine(x, y)) continue;
    occupied[y * n + x] = 1;
    isDark[y * n + x] = 1;
    setPx(gravel, x, y, dark);
    placed++;
  }
  if (placed < count) throw new Error(`砂利の粒を ${count} 個置けなかった (${placed})`);
}

for (const [name, tile] of [['tile-asphalt', asphalt], ['tile-grass', grass], ['tile-gravel', gravel]]) {
  assertPalette(tile, name);
  await save(tile, `${IMG_DIR}/${name}.png`);
  // 継ぎ目確認: 3x3 に並べて 4 倍
  const sheet = makeImage(TILE * 3, TILE * 3);
  for (let ty = 0; ty < 3; ty++) for (let tx = 0; tx < 3; tx++) blit(sheet, tile, tx * TILE, ty * TILE);
  await savePreview(sheet, `${PREVIEW_DIR}/${name}.png`, 4);
}

// ---- 3. 5x7 フォント ui-font-5x7.png ----
// ASCII 0x20-0x5F の 64 文字。1 行 16 文字 x 4 行、セル 6x8 (字形はセル左上の 5x7、右 1 列・下 1 行は透明)
// 各文字は 7 行ぶんの 5 ビット値 (bit4 = 左端)
const GLYPHS = {
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  '!': [0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x04],
  '"': [0x0a, 0x0a, 0x0a, 0x00, 0x00, 0x00, 0x00],
  '#': [0x0a, 0x0a, 0x1f, 0x0a, 0x1f, 0x0a, 0x0a],
  $: [0x04, 0x0f, 0x14, 0x0e, 0x05, 0x1e, 0x04],
  '%': [0x18, 0x19, 0x02, 0x04, 0x08, 0x13, 0x03],
  '&': [0x0c, 0x12, 0x14, 0x08, 0x15, 0x12, 0x0d],
  "'": [0x0c, 0x04, 0x08, 0x00, 0x00, 0x00, 0x00],
  '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  '*': [0x00, 0x04, 0x15, 0x0e, 0x15, 0x04, 0x00],
  '+': [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00],
  ',': [0x00, 0x00, 0x00, 0x00, 0x0c, 0x04, 0x08],
  '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  '/': [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x00],
  0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  3: [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ':': [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
  ';': [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x04, 0x08],
  '<': [0x02, 0x04, 0x08, 0x10, 0x08, 0x04, 0x02],
  '=': [0x00, 0x00, 0x1f, 0x00, 0x1f, 0x00, 0x00],
  '>': [0x08, 0x04, 0x02, 0x01, 0x02, 0x04, 0x08],
  '?': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
  '@': [0x0e, 0x11, 0x01, 0x0d, 0x15, 0x15, 0x0e],
  A: [0x0e, 0x11, 0x11, 0x11, 0x1f, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x11, 0x0a, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '[': [0x0e, 0x08, 0x08, 0x08, 0x08, 0x08, 0x0e],
  '\\': [0x00, 0x10, 0x08, 0x04, 0x02, 0x01, 0x00],
  ']': [0x0e, 0x02, 0x02, 0x02, 0x02, 0x02, 0x0e],
  '^': [0x04, 0x0a, 0x11, 0x00, 0x00, 0x00, 0x00],
  _: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f],
};
const FONT = { first: 0x20, count: 64, cols: 16, cellW: 6, cellH: 8, glyphW: 5, glyphH: 7 };
const WHITE = hex('#ffffff');

const font = makeImage(FONT.cols * FONT.cellW, (FONT.count / FONT.cols) * FONT.cellH);
for (let i = 0; i < FONT.count; i++) {
  const ch = String.fromCharCode(FONT.first + i);
  const rows = GLYPHS[ch];
  if (!rows) throw new Error(`字形がない: ${JSON.stringify(ch)}`);
  const ox = (i % FONT.cols) * FONT.cellW;
  const oy = Math.floor(i / FONT.cols) * FONT.cellH;
  rows.forEach((bits, y) => {
    for (let x = 0; x < FONT.glyphW; x++) if (bits & (1 << (FONT.glyphW - 1 - x))) setPx(font, ox + x, oy + y, WHITE);
  });
}
assertPalette(font, 'ui-font-5x7');
await save(font, `${UI_DIR}/ui-font-5x7.png`);

// ---- プレビュー ----
// 車: アスファルトの上に 0/15/30/45/90 度 回転 (最近傍) + ゴースト (1 ドット間引きの市松) を並べて 8 倍
const rotateNearest = (src, deg) => {
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
{
  const variants = [0, 15, 30, 45, 90].map((d) => rotateNearest(car, d));
  const ghost = makeImage(24, 24);
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) if ((x + y) % 2 === 0) setPx(ghost, x, y, getPx(car, x, y));
  variants.push(ghost);
  const sheet = makeImage(24 * variants.length, 24);
  for (let tx = 0; tx < variants.length; tx++) blit(sheet, asphalt, tx * 24, 0);
  variants.forEach((v, i) => blit(sheet, v, i * 24, 0));
  await savePreview(sheet, `${PREVIEW_DIR}/car-base.png`, 8);
}
// フォント: 文字表 (8 倍) と、HUD 風の見本 (2 倍 = 標準の表示サイズ)
{
  await savePreview(
    (() => {
      const bg = makeImage(font.width, font.height, hex('#11111b'));
      blit(bg, font, 0, 0);
      return bg;
    })(),
    `${PREVIEW_DIR}/ui-font-5x7.png`,
    8,
  );
  const lines = ['LAP 12/20  1:23.456', 'BEST 1:22.901 +1.234', '287 KM/H  TYRE 72%', 'PIX LIGHTS OUT', 'BOX BOX  DRS ENABLED'];
  const sample = makeImage(4 + 6 * 22, 4 + 10 * lines.length, hex('#11111b'));
  lines.forEach((line, row) => {
    [...line].forEach((ch, col) => {
      const i = ch.charCodeAt(0) - FONT.first;
      for (let y = 0; y < FONT.glyphH; y++) {
        for (let x = 0; x < FONT.glyphW; x++) {
          const c = getPx(font, (i % FONT.cols) * FONT.cellW + x, Math.floor(i / FONT.cols) * FONT.cellH + y);
          if (c[3]) setPx(sample, 2 + col * 6 + x, 2 + row * 10 + y, hex('#cdd6f4'));
        }
      }
    });
  });
  await savePreview(sample, `${PREVIEW_DIR}/ui-font-5x7-sample.png`, 4);
}
