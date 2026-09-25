// 生成した元音声をゲーム用の OGG に変換する (ffmpeg を使用)
//
// 例: node scripts/process-sound.mjs --type bgm --in assets-src/generated/sound/race-theme-123.flac --out public/assets/sounds/bgm/race-theme.ogg
//     node scripts/process-sound.mjs --type se  --in assets-src/generated/sound/tire-screech-456.flac --out public/assets/sounds/se/tire-screech.ogg
//
// 処理: 切り出し → (SE) 先頭の無音除去・モノラル化 → (ループ時) 末尾と先頭をクロスフェードしてつなぎ目を消す
//       → 音量を目標ラウドネスに合わせる (ピークは -1 dBFS 以下) → (非ループ時) 末尾フェードアウト → OGG Vorbis
// 確認用: 波形画像 (ループ時はつなぎ目前後の波形も) を assets-src/previews/sound/ に出力し、ラウドネスとピークを表示する

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    type: { type: 'string' },
    in: { type: 'string' },
    out: { type: 'string' },
    start: { type: 'string', default: '0' },
    end: { type: 'string' },
    loop: { type: 'boolean' },
    'no-loop': { type: 'boolean' },
    crossfade: { type: 'string', default: '2' },
    lufs: { type: 'string' },
    mono: { type: 'boolean' },
    'preview-dir': { type: 'string', default: 'assets-src/previews/sound' },
  },
});

if (!['bgm', 'se'].includes(args.type) || !args.in || !args.out) {
  console.error('Usage: node scripts/process-sound.mjs --type bgm|se --in <generated.flac> --out <public/assets/sounds/...ogg> [--start S] [--end S] [--loop|--no-loop] [--lufs N]');
  process.exit(1);
}

const isBgm = args.type === 'bgm';
const loop = args.loop ?? (isBgm && !args['no-loop']);
const targetLufs = Number(args.lufs ?? (isBgm ? -18 : -16));
const mono = args.mono ?? !isBgm;
const crossfade = Number(args.crossfade);
const PEAK_LIMIT = -1;

const FFMPEG = process.env.FFMPEG_PATH ?? findFfmpeg();

function findFfmpeg() {
  // winget でインストールした直後は起動中のプロセスに PATH が反映されないため、インストール先を直接探す
  const packages = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages');
  if (existsSync(packages)) {
    for (const pkg of readdirSync(packages).filter((d) => d.startsWith('Gyan.FFmpeg'))) {
      for (const build of readdirSync(join(packages, pkg))) {
        const exe = join(packages, pkg, build, 'bin', 'ffmpeg.exe');
        if (existsSync(exe)) return exe;
      }
    }
  }
  return 'ffmpeg';
}

function ffmpeg(ffArgs) {
  const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...ffArgs], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`ffmpeg を実行できません (${FFMPEG}): ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffmpeg failed:\n${result.stderr.slice(-2000)}`);
  return result.stderr;
}

/** 長さ (秒)・統合ラウドネス (LUFS)・トゥルーピーク (dBFS) を測る */
function measure(file) {
  const log = ffmpeg(['-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const times = [...log.matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
  const [, h, m, s] = times.at(-1);
  const summary = log.slice(log.lastIndexOf('Summary:'));
  return {
    duration: Number(h) * 3600 + Number(m) * 60 + Number(s),
    lufs: Number(summary.match(/I:\s+(-?[\d.]+|-inf) LUFS/)?.[1] ?? -Infinity),
    peak: Number(summary.match(/Peak:\s+(-?[\d.]+|-inf) dBFS/)?.[1] ?? -Infinity),
  };
}

const work = await mkdtemp(join(tmpdir(), 'process-sound-'));
try {
  // 1. 切り出し・無音除去・チャンネル数と周波数の統一
  const step1 = join(work, 'step1.wav');
  const filters1 = [`atrim=start=${args.start}${args.end ? `:end=${args.end}` : ''}`, 'asetpts=PTS-STARTPTS'];
  if (!isBgm) filters1.push('silenceremove=start_periods=1:start_threshold=-50dB');
  ffmpeg(['-i', args.in, '-af', filters1.join(','), '-ar', '44100', '-ac', mono ? '1' : '2', step1]);

  // 2. ループ化: 末尾 X 秒を先頭 X 秒へクロスフェードし、[本体][末尾→先頭] の順に並べる
  //    再生が末尾まで来ると先頭 X 秒の続き (本体の頭) に戻るため、つなぎ目が出ない
  let current = step1;
  if (loop) {
    const { duration } = measure(step1);
    if (duration <= crossfade * 3) throw new Error(`ループ化するには音声が短すぎます (${duration.toFixed(2)} 秒)`);
    const step2 = join(work, 'step2.wav');
    const x = crossfade;
    ffmpeg([
      '-i', step1,
      '-filter_complex',
      `[0:a]asplit=3[a][b][c];` +
        `[a]atrim=0:${x},asetpts=PTS-STARTPTS[head];` +
        `[b]atrim=${x}:${duration - x},asetpts=PTS-STARTPTS[body];` +
        `[c]atrim=${duration - x},asetpts=PTS-STARTPTS[tail];` +
        `[tail][head]acrossfade=d=${x}:c1=tri:c2=tri[joint];` +
        `[body][joint]concat=n=2:v=0:a=1[out]`,
      '-map', '[out]', step2,
    ]);
    current = step2;
  }

  // 3. 音量: 一定のゲインだけをかける (ループのつなぎ目で音量が変わらないよう、動的な処理は使わない)
  const before = measure(current);
  const gain = Math.min(
    Number.isFinite(before.lufs) ? targetLufs - before.lufs : Infinity,
    PEAK_LIMIT - before.peak,
  );
  const filters3 = [`volume=${gain.toFixed(2)}dB`];
  if (!loop) {
    const fade = Math.min(0.05, before.duration / 4);
    filters3.push(`afade=t=out:st=${(before.duration - fade).toFixed(3)}:d=${fade.toFixed(3)}`);
  }

  await mkdir(dirname(args.out), { recursive: true });
  ffmpeg(['-i', current, '-af', filters3.join(','), '-c:a', 'libvorbis', '-q:a', '5', args.out]);

  // 4. 確認用の波形画像と測定結果
  const after = measure(args.out);
  await mkdir(args['preview-dir'], { recursive: true });
  const name = basename(args.out, extname(args.out));
  const wavePath = join(args['preview-dir'], `${name}.png`);
  ffmpeg(['-i', args.out, '-filter_complex', 'showwavespic=s=1200x240:scale=sqrt:colors=#89b4fa', '-frames:v', '1', wavePath]);

  console.log(args.out);
  console.log(`preview: ${wavePath}`);
  if (loop) {
    // 末尾 1 秒 + 先頭 1 秒をつないだ波形。中央 (つなぎ目) に段差や途切れがなければ OK
    const seamPath = join(args['preview-dir'], `${name}-seam.png`);
    ffmpeg([
      '-sseof', '-1', '-i', args.out, '-t', '1', '-i', args.out,
      '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1,showwavespic=s=1200x240:scale=sqrt:colors=#a6e3a1',
      '-frames:v', '1', seamPath,
    ]);
    console.log(`seam preview: ${seamPath}`);
  }
  console.log(
    `duration ${after.duration.toFixed(2)}s, loudness ${after.lufs} LUFS (target ${targetLufs}), true peak ${after.peak} dBFS, ` +
      `${mono ? 'mono' : 'stereo'}, ${loop ? 'loop' : 'one-shot'}`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
