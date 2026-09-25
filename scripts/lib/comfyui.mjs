// ComfyUI の HTTP API を呼び出す共通処理 (画像・音声の生成スクリプトで使う)

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const COMFYUI_URL = process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188';

async function comfy(path, init) {
  const res = await fetch(`${COMFYUI_URL}${path}`, init).catch((e) => {
    throw new Error(`ComfyUI (${COMFYUI_URL}) に接続できません。起動しているか確認してください: ${e.message}`);
  });
  if (!res.ok) throw new Error(`ComfyUI ${path} -> ${res.status}: ${await res.text()}`);
  return res;
}

export function randomSeed() {
  return Math.floor(Math.random() * 2 ** 32);
}

/**
 * ワークフローを実行し、outputNode の出力ファイルを outDir に保存してパスの一覧を返す
 * outputKey は出力の種類 ('images' / 'audio')
 */
export async function runWorkflow({ workflow, outputNode, outputKey, outDir, baseName, timeoutMs = 20 * 60 * 1000 }) {
  // ComfyUI のバージョン違いでノードが無い場合に、分かりやすいエラーにする
  const available = await (await comfy('/object_info')).json();
  const missing = [...new Set(Object.values(workflow).map((node) => node.class_type))].filter((t) => !available[t]);
  if (missing.length) throw new Error(`ComfyUI に次のノードがありません (ComfyUI の更新が必要かもしれません): ${missing.join(', ')}`);

  const queued = await (
    await comfy('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow }),
    })
  ).json();
  const promptId = queued.prompt_id;
  console.error(`queued ${promptId}`);

  let files;
  const deadline = Date.now() + timeoutMs;
  while (!files) {
    if (Date.now() > deadline) throw new Error(`生成がタイムアウトしました (${timeoutMs / 60000} 分)`);
    await new Promise((r) => setTimeout(r, 1000));
    const history = await (await comfy(`/history/${promptId}`)).json();
    const entry = history[promptId];
    if (entry?.status?.status_str === 'error') {
      throw new Error(`生成に失敗しました: ${JSON.stringify(entry.status.messages)}`);
    }
    if (entry?.outputs?.[outputNode]) files = entry.outputs[outputNode][outputKey];
  }

  await mkdir(outDir, { recursive: true });
  const saved = [];
  for (const [i, file] of files.entries()) {
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
    const data = Buffer.from(await (await comfy(`/view?${query}`)).arrayBuffer());
    const ext = file.filename.slice(file.filename.lastIndexOf('.'));
    const suffix = files.length > 1 ? `-${i + 1}` : '';
    const outPath = join(outDir, `${baseName}${suffix}${ext}`);
    await writeFile(outPath, data);
    saved.push(outPath);
  }
  return saved;
}
