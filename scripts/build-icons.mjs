// ホーム画面に追加したとき・タブのアイコン (public/icons/) を書き出す。
// 路面タイルの上に車 (チーム 1) を置いたドット絵を、整数倍に拡大する (滲ませない)
//
// 例: node scripts/build-icons.mjs

import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';

const OUT_DIR = 'public/icons';
await mkdir(OUT_DIR, { recursive: true });

const IMG = 'public/assets/images';

/** dots × dots のドット絵を作り、scale 倍にして書き出す */
async function writeIcon(file, dots, scale) {
  const tile = await sharp(`${IMG}/tile-asphalt.png`).png().toBuffer();
  const car = await sharp(`${IMG}/car-team-01.png`).png().toBuffer();
  const carMeta = await sharp(car).metadata();
  const small = await sharp({ create: { width: dots, height: dots, channels: 4, background: '#1e1e2e' } })
    .composite([
      { input: tile, tile: true, top: 0, left: 0 },
      { input: car, top: Math.floor((dots - carMeta.height) / 2), left: Math.floor((dots - carMeta.width) / 2) },
    ])
    .png()
    .toBuffer();
  await sharp(small).resize(dots * scale, dots * scale, { kernel: 'nearest' }).png().toFile(`${OUT_DIR}/${file}`);
  console.log(`${OUT_DIR}/${file}`, dots * scale);
}

await writeIcon('icon-192.png', 32, 6);
await writeIcon('icon-512.png', 32, 16);
await writeIcon('apple-touch-icon.png', 36, 5);
