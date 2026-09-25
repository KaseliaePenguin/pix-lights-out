# ComfyUI (ローカル AI 生成) セットアップ

画像 (ピクセルアート) とサウンド (BGM・SE) の生成に、ローカルの ComfyUI を使う。

## 環境

| 項目 | 内容 |
| --- | --- |
| インストール先 | `C:\Users\yutak\ComfyUI` (プロジェクト外) |
| GPU | RTX 3060 Ti (VRAM 8GB) |
| Python | 3.11 (ComfyUI 直下の `venv`) |
| PyTorch | CUDA 12.8 版 |
| ffmpeg | winget の `Gyan.FFmpeg` (サウンドの変換に使用) |

### モデル

| 用途 | ファイル (`C:\Users\yutak\ComfyUI\models\` 配下) | 配布元 / ライセンス |
| --- | --- | --- |
| 画像 | `checkpoints/sd_xl_base_1.0.safetensors` | stabilityai/stable-diffusion-xl-base-1.0 / CreativeML Open RAIL++-M |
| 画像 (ピクセルアート化) | `loras/pixel-art-xl.safetensors` | nerijs/pixel-art-xl |
| BGM | `checkpoints/ace_step_v1_3.5b.safetensors` | ACE-Step (Comfy-Org/ACE-Step_ComfyUI_repackaged) / Apache-2.0 |
| SE | `checkpoints/stable-audio-open-1.0.safetensors` | stabilityai/stable-audio-open-1.0 / Stability AI Community License |
| SE (テキストエンコーダー) | `text_encoders/t5_base.safetensors` | google-t5/t5-base / Apache-2.0 |

モデルのライセンス (特に商用利用の条件) はゲーム公開前に配布元で再確認すること。

## 起動

```bash
cd C:\Users\yutak\ComfyUI
venv\Scripts\python.exe main.py
```

`http://127.0.0.1:8188` で待ち受ける。ブラウザで開けば GUI でも操作できる。
環境変数で上書きできる: `COMFYUI_URL`、`COMFYUI_CHECKPOINT` / `COMFYUI_LORA` (画像)、`COMFYUI_BGM_CHECKPOINT` / `COMFYUI_SE_CHECKPOINT` (サウンド)、`FFMPEG_PATH`。

## Stable Audio Open (SE 用モデル) の導入

このモデルは Hugging Face で利用規約への同意が必要なため、自動ではダウンロードできない。

1. https://huggingface.co/stabilityai/stable-audio-open-1.0 にログインしてライセンスに同意する
2. https://huggingface.co/settings/tokens で Read 権限のアクセストークンを作る
3. 次を実行する (`<TOKEN>` を置き換える。トークンはファイルやリポジトリに保存しない)

```bash
curl -L -H "Authorization: Bearer <TOKEN>" -o C:/Users/yutak/ComfyUI/models/checkpoints/stable-audio-open-1.0.safetensors https://huggingface.co/stabilityai/stable-audio-open-1.0/resolve/main/model.safetensors
```

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
curl -L -o models/checkpoints/ace_step_v1_3.5b.safetensors https://huggingface.co/Comfy-Org/ACE-Step_ComfyUI_repackaged/resolve/main/all_in_one/ace_step_v1_3.5b.safetensors
curl -L -o models/text_encoders/t5_base.safetensors https://huggingface.co/google-t5/t5-base/resolve/main/model.safetensors
winget install --id Gyan.FFmpeg -e
```

Stable Audio Open は上の「導入」の手順で入れる。

## 画像の生成

```bash
# 1. 元画像を生成 (1024px、assets-src/generated/ に保存。--batch 4 で候補を複数出せる)
npm run gen:image -- --name player-idle --prompt "a small knight with a blue cape, front view" --batch 4

# 2. 良い候補をゲーム用スプライトに変換 (32x32、背景除去・減色)
npm run gen:sprite -- --in assets-src/generated/player-idle-12345-2.png --out public/assets/images/player-idle.png --size 32 --palette docs/art/palette.json

# 3. assets-src/previews/player-idle.png (8 倍拡大) で見た目を確認する
```

調整のコツ:

- 背景が残る / キャラが欠ける: `--tolerance` を上げる / 下げる (既定 48)
- 絵のドットが粗すぎる / 細かすぎる: `--pixel-size` を変える (既定 8。LoRA は約 8px 単位で描く)
- 同じ絵を再現したい: `--seed` を固定する
- 生成が遅い / VRAM 不足: `--width 768 --height 768` に下げる

## サウンドの生成

```bash
# BGM: タグ (ジャンル・楽器・テンポ) で指定。歌なし固定
npm run gen:sound -- --type bgm --name race-theme --prompt "chiptune, synthwave, fast tempo, 150 bpm, driving, energetic" --seconds 90 --batch 2

# SE: 自然文で説明
npm run gen:sound -- --type se --name tire-screech --prompt "car tires screeching on asphalt, short" --seconds 2 --batch 4

# 変換 (assets-src/generated/sound/ の元音声 → public/assets/sounds/ の OGG)
npm run gen:sound-convert -- --type bgm --in assets-src/generated/sound/race-theme-123.flac --out public/assets/sounds/bgm/race-theme.ogg --start 4 --end 80
npm run gen:sound-convert -- --type se --in assets-src/generated/sound/tire-screech-456-2.flac --out public/assets/sounds/se/tire-screech-1.ogg
```

変換の既定動作:

| | BGM | SE |
| --- | --- | --- |
| ループ | あり (末尾 2 秒を先頭にクロスフェード。`--no-loop` で無効) | なし (`--loop` で有効。エンジン音など) |
| チャンネル | ステレオ | モノラル |
| 目標ラウドネス | -18 LUFS | -16 LUFS |
| その他 | | 先頭の無音除去、末尾フェード |

確認用に `assets-src/previews/sound/` に波形画像 (ループ時はつなぎ目前後の `-seam.png` も) を出力する。音の良し悪しは必ず人が試聴して判断する。
