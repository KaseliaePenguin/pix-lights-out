// 宣伝用の一枚絵 (真上視点) を書き出す。ゲームと同じパレット・スプライトでドットを打ち、整数倍に拡大して promo/ に置く
//
// 例: node scripts/build-promo.mjs
//
// 前提: build-pixel-assets.mjs と build-title-assets.mjs の出力 (車・路面・フォント・ロゴ) が public/assets/ にあること

import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';
import { assertPalette, blit, getPx, hex, loadImage, makeImage, rng, rotateSmooth, setPx } from './lib/pixel.mjs';

const OUT_DIR = 'promo';
await mkdir(OUT_DIR, { recursive: true });

const C = Object.fromEntries(
  Object.entries({
    ink: '#11111b', base: '#1e1e2e', surface: '#313244', overlay: '#585b70', grey: '#7f849c', subtext: '#a6adc8',
    text: '#cdd6f4', white: '#ffffff', asphaltDark: '#2a2a33', asphalt: '#3c3c46', asphaltLight: '#4b4b57',
    grassDark: '#2e5e2a', grass: '#3e7a33', red: '#e8322b', orange: '#ff8c1a', yellow: '#ffd60a',
    hudGreen: '#39d353', purple: '#a855f7',
  }).map(([k, v]) => [k, hex(v)]),
);
const TEAM = ['#e8322b', '#ff8c1a', '#ffd60a', '#0e9f6e', '#22d3ee', '#3b82f6', '#f048b8', '#ffffff'].map(hex);
const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

const IMG = 'public/assets/images';
const tiles = {
  asphalt: await loadImage(`${IMG}/tile-asphalt.png`),
  grass: await loadImage(`${IMG}/tile-grass.png`),
  gravel: await loadImage(`${IMG}/tile-gravel.png`),
};
const cars = [];
const ghosts = [];
for (let i = 1; i <= 8; i++) {
  const n = String(i).padStart(2, '0');
  cars.push(await loadImage(`${IMG}/car-team-${n}.png`));
  ghosts.push(await loadImage(`${IMG}/car-team-${n}-ghost.png`));
}
const logo = await loadImage(`${IMG}/title-logo.png`);
const font = await loadImage('public/assets/ui/ui-font-5x7.png');
const lampOn = await loadImage('public/assets/ui/ui-lamp-on.png');
const lampOff = await loadImage('public/assets/ui/ui-lamp-off.png');

const tileAt = (t, x, y) => getPx(t, ((x % t.width) + t.width) % t.width, ((y % t.height) + t.height) % t.height);
const pitAt = (x, y) => (same(tileAt(tiles.asphalt, x, y), C.asphaltLight) ? C.asphalt : C.asphaltLight);
const inside = (img, x, y) => x >= 0 && y >= 0 && x < img.width && y < img.height;
const put = (img, x, y, c) => inside(img, x, y) && setPx(img, x, y, c);
const rect = (img, x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(img, x, y, c); };

const fillGrass = (img) => { for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) setPx(img, x, y, tileAt(tiles.grass, x, y)); };

// ---- コース: 中心線 (直線と円弧) からの符号付き距離で塗る ----
const line = (ax, ay, bx, by) => ({ kind: 'line', ax, ay, bx, by });
const arc = (cx, cy, r, a0, a1) => ({ kind: 'arc', cx, cy, r, a0, a1 }); // 角度は度、y 下向き
const sampleTrack = (segs, step = 0.5) => {
  const out = [];
  let s = 0;
  for (const g of segs) {
    const len = g.kind === 'line' ? Math.hypot(g.bx - g.ax, g.by - g.ay) : (Math.abs(g.a1 - g.a0) * Math.PI * g.r) / 180;
    const n = Math.max(1, Math.ceil(len / step));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      let x; let y; let tx; let ty;
      if (g.kind === 'line') {
        x = g.ax + (g.bx - g.ax) * t; y = g.ay + (g.by - g.ay) * t;
        tx = (g.bx - g.ax) / len; ty = (g.by - g.ay) / len;
      } else {
        const a = ((g.a0 + (g.a1 - g.a0) * t) * Math.PI) / 180;
        const dir = Math.sign(g.a1 - g.a0);
        x = g.cx + g.r * Math.cos(a); y = g.cy + g.r * Math.sin(a);
        tx = -Math.sin(a) * dir; ty = Math.cos(a) * dir;
      }
      out.push({ x, y, tx, ty, s: s + t * len, arc: g.kind === 'arc' ? g : null });
    }
    s += len;
  }
  return out;
};
// 各ドットの最寄りの中心線の点と、符号付き距離 (進行方向の右が正)
const trackField = (img, samples) => {
  const field = new Array(img.width * img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const px = x + 0.5; const py = y + 0.5;
      let best = null; let bd = Infinity;
      for (const p of samples) {
        const d = (p.x - px) ** 2 + (p.y - py) ** 2;
        if (d < bd) { bd = d; best = p; }
      }
      const sd = best.tx * (py - best.y) - best.ty * (px - best.x);
      field[y * img.width + x] = { p: best, sd, dist: Math.sqrt(bd) };
    }
  }
  return field;
};
const HALF = 15;
const paintTrack = (img, field, { kerbs = true } = {}) => {
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const { p, sd } = field[y * img.width + x];
      const a = Math.abs(sd);
      if (a > HALF) continue;
      let c = tileAt(tiles.asphalt, x, y);
      if (a > 13) c = C.white;
      if (kerbs && p.arc) {
        if (a > 9 && a <= 13) c = Math.floor(p.s / 8) % 2 ? C.white : C.red;
        if (a > 8 && a <= 9) c = C.ink;
      }
      setPx(img, x, y, c);
    }
  }
};

// ---- 車・エフェクト ----
const drawCar = (img, team, x, y, headingDeg, ghost = false) => {
  const spr = rotateSmooth((ghost ? ghosts : cars)[team - 1], headingDeg);
  blit(img, spr, Math.round(x) - 12, Math.round(y) - 12);
};
// 車の中心と向きから、車体に固定した座標 (右 u, 前 v) を画面座標にする
const local = (x, y, headingDeg, u, v) => {
  const a = (headingDeg * Math.PI) / 180;
  const f = [Math.sin(a), -Math.cos(a)];
  const r = [Math.cos(a), Math.sin(a)];
  return [x + r[0] * u + f[0] * v, y + r[1] * u + f[1] * v];
};
// タイヤ痕: 後輪 2 本の位置から後ろへ伸びる 2 ドット幅の点列 (直線区間用)
const skid = (img, x, y, headingDeg, from, to) => {
  for (let v = from; v <= to; v += 0.5) {
    if (Math.floor(v) % 3 === 0) continue;
    for (const u of [-4.5, -3.5, 3.5, 4.5]) {
      const [px, py] = local(x, y, headingDeg, u, -v);
      put(img, Math.floor(px), Math.floor(py), C.asphaltDark);
    }
  }
};
// 点列の道筋に沿ったタイヤ痕 (コーナー用)
const skidPath = (img, pts) => { pts.forEach(([x, y], i) => { if (i % 3 !== 0) { put(img, Math.floor(x), Math.floor(y), C.asphaltDark); put(img, Math.floor(x) + 1, Math.floor(y), C.asphaltDark); } }); };
// タイヤスモーク: 後輪から後ろへ、正方形の粒が色の段階で薄くなる (§8)
const smoke = (img, x, y, headingDeg, seed, amount = 1) => {
  const rand = rng(seed);
  for (let k = 0; k < 14 * amount; k++) {
    const back = 8 + rand() * 18 * amount;
    const side = (rand() < 0.5 ? -1 : 1) * (3 + rand() * (4 + back * 0.35));
    const size = back < 14 ? 4 : back < 20 ? 3 : 2;
    const c = back < 13 ? C.text : back < 19 ? C.subtext : C.grey;
    const [px, py] = local(x, y, headingDeg, side, -back);
    rect(img, Math.round(px - size / 2), Math.round(py - size / 2), Math.round(px - size / 2) + size - 1, Math.round(py - size / 2) + size - 1, c);
  }
};
// 火花: 車の後ろに 2x1 の粒 (白 → 黄 → 橙)
const sparks = (img, x, y, headingDeg, seed) => {
  const rand = rng(seed);
  for (let k = 0; k < 16; k++) {
    const back = 10 + rand() * 16;
    const side = (rand() - 0.5) * (2 + back * 0.5);
    const c = back < 15 ? C.white : back < 21 ? C.yellow : C.orange;
    const [px, py] = local(x, y, headingDeg, side, -back);
    const horiz = Math.abs(Math.sin((headingDeg * Math.PI) / 180)) > 0.7;
    rect(img, Math.round(px), Math.round(py), Math.round(px) + (horiz ? 1 : 0), Math.round(py) + (horiz ? 0 : 1), c);
  }
};

// ---- 背景の部品 ----
const crowd = (img, x0, y0, x1, y1, seed) => {
  const rand = rng(seed);
  const cols = [C.text, C.text, C.overlay, C.white, ...TEAM];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let c;
      if (x === x0 || x === x1 || y === y0 || y === y1) c = C.ink;
      else if ((y - y0) % 3 === 0) c = C.overlay;
      else c = rand() < 0.28 ? cols[Math.floor(rand() * rand() * cols.length)] : C.surface;
      put(img, x, y, c);
    }
  }
};
const barrier = (img, x0, x1, y) => { for (let x = x0; x <= x1; x++) for (const yy of [y, y + 1]) put(img, x, yy, Math.floor(x / 4) % 2 ? C.white : C.ink); };
const tree = (img, tx, ty, r = 6) => {
  for (let y = -r - 1; y <= r + 1; y++) {
    for (let x = -r - 1; x <= r + 1; x++) {
      const d = Math.hypot(x, y);
      if (d > r + 0.5) continue;
      put(img, tx + x, ty + y, d > r - 0.5 ? C.ink : Math.hypot(x + r / 3, y + r / 3) <= r / 2 ? C.grass : C.grassDark);
    }
  }
};
const garages = (img, x0, y0, count, w, depth) => {
  rect(img, x0 - 1, y0, x0 + count * w, y0 + depth, C.ink);
  for (let i = 0; i < count; i++) {
    const gx = x0 + i * w + 1;
    rect(img, gx, y0 + 1, gx + w - 2, y0 + depth - 1, C.surface);
    rect(img, gx + 2, y0 + 1, gx + w - 4, y0 + 2, TEAM[i % 8]);
    rect(img, gx, y0 + Math.floor(depth / 2), gx + w - 2, y0 + Math.floor(depth / 2), C.overlay);
  }
};
const motorhome = (img, x0, y0, w, h, team) => {
  rect(img, x0, y0, x0 + w - 1, y0 + h - 1, C.ink);
  rect(img, x0 + 1, y0 + 1, x0 + w - 2, y0 + h - 2, TEAM[team - 1]);
  rect(img, x0 + 3, y0 + 3, x0 + w - 4, y0 + 4, C.overlay);
  rect(img, x0 + 3, y0 + h - 5, x0 + w - 4, y0 + h - 4, C.overlay);
};
const text = (img, str, x, y, color) => {
  [...str].forEach((ch, k) => {
    const code = ({ '▲': 0x60, '▼': 0x61 }[ch] ?? ch.charCodeAt(0)) - 0x20;
    for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) if (getPx(font, (code % 16) * 6 + gx, Math.floor(code / 16) * 8 + gy)[3]) put(img, x + k * 6 + gx, y + gy, color);
  });
};
const panel = (img, x0, y0, x1, y1) => { rect(img, x0, y0, x1, y1, C.surface); rect(img, x0 + 1, y0 + 1, x1 - 1, y1 - 1, C.ink); };
// スタートランプ (style-guide.md §6 のユニット 20x32 ドット、ランプ 2 個)
const lamps = (img, cx, y0, onCount) => {
  const x0 = cx - Math.floor((5 * 20 + 4 * 6) / 2);
  rect(img, x0 - 4, y0 + 6, x0 + 5 * 26 - 3, y0 + 9, C.ink); // ユニットをつなぐ梁
  for (let u = 0; u < 5; u++) {
    const ox = x0 + u * 26;
    rect(img, ox, y0, ox + 19, y0 + 31, C.surface);
    rect(img, ox + 1, y0 + 1, ox + 18, y0 + 30, C.ink);
    blit(img, u < onCount ? lampOn : lampOff, ox + 4, y0 + 3);
    blit(img, u < onCount ? lampOn : lampOff, ox + 4, y0 + 17);
  }
};
const band = (img, y0, y1) => { rect(img, 0, y0, img.width - 1, y1, C.base); rect(img, 0, y0, img.width - 1, y0 + 1, C.surface); rect(img, 0, y1 - 1, img.width - 1, y1, C.surface); };
const rotateCCW = (src) => {
  const out = makeImage(src.height, src.width);
  for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) setPx(out, y, src.width - 1 - x, getPx(src, x, y));
  return out;
};

const exportPng = async (img, name, scale) => {
  assertPalette(img, name);
  const path = `${OUT_DIR}/${name}.png`;
  await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
    .removeAlpha()
    .resize(img.width * scale, img.height * scale, { kernel: 'nearest' })
    .png({ palette: true, colors: 32, dither: 0 })
    .toFile(path);
  console.log(`${path} (${img.width * scale}x${img.height * scale}, ${img.width}x${img.height} ドット x${scale})`);
};

// ================================================================
// 1. スタート: グリッドから 8 台が一斉に飛び出す (東向き)。縦長・正方形は回転して作る
// ================================================================
// W = 進行方向の長さ、H = 横幅。trackY = コース中心線、startX = スタートライン
const launchScene = ({ W, H, trackY, startX, seed, advance = 6 }) => {
  const img = makeImage(W, H);
  fillGrass(img);
  // グランドスタンド (コースの左側 = 上)
  const standBottom = trackY - HALF - 9;
  crowd(img, -1, Math.max(-1, standBottom - 28), W, standBottom, seed);
  barrier(img, 0, W - 1, standBottom + 3);
  // コース
  const field = trackField(img, sampleTrack([line(-30, trackY, W + 30, trackY)], 2));
  paintTrack(img, field, { kerbs: false });
  // スタートライン (市松 4 ドット) とグリッド 8 枠
  for (let y = trackY - 13; y < trackY + 13; y++) for (let x = startX; x < startX + 4; x++) put(img, x, y, (Math.floor((x - startX) / 2) + Math.floor((y - trackY + 13) / 2)) % 2 ? C.ink : C.white);
  const slots = [];
  for (let k = 0; k < 8; k++) {
    const front = startX - 6 - k * 25;
    const cy = trackY + (k % 2 ? 7 : -8);
    for (let y = cy - 7; y <= cy + 6; y++) for (const x of [front - 1, front]) put(img, x, y, C.white);
    for (let x = front - 8; x <= front; x++) for (const y of [cy - 7, cy - 6, cy + 5, cy + 6]) put(img, x, y, C.white);
    slots.push([front, cy]);
  }
  // ピットウォール・ピットレーン・ガレージ・パドック (コースの右側 = 下)
  const wallY = trackY + HALF + 7;
  rect(img, 0, wallY, W - 1, wallY + 1, C.white);
  for (let y = wallY + 2; y <= wallY + 15; y++) for (let x = 0; x < W; x++) put(img, x, y, pitAt(x, y));
  garages(img, 4, wallY + 16, Math.ceil(W / 24), 24, 22);
  const paddockY = wallY + 46;
  for (let i = 0; i * 40 + 6 < W; i++) motorhome(img, 6 + i * 40, paddockY, 30, 14, (i % 8) + 1);
  for (let i = 0; i * 37 + 12 < W; i++) tree(img, 12 + i * 37 + (i % 2) * 9, paddockY + 30 + (i % 3) * 7);
  // 発進: 各車は枠から advance ドット前へ。後ろにタイヤ痕とスモーク
  slots.forEach(([front, cy], k) => {
    const x = front - 10 + advance + (k % 3);
    skid(img, x, cy, 90, 9, 22 + advance);
  });
  slots.forEach(([front, cy], k) => {
    const x = front - 10 + advance + (k % 3);
    smoke(img, x, cy, 90, seed + k, 0.8);
  });
  slots.forEach(([front, cy], k) => drawCar(img, k + 1, front - 10 + advance + (k % 3), cy, 90));
  return img;
};

{
  // キービジュアル 1920x1080 (320x180 ドット x6)
  const base = launchScene({ W: 320, H: 180, trackY: 50, startX: 268, seed: 11 });
  const noLogo = makeImage(base.width, base.height);
  blit(noLogo, base, 0, 0);
  // ランプ全消灯 (= lights out) をスタンドの上に
  lamps(noLogo, 160, 2, 0);
  await exportPng(noLogo, 'key-visual-nologo', 6);
  const withLogo = makeImage(base.width, base.height);
  blit(withLogo, noLogo, 0, 0);
  band(withLogo, 124, 170);
  blit(withLogo, logo, Math.round((320 - logo.width) / 2), 131);
  await exportPng(withLogo, 'key-visual', 6);
}
{
  // SNS 縦長 1080x1920 (270x480 ドット x4): 北向きにスタート。上にランプとロゴ
  const land = launchScene({ W: 480, H: 270, trackY: 128, startX: 330, seed: 21, advance: 7 });
  const img = rotateCCW(land);
  band(img, 0, 118);
  lamps(img, 135, 14, 0);
  blit(img, logo, Math.round((270 - logo.width) / 2), 62);
  text(img, 'LIGHTS OUT AND AWAY WE GO', Math.round((270 - 25 * 6 + 1) / 2), 104, C.subtext);
  await exportPng(img, 'sns-portrait', 4);
}
{
  // SNS 正方形 1080x1080 (270x270 ドット x4)
  const land = launchScene({ W: 270, H: 270, trackY: 110, startX: 150, seed: 31, advance: 5 });
  const img = rotateCCW(land);
  band(img, 0, 96);
  lamps(img, 135, 8, 0);
  blit(img, logo, Math.round((270 - logo.width) / 2), 50);
  await exportPng(img, 'sns-square', 4);
}

// ================================================================
// 2. バトル: 左コーナーで 2 台が並び、後ろから 2 台が迫る (240x135 ドット x8 = 1920x1080)
// ================================================================
{
  const W = 240; const H = 135;
  const img = makeImage(W, H);
  fillGrass(img);
  const cx = 78; const cy = 26; const R = 80;
  const samples = sampleTrack([line(-40, cy + R, cx, cy + R), arc(cx, cy, R, 90, 0), line(cx + R, cy, cx + R, -40)]);
  const field = trackField(img, samples);
  // コーナー外側 (右下) に砂利、タイヤバリア、弧に沿ったグランドスタンド
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const ang = Math.atan2(y + 0.5 - cy, x + 0.5 - cx);
      if (ang < -0.2 || ang > Math.PI / 2 + 0.2) continue;
      if (r > R + HALF && r <= R + 42) setPx(img, x, y, tileAt(tiles.gravel, x, y));
      else if (r > R + 42 && r <= R + 44) setPx(img, x, y, Math.floor((ang * r) / 4) % 2 ? C.white : C.ink);
      else if (r > R + 52 && r <= R + 80) setPx(img, x, y, (Math.floor(r) - R - 52) % 3 === 0 ? C.overlay : C.surface);
    }
  }
  {
    // 観客 (スタンドの段の上に粒)
    const rand = rng(41);
    const cols = [C.text, C.text, C.overlay, C.white, ...TEAM];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const ang = Math.atan2(y + 0.5 - cy, x + 0.5 - cx);
        if (ang < -0.2 || ang > Math.PI / 2 + 0.2 || r <= R + 52 || r > R + 80) continue;
        if (r <= R + 53 || r > R + 79) { setPx(img, x, y, C.ink); continue; }
        if ((Math.floor(r) - R - 52) % 3 !== 0 && rand() < 0.28) setPx(img, x, y, cols[Math.floor(rand() * rand() * cols.length)]);
      }
    }
  }
  paintTrack(img, field);
  // 内側 (左上) の木
  for (const [tx, ty] of [[20, 20], [38, 50], [14, 64], [60, 8]]) tree(img, tx, ty);
  // 各車の位置: コーナーの角度 a (度) と中心線からのずれ d
  const pos = (a, d) => {
    const rad = (a * Math.PI) / 180;
    // 角度が減る向きに走るので、進行方向 = (sin a, -cos a)。向き (0 = 北、時計回り) = a
    return { x: cx + (R + d) * Math.cos(rad), y: cy + (R + d) * Math.sin(rad), h: a };
  };
  // タイヤ痕 (コーナーの内側寄りのライン)
  // 先頭 2 台より前 (a < 40) にだけ、内側寄りのラインのタイヤ痕を残す (車と重なると形が読めなくなるため)
  for (const d of [-9, -1]) {
    const pts = [];
    for (let a = 36; a >= 4; a -= 0.5) { const p = pos(a, d - 2 + (36 - a) * 0.25); pts.push([p.x, p.y]); }
    skidPath(img, pts);
  }
  const battle = [
    // 縁石 (赤白) に乗る 2 台は、縁石と混ざらない青と黄にする
    { team: 6, ...pos(45, -5) }, // 内側
    { team: 3, ...pos(44, 7) }, // 外側から並ぶ
    { team: 1, ...pos(68, 0) },
    { team: 7, ...pos(86, 4) },
  ];
  sparks(img, battle[0].x, battle[0].y, battle[0].h, 51);
  battle.forEach((c) => drawCar(img, c.team, c.x, c.y, c.h));
  // 追ってくる 5 台目 (ストレート)
  drawCar(img, 2, 22, cy + R - 5, 90);
  // 右上に区間表示風の小さな HUD (DRS)
  panel(img, W - 64, 4, W - 5, 26);
  text(img, 'DRS', W - 59, 8, C.hudGreen);
  text(img, 'GAP 0.08', W - 59, 17, C.text);
  await exportPng(img, 'battle-corner', 8);
}

// ================================================================
// 3. ゴーストとのタイムアタック (240x135 ドット x8)
// ================================================================
{
  const W = 240; const H = 135;
  const img = makeImage(W, H);
  fillGrass(img);
  const cy = 76;
  // 奥 (上) にスタンド
  crowd(img, -1, -1, W, 30, 61);
  barrier(img, 0, W - 1, 34);
  // ストレートの先で右へ曲がる
  const samples = sampleTrack([line(-40, cy, 150, cy), arc(150, cy + 70, 70, -90, 0), line(220, cy + 70, 220, H + 40)]);
  const field = trackField(img, samples);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const r = Math.hypot(x + 0.5 - 150, y + 0.5 - (cy + 70));
      if (x > 150 && y < cy + 70 && r > 70 + HALF && r < 70 + 36 && y > 36) setPx(img, x, y, tileAt(tiles.gravel, x, y));
    }
  }
  paintTrack(img, field);
  // コントロールライン (市松) を 2 台の少し先に
  for (let y = cy - 13; y < cy + 13; y++) for (let x = 128; x < 132; x++) put(img, x, y, (Math.floor((x - 128) / 2) + Math.floor((y - cy + 13) / 2)) % 2 ? C.ink : C.white);
  for (const [tx, ty] of [[20, 110], [52, 122], [96, 112], [140, 126]]) tree(img, tx, ty);
  // 自車 (チーム 5) と、自己ベストのゴースト (同じチーム色のシャドウ表示) が並ぶ
  drawCar(img, 5, 94, cy - 7, 90, true);
  drawCar(img, 5, 100, cy + 7, 90);
  // HUD (ゲームと同じ配色): 左上にラップ、右上にゴーストとの差
  panel(img, 4, 40, 86, 62);
  text(img, 'LAP', 9, 44, C.subtext);
  text(img, '1:22.874', 33, 44, C.white);
  text(img, 'BEST', 9, 53, C.subtext);
  text(img, '1:22.901', 39, 53, C.purple);
  panel(img, W - 88, 40, W - 5, 53);
  text(img, 'GHOST', W - 83, 44, C.text);
  text(img, '-0.027', W - 45, 44, C.hudGreen);
  await exportPng(img, 'ghost-time-attack', 8);
}

// ================================================================
// 4. ピットとガレージ (240x135 ドット x8): ピットストップ中の 1 台と、ピットレーンを走る車
// ================================================================
{
  const W = 240; const H = 135;
  const img = makeImage(W, H);
  fillGrass(img);
  // 上: メインストレートの一部
  const field = trackField(img, sampleTrack([line(-30, 14, W + 30, 14)], 2));
  paintTrack(img, field, { kerbs: false });
  rect(img, 0, 31, W - 1, 32, C.white); // ピットウォール
  for (let y = 33; y <= 70; y++) for (let x = 0; x < W; x++) put(img, x, y, pitAt(x, y));
  // 作業エリアの枠 (チーム色、線幅 2) と速度制限線
  for (let i = 0; i < 6; i++) {
    const bx = 8 + i * 38;
    rect(img, bx, 52, bx + 1, 70, TEAM[i]);
    rect(img, bx + 28, 52, bx + 29, 70, TEAM[i]);
    rect(img, bx, 52, bx + 29, 53, TEAM[i]);
  }
  garages(img, 8, 71, 6, 38, 34);
  // 観客のいないパドック
  for (let i = 0; i < 6; i++) motorhome(img, 10 + i * 38, 112, 30, 14, i + 1);
  // ピットストップ中の車 (チーム 4) と、その後ろを抜けていく車 (チーム 8)
  drawCar(img, 4, 8 + 3 * 38 + 15, 62, 90);
  drawCar(img, 8, 62, 42, 90);
  drawCar(img, 2, 170, 20, 90);
  drawCar(img, 6, 140, 8, 90);
  // メカニック: 車の周りに 2x2 の頭 (text) + 胴 (チーム色) を 4 人
  for (const [mx, my] of [[-6, -9], [6, -9], [-6, 9], [6, 9]]) {
    const x = 8 + 3 * 38 + 15 + mx; const y = 62 + my;
    rect(img, x - 1, y - 1, x + 2, y + 2, C.ink);
    rect(img, x, y, x + 1, y + 1, TEAM[3]);
  }
  panel(img, W - 76, H - 22, W - 5, H - 5);
  text(img, 'BOX BOX', W - 69, H - 17, C.yellow);
  await exportPng(img, 'pit-stop', 8);
}
