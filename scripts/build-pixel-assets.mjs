// ドット単位で作るアセット (基準車・路面テクスチャ・5x7 フォント) を書き出す
//
// 例: node scripts/build-pixel-assets.mjs
//
// 生成 AI では 10x20 の車・継ぎ目なしテクスチャ・フォントが作れないため (style-guide.md §2・§5・§7)、
// 設計図と固定 seed の乱数から直接ピクセルを打つ。確認用の拡大プレビューは assets-src/previews/ に出す。

import { mkdir } from 'node:fs/promises';
import { CLEAR, assertPalette, blit, getPx, hex, makeImage, rng, rotateNearest, save, savePreview, setPx } from './lib/pixel.mjs';

const IMG_DIR = 'public/assets/images';
const UI_DIR = 'public/assets/ui';
const PREVIEW_DIR = 'assets-src/previews';

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
const CAR_COLORS = { K: hex('#11111b'), T: hex('#11111b'), P: hex('#e8322b'), H: hex('#cdd6f4'), '.': CLEAR };

const car = makeImage(24, 24);
const CAR_X = 7; // 24x24 の中心 (12, 12) が車体の中心 (列 4-5 の間、行 9-10 の間) に来る位置
const CAR_Y = 2;
CAR_BLUEPRINT.forEach((row, y) => [...row].forEach((ch, x) => setPx(car, CAR_X + x, CAR_Y + y, CAR_COLORS[ch])));
assertPalette(car, 'car-base');
await save(car, `${IMG_DIR}/car-base.png`);

// ゴースト用のシャドウ表示 (style-guide.md §2): 透明 (または画像の外) に上下左右で接するドットをチーム色、
// それ以外の不透明なドットを ink にする。car-base のチーム色は赤
const makeShadow = (src, teamColor) => {
  const out = makeImage(src.width, src.height);
  const opaque = (x, y) => x >= 0 && y >= 0 && x < src.width && y < src.height && getPx(src, x, y)[3] > 0;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (!opaque(x, y)) continue;
      const edge = !opaque(x - 1, y) || !opaque(x + 1, y) || !opaque(x, y - 1) || !opaque(x, y + 1);
      setPx(out, x, y, edge ? teamColor : hex('#11111b'));
    }
  }
  return out;
};
const carGhost = makeShadow(car, hex('#e8322b'));
assertPalette(carGhost, 'car-base-ghost');
await save(carGhost, `${IMG_DIR}/car-base-ghost.png`);

// チームカラーの車 car-team-01〜08 とゴースト版 (style-guide.md §3)。
// 基準車の赤いドットを、模様の範囲ならアクセント色、それ以外はチーム色に置き換える (範囲は設計図の列・行)
const TEAMS = [
  { color: '#e8322b', accent: '#ffffff', pattern: (c, r) => c >= 4 && c <= 5 && r <= 17 }, // センターストライプ
  { color: '#ff8c1a', accent: '#11111b', pattern: (c, r) => r <= 6 }, // ノーズ
  { color: '#ffd60a', accent: '#11111b', pattern: (c, r) => (c === 3 || c === 6) && r >= 6 && r <= 16 }, // ツインストライプ
  { color: '#0e9f6e', accent: '#ffffff', pattern: (c, r) => r <= 6 }, // ノーズ
  { color: '#22d3ee', accent: null, pattern: () => false }, // 無地
  { color: '#3b82f6', accent: '#ffffff', pattern: (c, r) => r >= 13 && r <= 18 }, // リア
  { color: '#f048b8', accent: '#11111b', pattern: (c, r) => r >= 10 && r <= 12 }, // 横帯
  { color: '#ffffff', accent: '#11111b', pattern: (c, r) => c >= 4 && c <= 5 && r <= 17 }, // センターストライプ
];
const teamCars = [];
const teamGhosts = [];
for (const [i, team] of TEAMS.entries()) {
  const img = makeImage(24, 24);
  const base = hex('#e8322b');
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) {
      const c = getPx(car, x, y);
      const isBody = c[3] > 0 && c[0] === base[0] && c[1] === base[1] && c[2] === base[2];
      if (!isBody) setPx(img, x, y, c);
      else setPx(img, x, y, hex(team.pattern(x - CAR_X, y - CAR_Y) ? team.accent : team.color));
    }
  }
  const ghost = makeShadow(img, hex(team.color));
  const num = String(i + 1).padStart(2, '0');
  assertPalette(img, `car-team-${num}`);
  assertPalette(ghost, `car-team-${num}-ghost`);
  await save(img, `${IMG_DIR}/car-team-${num}.png`);
  await save(ghost, `${IMG_DIR}/car-team-${num}-ghost.png`);
  teamCars.push(img);
  teamGhosts.push(ghost);
}

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

// ピットレーン: コースより明るい基本色に、アスファルト色の粒 8% (style-guide.md §5)
const pit = makeImage(TILE, TILE, hex('#4b4b57'));
scatter(pit, rng(5005), hex('#3c3c46'), Math.round(AREA * 0.08), 2, []);

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

for (const [name, tile] of [['tile-asphalt', asphalt], ['tile-pit', pit], ['tile-grass', grass], ['tile-gravel', gravel]]) {
  assertPalette(tile, name);
  await save(tile, `${IMG_DIR}/${name}.png`);
  // 継ぎ目確認: 3x3 に並べて 4 倍
  const sheet = makeImage(TILE * 3, TILE * 3);
  for (let ty = 0; ty < 3; ty++) for (let tx = 0; tx < 3; tx++) blit(sheet, tile, tx * TILE, ty * TILE);
  await savePreview(sheet, `${PREVIEW_DIR}/${name}.png`, 4);
}

// ---- 3. 5x7 フォント ui-font-5x7.png ----
// ASCII 0x20-0x5F の 64 文字 + 追加記号 (0x60 = ▲、0x61 = ▼)。1 行 16 文字 x 5 行 (5 行目は先頭 2 セルのみ)、セル 6x8 (字形はセル左上の 5x7、右 1 列・下 1 行は透明)
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
  '`': [0x00, 0x04, 0x0e, 0x0e, 0x1f, 0x1f, 0x00], // ▲ (style-guide.md §6)
  'a': [0x00, 0x1f, 0x1f, 0x0e, 0x0e, 0x04, 0x00], // ▼
};
const FONT = { first: 0x20, count: 66, rows: 5, cols: 16, cellW: 6, cellH: 8, glyphW: 5, glyphH: 7 };
const WHITE = hex('#ffffff');

const font = makeImage(FONT.cols * FONT.cellW, FONT.rows * FONT.cellH);
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
{
  const variants = [0, 15, 30, 45, 90].map((d) => rotateNearest(car, d));
  variants.push(...[0, 15, 30, 45, 90].map((d) => rotateNearest(carGhost, d)));
  const sheet = makeImage(24 * variants.length, 24);
  for (let tx = 0; tx < variants.length; tx++) blit(sheet, asphalt, tx * 24, 0);
  variants.forEach((v, i) => blit(sheet, v, i * 24, 0));
  await savePreview(sheet, `${PREVIEW_DIR}/car-base.png`, 8);
}
// 通常の車とゴーストを並べて、アスファルト・芝生 (明暗の縞の両方)・砂利の上に置く
{
  const surfaces = [asphalt, grass, gravel];
  const sheet = makeImage(64, 32 * surfaces.length);
  surfaces.forEach((tile, row) => {
    blit(sheet, tile, 0, row * 32);
    blit(sheet, tile, 32, row * 32);
    blit(sheet, car, 4, row * 32 + 4);
    blit(sheet, carGhost, 36, row * 32 + 4);
  });
  await savePreview(sheet, `${PREVIEW_DIR}/car-base-ghost.png`, 8);
}
// ピットレーンとコースの見分け: 左にアスファルト、右にピット (各 3x3 タイル)、境目に白線 2 ドット
{
  const sheet = makeImage(TILE * 6 + 2, TILE * 3);
  for (let ty = 0; ty < 3; ty++) {
    for (let tx = 0; tx < 3; tx++) {
      blit(sheet, asphalt, tx * TILE, ty * TILE);
      blit(sheet, pit, TILE * 3 + 2 + tx * TILE, ty * TILE);
    }
  }
  for (let y = 0; y < sheet.height; y++) for (const x of [TILE * 3, TILE * 3 + 1]) setPx(sheet, x, y, hex('#ffffff'));
  await savePreview(sheet, `${PREVIEW_DIR}/tile-pit-vs-asphalt.png`, 4);
}
// 8 チーム: 上段が通常、下段がゴースト。左からアスファルト・芝生・砂利の 3 セットを並べる
{
  const surfaces = [asphalt, grass, gravel];
  const W = 24 * 8;
  const sheet = makeImage(W * surfaces.length + 8 * (surfaces.length - 1), 48, hex('#1e1e2e'));
  surfaces.forEach((tile, si) => {
    const ox = si * (W + 8);
    for (let ty = 0; ty < 48; ty += 32) for (let tx = 0; tx < W; tx += 32) blit(sheet, tile, ox + tx, ty);
    // 32 の倍数でない端は blit が切るので、はみ出した分を base で塗り直す
    for (let y = 0; y < 48; y++) for (let x = W; x < W + 8 && ox + x < sheet.width; x++) setPx(sheet, ox + x, y, hex('#1e1e2e'));
    teamCars.forEach((img, i) => blit(sheet, img, ox + i * 24, 0));
    teamGhosts.forEach((img, i) => blit(sheet, img, ox + i * 24, 24));
  });
  await savePreview(sheet, `${PREVIEW_DIR}/car-teams.png`, 4);
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
  const lines = ['LAP 12/20  1:23.456', 'BEST 1:22.901 +1.234', '287 KM/H  TYRE 72%', 'PIX LIGHTS OUT', 'BOX BOX  DRS ENABLED', '▲ -0.842  ▼ +1.203'];
  const sample = makeImage(4 + 6 * 22, 4 + 10 * lines.length, hex('#11111b'));
  lines.forEach((line, row) => {
    [...line].forEach((ch, col) => {
      const i = ({ '▲': 0x60, '▼': 0x61 }[ch] ?? ch.charCodeAt(0)) - FONT.first;
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
