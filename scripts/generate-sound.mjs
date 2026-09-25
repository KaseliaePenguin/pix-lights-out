// ComfyUI の API で BGM / 効果音 (SE) の元音声を生成する
//
// BGM: ACE-Step v1 3.5B (Apache-2.0)          例: node scripts/generate-sound.mjs --type bgm --name race-theme --prompt "chiptune, fast tempo, driving" --seconds 60
// SE : Stable Audio Open 1.0 (要ライセンス同意) 例: node scripts/generate-sound.mjs --type se --name tire-screech --prompt "car tire screeching on asphalt" --seconds 2
//
// 出力: assets-src/generated/sound/<name>-<seed>.flac (ゲームには process-sound.mjs で変換して使う)

import { parseArgs } from 'node:util';
import { randomSeed, runWorkflow } from './lib/comfyui.mjs';

const { values: args } = parseArgs({
  options: {
    type: { type: 'string' },
    name: { type: 'string' },
    prompt: { type: 'string' },
    negative: { type: 'string', default: '' },
    seconds: { type: 'string' },
    seed: { type: 'string' },
    batch: { type: 'string', default: '1' },
    steps: { type: 'string' },
    cfg: { type: 'string' },
    'out-dir': { type: 'string', default: 'assets-src/generated/sound' },
  },
});

if (!['bgm', 'se'].includes(args.type) || !args.name || !args.prompt) {
  console.error('Usage: node scripts/generate-sound.mjs --type bgm|se --name <asset-name> --prompt "<tags / description>" [--seconds N] [--batch N] [--seed N]');
  process.exit(1);
}

const seed = args.seed !== undefined ? Number(args.seed) : randomSeed();
const batch = Number(args.batch);
const prefix = `test-game/${args.type}/${args.name}`;

// BGM: ACE-Step はタグ (ジャンル・楽器・テンポなど) と歌詞で曲を作る。ゲーム BGM なので歌なし ([inst]) に固定する
function bgmWorkflow() {
  return {
    checkpoint: {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: process.env.COMFYUI_BGM_CHECKPOINT ?? 'ace_step_v1_3.5b.safetensors' },
    },
    text: {
      class_type: 'TextEncodeAceStepAudio',
      inputs: {
        tags: `instrumental, video game music, ${args.prompt}`,
        lyrics: '[inst]',
        lyrics_strength: 0.99,
        clip: ['checkpoint', 1],
      },
    },
    negative: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['text', 0] } },
    latent: {
      class_type: 'EmptyAceStepLatentAudio',
      inputs: { seconds: Number(args.seconds ?? 60), batch_size: batch },
    },
    sampling: { class_type: 'ModelSamplingSD3', inputs: { model: ['checkpoint', 0], shift: 5 } },
    tonemap: { class_type: 'LatentOperationTonemapReinhard', inputs: { multiplier: 1 } },
    cfgOperation: {
      class_type: 'LatentApplyOperationCFG',
      inputs: { model: ['sampling', 0], operation: ['tonemap', 0] },
    },
    sampler: {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: Number(args.steps ?? 50),
        cfg: Number(args.cfg ?? 5),
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1,
        model: ['cfgOperation', 0],
        positive: ['text', 0],
        negative: ['negative', 0],
        latent_image: ['latent', 0],
      },
    },
    decode: { class_type: 'VAEDecodeAudio', inputs: { samples: ['sampler', 0], vae: ['checkpoint', 2] } },
    save: { class_type: 'SaveAudio', inputs: { audio: ['decode', 0], filename_prefix: prefix } },
  };
}

// SE: Stable Audio Open は自然文の説明から効果音を作る。音楽や声が混ざらないようネガティブで抑える
function seWorkflow() {
  const negative = ['music, melody, speech, voice, low quality, distorted, noise hiss', args.negative]
    .filter(Boolean)
    .join(', ');
  return {
    checkpoint: {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: process.env.COMFYUI_SE_CHECKPOINT ?? 'stable-audio-open-1.0.safetensors' },
    },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: 't5_base.safetensors', type: 'stable_audio' } },
    positive: {
      class_type: 'CLIPTextEncode',
      inputs: { text: `sound effect, isolated, clean recording, ${args.prompt}`, clip: ['clip', 0] },
    },
    negative: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['clip', 0] } },
    latent: { class_type: 'EmptyLatentAudio', inputs: { seconds: Number(args.seconds ?? 3), batch_size: batch } },
    sampler: {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: Number(args.steps ?? 50),
        cfg: Number(args.cfg ?? 6),
        sampler_name: 'dpmpp_3m_sde_gpu',
        scheduler: 'exponential',
        denoise: 1,
        model: ['checkpoint', 0],
        positive: ['positive', 0],
        negative: ['negative', 0],
        latent_image: ['latent', 0],
      },
    },
    decode: { class_type: 'VAEDecodeAudio', inputs: { samples: ['sampler', 0], vae: ['checkpoint', 2] } },
    save: { class_type: 'SaveAudio', inputs: { audio: ['decode', 0], filename_prefix: prefix } },
  };
}

console.error(`seed ${seed}`);
const saved = await runWorkflow({
  workflow: args.type === 'bgm' ? bgmWorkflow() : seWorkflow(),
  outputNode: 'save',
  outputKey: 'audio',
  outDir: args['out-dir'],
  baseName: `${args.name}-${seed}`,
});
for (const path of saved) console.log(path);
