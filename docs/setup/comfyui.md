# ComfyUI (Stable Diffusion) セットアップ

ピクセルアートのアセット生成に、ローカルの ComfyUI + SDXL + pixel-art-xl LoRA を使う。

## 環境

| 項目 | 内容 |
| --- | --- |
| インストール先 | `C:\Users\yutak\ComfyUI` (プロジェクト外) |
| GPU | RTX 3060 Ti (VRAM 8GB) |
| Python | 3.11 (ComfyUI 直下の `venv`) |
| PyTorch | CUDA 12.8 版 |
| チェックポイント | `models/checkpoints/sd_xl_base_1.0.safetensors` (Stability AI, CreativeML Open RAIL++-M) |
| LoRA | `models/loras/pixel-art-xl.safetensors` (nerijs/pixel-art-xl) |

モデルのライセンスはゲーム公開前に配布元で再確認すること。

## 起動

```bash
cd C:\Users\yutak\ComfyUI
venv\Scripts\python.exe main.py
```

`http://127.0.0.1:8188` で待ち受ける。ブラウザで開けば GUI でも操作できる。
別の URL・モデルを使う場合は環境変数 `COMFYUI_URL`、`COMFYUI_CHECKPOINT`、`COMFYUI_LORA` で上書きする。

## 再インストール手順

```bash
cd C:\Users\yutak
git clone https://github.com/comfyanonymous/ComfyUI.git
cd ComfyUI
python -m venv venv
venv\Scripts\python.exe -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128
venv\Scripts\python.exe -m pip install -r requirements.txt
curl -L -o models/checkpoints/sd_xl_base_1.0.safetensors https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors
curl -L -o models/loras/pixel-art-xl.safetensors https://huggingface.co/nerijs/pixel-art-xl/resolve/main/pixel-art-xl.safetensors
```

## アセット生成の流れ

```bash
# 1. 元画像を生成 (1024px、assets-src/generated/ に保存。--batch 4 で候補を複数出せる)
npm run gen:image -- --name player-idle --prompt "a small knight with a blue cape, front view" --batch 4

# 2. 良い候補をゲーム用スプライトに変換 (32x32、背景除去・減色)
npm run gen:sprite -- --in assets-src/generated/player-idle-12345-2.png --out public/assets/images/player-idle.png --size 32 --palette docs/art/palette.json

# 3. assets-src/previews/player-idle.png (8 倍拡大) で見た目を確認する
```

### 調整のコツ

- 背景が残る / キャラが欠ける: `--tolerance` を上げる / 下げる (既定 48)
- 絵のドットが粗すぎる / 細かすぎる: `--pixel-size` を変える (既定 8。LoRA は約 8px 単位で描く)
- 同じ絵を再現したい: `--seed` を固定する
- 生成が遅い / VRAM 不足: `--width 768 --height 768` に下げる
