// ComfyUI の API で SDXL + pixel-art-xl LoRA を使ってピクセルアートの元画像を生成する
//
// 例: node scripts/generate-image.mjs --name player-idle --prompt "a knight character, front view"
//
// 出力: assets-src/generated/<name>-<seed>.png (1024px 前後の元画像。ゲームには process-sprite.mjs で変換して使う)

import { parseArgs } from 'node:util';
import { randomSeed, runWorkflow } from './lib/comfyui.mjs';

const { values: args } = parseArgs({
  options: {
    name: { type: 'string' },
    prompt: { type: 'string' },
    negative: { type: 'string', default: '' },
    seed: { type: 'string' },
    batch: { type: 'string', default: '1' },
    width: { type: 'string', default: '1024' },
    height: { type: 'string', default: '1024' },
    steps: { type: 'string', default: '30' },
    cfg: { type: 'string', default: '6' },
    'lora-strength': { type: 'string', default: '1.2' },
    'out-dir': { type: 'string', default: 'assets-src/generated' },
  },
});

if (!args.name || !args.prompt) {
  console.error('Usage: node scripts/generate-image.mjs --name <asset-name> --prompt "<description>" [--seed N] [--batch N]');
  process.exit(1);
}

const CHECKPOINT = process.env.COMFYUI_CHECKPOINT ?? 'sd_xl_base_1.0.safetensors';
const LORA = process.env.COMFYUI_LORA ?? 'pixel-art-xl.safetensors';

// スタイルを揃えるための共通プロンプト。背景除去しやすいよう単色背景を指定する
const STYLE_PROMPT = 'pixel art, game sprite, clean outline, flat colors, limited palette, centered, full body, plain white background';
const STYLE_NEGATIVE = 'blurry, gradient, noise, jpeg artifacts, photo, realistic, 3d render, text, watermark, signature, multiple characters, cropped, shadow on background';

const seed = args.seed !== undefined ? Number(args.seed) : randomSeed();

const workflow = {
  checkpoint: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CHECKPOINT } },
  lora: {
    class_type: 'LoraLoader',
    inputs: {
      lora_name: LORA,
      strength_model: Number(args['lora-strength']),
      strength_clip: 1,
      model: ['checkpoint', 0],
      clip: ['checkpoint', 1],
    },
  },
  positive: { class_type: 'CLIPTextEncode', inputs: { text: `${STYLE_PROMPT}, ${args.prompt}`, clip: ['lora', 1] } },
  negative: {
    class_type: 'CLIPTextEncode',
    inputs: { text: [STYLE_NEGATIVE, args.negative].filter(Boolean).join(', '), clip: ['lora', 1] },
  },
  latent: {
    class_type: 'EmptyLatentImage',
    inputs: { width: Number(args.width), height: Number(args.height), batch_size: Number(args.batch) },
  },
  sampler: {
    class_type: 'KSampler',
    inputs: {
      seed,
      steps: Number(args.steps),
      cfg: Number(args.cfg),
      sampler_name: 'dpmpp_2m',
      scheduler: 'karras',
      denoise: 1,
      model: ['lora', 0],
      positive: ['positive', 0],
      negative: ['negative', 0],
      latent_image: ['latent', 0],
    },
  },
  decode: { class_type: 'VAEDecode', inputs: { samples: ['sampler', 0], vae: ['checkpoint', 2] } },
  save: { class_type: 'SaveImage', inputs: { filename_prefix: `test-game/${args.name}`, images: ['decode', 0] } },
};

console.error(`seed ${seed}`);
const saved = await runWorkflow({
  workflow,
  outputNode: 'save',
  outputKey: 'images',
  outDir: args['out-dir'],
  baseName: `${args.name}-${seed}`,
});
for (const path of saved) console.log(path);
