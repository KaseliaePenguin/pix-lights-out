// タイトル画面の素材 (背景の一枚絵・ロゴ・スタートランプ) と、背景のコースを走る車の経路データを書き出す
//
// 例: node scripts/build-pixel-assets.mjs && node scripts/build-title-assets.mjs
//
// 背景は路面テクスチャ・チームカラーの車 (build-pixel-assets.mjs の出力) を読み込んで、コードで塗る。
// 座標はすべてドット (ワールド層と同じ 1 ドット = 画面 2px)。背景は 400x300 ドット = 画面全体。

import { mkdir, writeFile } from 'node:fs/promises';
import {
  assertPalette, blit, getPx, hex, loadImage, makeImage, rng, rotateNearest, save, savePreview, setPx,
} from './lib/pixel.mjs';

const IMG_DIR = 'public/assets/images';
const UI_DIR = 'public/assets/ui';
const DATA_DIR = 'public/assets/data';
const PREVIEW_DIR = 'assets-src/previews';
await mkdir(DATA_DIR, { recursive: true });
await mkdir(PREVIEW_DIR, { recursive: true });

const C = Object.fromEntries(
  Object.entries({
    ink: '#11111b', base: '#1e1e2e', surface: '#313244', overlay: '#585b70', text: '#cdd6f4', white: '#ffffff',
    asphaltDark: '#2a2a33', asphalt: '#3c3c46', asphaltLight: '#4b4b57', grassDark: '#2e5e2a', grass: '#3e7a33',
    red: '#e8322b', yellow: '#ffd60a',
  }).map(([k, v]) => [k, hex(v)]),
);
const TEAM_COLORS = ['#e8322b', '#ff8c1a', '#ffd60a', '#0e9f6e', '#22d3ee', '#3b82f6', '#f048b8', '#ffffff'].map(hex);
const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

const tiles = {
  asphalt: await loadImage(`${IMG_DIR}/tile-asphalt.png`),
  grass: await loadImage(`${IMG_DIR}/tile-grass.png`),
  gravel: await loadImage(`${IMG_DIR}/tile-gravel.png`),
};
const tileAt = (tile, x, y) => getPx(tile, x % tile.width, y % tile.height);
// ピットレーン路面 (style-guide.md §5 の tile-pit: 基本 #4b4b57 + #3c3c46 の粒)。tile-pit.png は未作成なので
// アスファルトの色を入れ替えて代用する
const pitAt = (x, y) => {
  const c = tileAt(tiles.asphalt, x, y);
  return same(c, C.asphaltLight) ? C.asphalt : C.asphaltLight;
};

// ---- コースの形: 角を丸めた長方形 (中心線) ----
const W = 400;
const H = 300;
const TRACK = { cx: 200, cy: 145, hx: 168, hy: 105, r: 56, half: 15 };
// 中心線からの符号付き距離 (外側が正) と、コーナーの扇形の中かどうか
const trackInfo = (px, py) => {
  const qx = Math.abs(px - TRACK.cx) - (TRACK.hx - TRACK.r);
  const qy = Math.abs(py - TRACK.cy) - (TRACK.hy - TRACK.r);
  const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - TRACK.r;
  return { sd, qx, qy, phi: Math.atan2(qy, qx) };
};

// ピットレーン (下のメインストレートの外側、西から入って東へ抜ける)
const PIT = { laneTop: 269, laneBottom: 282, lineY: 267, x0: 120, x1: 280, garageTop: 283 };
const distToSegment = (px, py, ax, ay, bx, by) => {
  const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
};
const PIT_RAMPS = [
  [96, 258, PIT.x0, (PIT.laneTop + PIT.laneBottom + 1) / 2],
  [PIT.x1, (PIT.laneTop + PIT.laneBottom + 1) / 2, 304, 258],
];
const isPit = (x, y) => {
  const px = x + 0.5;
  const py = y + 0.5;
  if (y < 265) return false;
  if (x >= PIT.x0 && x < PIT.x1 && y >= PIT.laneTop && y <= PIT.laneBottom) return true;
  return PIT_RAMPS.some(([ax, ay, bx, by]) => distToSegment(px, py, ax, ay, bx, by) <= 7) && y <= PIT.laneBottom;
};

// ---- 背景 title-bg.png ----
const bg = makeImage(W, H);
const isBand = (x, y) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return false;
  return y >= 64 && y <= 162 && trackInfo(x + 0.5, y + 0.5).sd <= -24;
};

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const { sd, qx, qy, phi } = trackInfo(x + 0.5, y + 0.5);
    const a = Math.abs(sd);
    let c = tileAt(tiles.grass, x, y);
    const cornerZone = qx > 0 && qy > 0;
    // 1. コーナー外側の砂利とタイヤバリア
    if (qx > -10 && qy > -10 && sd > 15 && sd <= 34) c = tileAt(tiles.gravel, x, y);
    if (qx > -10 && qy > -10 && sd > 34 && sd <= 36) c = Math.floor((phi * 36) / 4) % 2 ? C.white : C.ink;
    // 2. アスファルト、白線
    if (a <= TRACK.half) c = tileAt(tiles.asphalt, x, y);
    if (a > 13 && a <= 15) c = C.white;
    // ピットの入口・出口ではコース端の白線を切る
    if (a > 13 && a <= 15 && sd > 0 && y > 250 && ((x >= 99 && x <= 111) || (x >= 289 && x <= 301))) c = tileAt(tiles.asphalt, x, y);
    // 3. 縁石 (コーナーの内側・外側、幅 4、8 ドットごとに赤白、内側に 1 ドットの輪郭、端も輪郭で閉じる)
    if (cornerZone && a > 9 && a <= 13) c = Math.floor((phi * (TRACK.r + Math.sign(sd) * 11)) / 8) % 2 ? C.white : C.red;
    if (cornerZone && a > 8 && a <= 9) c = C.ink;
    if (((qx > -1 && qx <= 0 && qy > 0) || (qy > -1 && qy <= 0 && qx > 0)) && a > 8 && a <= 13) c = C.ink;
    // 4. ピットレーン
    if (isPit(x, y)) c = pitAt(x, y);
    setPx(bg, x, y, c);
  }
}

// 5. 内側の暗い帯 (ロゴとスタートランプの下地)。コースに沿った形、縁は 2 ドットの surface
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (!isBand(x, y)) continue;
    let edge = false;
    for (let d = 1; d <= 2 && !edge; d++) edge = !isBand(x - d, y) || !isBand(x + d, y) || !isBand(x, y - d) || !isBand(x, y + d);
    setPx(bg, x, y, edge ? C.surface : C.base);
  }
}

// 6. グランドスタンド (上のストレートの外側、観客はチーム色などのランダムな粒)
{
  const rand = rng(4004);
  const x0 = 96;
  const x1 = 303;
  const y0 = 1;
  const y1 = 20;
  // 観客は明るい無彩色を主にし、チーム色は少なめにする (粒が多すぎると画面上部がちらついて見える)
  const crowd = [C.text, C.text, C.overlay, C.white, ...TEAM_COLORS];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let c;
      if (x === x0 || x === x1 || y === y0 || y === y1) c = C.ink;
      else if ((y - y0) % 3 === 0) c = C.overlay; // 段の縁
      else c = rand() < 0.28 ? crowd[Math.floor(rand() * rand() * crowd.length)] : C.surface;
      setPx(bg, x, y, c);
    }
  }
  // 階段 (通路) を 3 本
  for (const ax of [148, 200, 252]) for (let y = y0 + 1; y < y1; y++) for (const dx of [0, 1]) setPx(bg, ax + dx, y, C.overlay);
}

// 7. ピット: ピットとコースの境界線、速度制限区間の線、ガレージ 8 棟 (チーム 1〜8 の順)
{
  for (let x = PIT.x0; x < PIT.x1; x++) for (const y of [PIT.lineY, PIT.lineY + 1]) setPx(bg, x, y, C.white);
  for (const lx of [PIT.x0 + 4, PIT.x1 - 6]) {
    for (let y = PIT.laneTop; y <= PIT.laneBottom; y++) for (const dx of [0, 1]) setPx(bg, lx + dx, y, C.yellow);
  }
  const gx0 = PIT.x0 - 2;
  const gx1 = PIT.x1 + 1;
  for (let y = PIT.garageTop; y < H; y++) {
    for (let x = gx0; x <= gx1; x++) {
      const i = Math.floor((x - PIT.x0) / 20);
      const lx = (x - PIT.x0) % 20;
      let c = C.surface;
      if (x === gx0 || x === gx1 || y === PIT.garageTop || (lx === 0 && x > PIT.x0)) c = C.ink;
      else if (i >= 0 && i < 8 && lx >= 3 && lx <= 17 && y <= PIT.garageTop + 2) c = TEAM_COLORS[i]; // シャッター
      else if (y === PIT.garageTop + 9) c = C.overlay; // 屋根の棟
      setPx(bg, x, y, c);
    }
  }
}

// 8. スタート / フィニッシュライン (市松、幅 4) とスターティンググリッド (4 枠)、発進のタイヤ痕
const START_X = 228;
{
  const top = TRACK.cy + TRACK.hy - 13;
  const bottom = TRACK.cy + TRACK.hy + 12;
  for (let y = top; y <= bottom; y++) {
    for (let x = START_X; x < START_X + 4; x++) setPx(bg, x, y, (Math.floor((x - START_X) / 2) + Math.floor((y - top) / 2)) % 2 ? C.ink : C.white);
  }
  const lanes = [242, 257]; // 枠の中心 (中心線 250 の ±7.5 を整数に)
  [222, 197, 172, 147].forEach((front, i) => {
    const cy = lanes[i % 2];
    for (let y = cy - 7; y <= cy + 6; y++) for (const x of [front - 1, front]) setPx(bg, x, y, C.white);
    for (let x = front - 8; x <= front; x++) for (const y of [cy - 7, cy - 6, cy + 5, cy + 6]) setPx(bg, x, y, C.white);
    // 後輪の位置から後ろへ伸びるタイヤ痕 (2 ドット幅の点列)
    for (let x = front - 30; x <= front - 18; x++) {
      if (x % 3 === 0) continue;
      for (const y of [cy - 5, cy - 4, cy + 3, cy + 4]) setPx(bg, x, y, C.asphaltDark);
    }
  });
}

// 9. 木 (内側の芝生、PRESS ENTER の周りは空ける)
for (const [tx, ty] of [[76, 186], [98, 212], [124, 190], [276, 190], [302, 212], [324, 186]]) {
  for (let y = -7; y <= 7; y++) {
    for (let x = -7; x <= 7; x++) {
      const d = Math.hypot(x, y);
      if (d > 6.5) continue;
      const hl = Math.hypot(x + 2, y + 2) <= 3;
      setPx(bg, tx + x, ty + y, d > 5.5 ? C.ink : hl ? C.grass : C.grassDark);
    }
  }
}

assertPalette(bg, 'title-bg');
await save(bg, `${IMG_DIR}/title-bg.png`);

// ---- 経路データ title-paths.json ----
// 中心線を 2 ドットごとに標本化し、同じ番号の点どうしが並ぶように 3 本のレーン (内・中・外) を作る。
// 進行方向は画面で反時計回り (下のストレートを東へ、スタートラインから開始)
const STEP = 2;
const segs = (() => {
  const { cx, cy, hx, hy, r } = TRACK;
  const sx = hx - r;
  const sy = hy - r;
  const line = (ax, ay, bx, by, n) => ({ len: Math.hypot(bx - ax, by - ay), at: (t) => [ax + (bx - ax) * t, ay + (by - ay) * t, ...n], arc: false });
  const arc = (ox, oy, a0, a1) => ({
    len: Math.abs(a1 - a0) * r,
    at: (t) => { const a = a0 + (a1 - a0) * t; return [ox + r * Math.cos(a), oy + r * Math.sin(a), Math.cos(a), Math.sin(a)]; },
    arc: true,
  });
  const P = Math.PI;
  return [
    line(START_X + 2, cy + hy, cx + sx, cy + hy, [0, 1]),
    arc(cx + sx, cy + sy, P / 2, 0),
    line(cx + hx, cy + sy, cx + hx, cy - sy, [1, 0]),
    arc(cx + sx, cy - sy, 0, -P / 2),
    line(cx + sx, cy - hy, cx - sx, cy - hy, [0, -1]),
    arc(cx - sx, cy - sy, -P / 2, -P),
    line(cx - hx, cy - sy, cx - hx, cy + sy, [-1, 0]),
    arc(cx - sx, cy + sy, P, P / 2),
    line(cx - sx, cy + hy, START_X + 2, cy + hy, [0, 1]),
  ];
})();
const total = segs.reduce((s, g) => s + g.len, 0);
const N = Math.round(total / STEP);
const samples = [];
for (let i = 0; i < N; i++) {
  let s = (i / N) * total;
  let g = 0;
  while (s > segs[g].len) s -= segs[g++].len;
  const [x, y, nx, ny] = segs[g].at(s / segs[g].len);
  samples.push({ x, y, nx, ny, arc: segs[g].arc });
}
// 速度の目安: ストレート 1.0、コーナー 0.7。コーナー手前 30 ドットで減速、出口 24 ドットで加速
const CORNER = 0.7;
const speedFactor = samples.map((p, i) => {
  if (p.arc) return CORNER;
  let ahead = 0;
  while (!samples[(i + ahead) % N].arc) ahead++;
  let behind = 0;
  while (!samples[(i - behind + N) % N].arc) behind++;
  return Math.min(1, CORNER + ((1 - CORNER) * ahead * STEP) / 30, CORNER + ((1 - CORNER) * behind * STEP) / 24);
});
const round1 = (v) => Math.round(v * 10) / 10;
const LANES = { inner: -7, center: 0, outer: 7 };
const lanes = Object.fromEntries(
  Object.entries(LANES).map(([name, d]) => [name, samples.map((p) => [round1(p.x + p.nx * d), round1(p.y + p.ny * d)])]),
);
// 向き: 0 = 北、時計回りが正 (car-physics.md 2.1 節)。中心線の隣の点から求める (3 レーン共通)
const heading = samples.map((p, i) => {
  const q = samples[(i + 1) % N];
  const o = samples[(i - 1 + N) % N];
  return Math.round((Math.atan2(q.y - o.y, q.x - o.x) + Math.PI / 2) * 1000) / 1000;
});
const nearestIndex = (x, y) => samples.reduce((best, p, i) => (Math.hypot(p.x - x, p.y - y) < Math.hypot(samples[best].x - x, samples[best].y - y) ? i : best), 0);

// ピットに寄る経路 (任意): outer レーンから分かれ、ピットレーンを速度制限で通って outer レーンに戻る
const pitLaneY = (PIT.laneTop + PIT.laneBottom + 1) / 2;
const pitPoints = [];
{
  const way = [[86, TRACK.cy + TRACK.hy + 7], ...PIT_RAMPS.flat().reduce((acc, v, i, arr) => (i % 2 ? acc : [...acc, [v, arr[i + 1]]]), []), [314, TRACK.cy + TRACK.hy + 7]];
  // way: 分岐点 → 入口ランプ → レーン → 出口ランプ → 合流点
  for (let k = 0; k < way.length - 1; k++) {
    const [ax, ay] = way[k];
    const [bx, by] = way[k + 1];
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / STEP));
    for (let j = 0; j < n; j++) pitPoints.push([round1(ax + ((bx - ax) * j) / n), round1(ay + ((by - ay) * j) / n)]);
  }
  pitPoints.push(way[way.length - 1]);
}

const cars = TEAM_COLORS.map((_, i) => ({
  team: i + 1,
  sprite: `/assets/images/car-team-${String(i + 1).padStart(2, '0')}.png`,
  ghostSprite: `/assets/images/car-team-${String(i + 1).padStart(2, '0')}-ghost.png`,
  lane: ['inner', 'outer', 'center'][i % 3],
  startIndex: Math.round(((8 - i) * N) / 8 + (i % 2 ? 6 : 0)) % N,
  speed: [128, 124, 131, 120, 126, 122, 133, 118][i],
}));

const data = {
  description: 'タイトル画面の背景 (title-bg.png) のコースを走る車の経路。座標は背景画像のドット (画面 px = ドット x 2)。',
  image: '/assets/images/title-bg.png',
  size: [W, H],
  units: { position: 'dot', speed: 'dot/s (画面 px/s は 2 倍)', heading: 'rad, 0 = 北, 時計回りが正 (ctx.rotate にそのまま渡す)' },
  loop: true,
  direction: 'counterclockwise-on-screen (下のストレートを東へ)',
  step: STEP,
  count: N,
  lapLength: Math.round(total),
  laneOffsets: LANES,
  lanes,
  heading,
  speedFactor: speedFactor.map((v) => Math.round(v * 100) / 100),
  startFinish: { index: 0, x: START_X + 2 },
  pit: {
    optional: true,
    from: { lane: 'outer', index: nearestIndex(86, 257) },
    to: { lane: 'outer', index: nearestIndex(314, 257) },
    speed: 55,
    points: pitPoints,
  },
  cars,
};
await writeFile(`${DATA_DIR}/title-paths.json`, JSON.stringify(data));
console.log(`${DATA_DIR}/title-paths.json (${N} points, lap ${Math.round(total)} dots)`);

// ---- スタートランプ ui-lamp-on / ui-lamp-off (12x12、直径 12 の円) ----
const lamp = (color) => {
  const img = makeImage(12, 12);
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) if (Math.hypot(x + 0.5 - 6, y + 0.5 - 6) <= 6) setPx(img, x, y, color);
  return img;
};
const lampOn = lamp(C.red);
const lampOff = lamp(C.surface);
await save(lampOn, `${UI_DIR}/ui-lamp-on.png`);
await save(lampOff, `${UI_DIR}/ui-lamp-off.png`);

// ---- ロゴ title-logo.png ----
// 5x7 フォントの字形を 3 倍 (1 字の点 = 3x3 ドット) にし、右へ 1 ドット太らせて ink の輪郭で囲む。
// 「PIX」は赤、「LIGHTS OUT」は白。下に縁石模様 (赤白 8 ドット、高さ 4) を敷く
const font = await loadImage(`${UI_DIR}/ui-font-5x7.png`);
const TEXT = 'PIX LIGHTS OUT';
const S = 3;
const ADV = 18;
const PAD = 2;
const textW = TEXT.length * ADV - (ADV - 5 * S - 1);
const logo = makeImage(textW + PAD * 2, 7 * S + PAD * 2 + 3 + 4 + 2);
const fill = makeImage(logo.width, logo.height);
[...TEXT].forEach((ch, k) => {
  const i = ch.charCodeAt(0) - 0x20;
  const color = k < 3 ? C.red : C.white;
  for (let gy = 0; gy < 7; gy++) {
    for (let gx = 0; gx < 5; gx++) {
      if (!getPx(font, (i % 16) * 6 + gx, Math.floor(i / 16) * 8 + gy)[3]) continue;
      for (let y = 0; y < S; y++) for (let x = 0; x <= S; x++) setPx(fill, PAD + k * ADV + gx * S + x, PAD + gy * S + y, color);
    }
  }
});
const kerbTop = PAD + 7 * S + 3;
for (let y = kerbTop; y < kerbTop + 4; y++) for (let x = PAD; x < PAD + textW; x++) setPx(fill, x, y, Math.floor((x - PAD) / 8) % 2 ? C.white : C.red);
for (let y = 0; y < logo.height; y++) {
  for (let x = 0; x < logo.width; x++) {
    const c = getPx(fill, x, y);
    if (c[3]) { setPx(logo, x, y, c); continue; }
    const near = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]].some(([dx, dy]) => {
      const nx = x + dx;
      const ny = y + dy;
      return nx >= 0 && ny >= 0 && nx < logo.width && ny < logo.height && getPx(fill, nx, ny)[3];
    });
    if (near) setPx(logo, x, y, C.ink);
  }
}
assertPalette(logo, 'title-logo');
await save(logo, `${IMG_DIR}/title-logo.png`);

// ---- プレビュー: 背景 + 車 8 台 (経路上に配置) + ロゴ + ランプ + PRESS ENTER を画面と同じ 800x600 相当で ----
{
  const shot = makeImage(W, H);
  blit(shot, bg, 0, 0);
  const carImgs = await Promise.all(cars.map((c) => loadImage(`public${c.sprite}`)));
  cars.forEach((c, i) => {
    // プレビューでは抜きつ抜かれつの場面を作るため、2 台ずつ近づけて置く
    const idx = [0, 6, 120, 126, 250, 258, 370, 377][i] % N;
    const [x, y] = lanes[['inner', 'outer'][i % 2]][idx];
    const rot = rotateNearest(carImgs[i], (heading[idx] * 180) / Math.PI);
    blit(shot, rot, Math.round(x) - 12, Math.round(y) - 12);
  });
  // ランプ: style-guide.md §6 の寸法 (ユニット 20x32 ドット、間隔 6) を上中央に。ここでは 4 灯点灯
  const unitsW = 5 * 20 + 4 * 6;
  const ux0 = Math.round((W - unitsW) / 2);
  for (let u = 0; u < 5; u++) {
    const ox = ux0 + u * 26;
    const oy = 74;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 20; x++) setPx(shot, ox + x, oy + y, x === 0 || y === 0 || x === 19 || y === 31 ? C.surface : C.ink);
    blit(shot, u < 4 ? lampOn : lampOff, ox + 4, oy + 3);
    blit(shot, u < 4 ? lampOn : lampOff, ox + 4, oy + 17);
  }
  blit(shot, logo, Math.round((W - logo.width) / 2), 118);
  // PRESS ENTER (フォント 1 倍 = 画面 2 倍) を ink の板の上に
  const msg = 'PRESS ENTER';
  const mw = msg.length * 6 - 1;
  const mx = Math.round((W - mw) / 2);
  const my = 209;
  for (let y = my - 3; y < my + 10; y++) for (let x = mx - 4; x < mx + mw + 4; x++) setPx(shot, x, y, C.ink);
  [...msg].forEach((ch, k) => {
    const i = ch.charCodeAt(0) - 0x20;
    for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) if (getPx(font, (i % 16) * 6 + gx, Math.floor(i / 16) * 8 + gy)[3]) setPx(shot, mx + k * 6 + gx, my + gy, C.text);
  });
  await savePreview(shot, `${PREVIEW_DIR}/title-composite.png`, 2);
  await savePreview(bg, `${PREVIEW_DIR}/title-bg.png`, 2);
  // 経路の確認: 3 レーンと pit を点で描く
  const paths = makeImage(W, H);
  blit(paths, bg, 0, 0);
  const put = (x, y, c) => { const ix = Math.round(x); const iy = Math.round(y); if (ix >= 0 && iy >= 0 && ix < W && iy < H) setPx(paths, ix, iy, c); };
  lanes.inner.forEach(([x, y], i) => i % 2 || put(x, y, C.yellow));
  lanes.center.forEach(([x, y], i) => i % 2 || put(x, y, C.white));
  lanes.outer.forEach(([x, y], i) => i % 2 || put(x, y, TEAM_COLORS[4]));
  pitPoints.forEach(([x, y]) => put(x, y, TEAM_COLORS[6]));
  await savePreview(paths, `${PREVIEW_DIR}/title-paths.png`, 2);
}
