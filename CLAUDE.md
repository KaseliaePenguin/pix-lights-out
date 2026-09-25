# CLAUDE.md

## プロジェクト概要

**PIX LIGHTS OUT** — トップダウン視点の F1 風レースゲーム (タイトルは F1 のスタート「lights out」+ ピクセルアートの PIX。表記は常に 3 語セット)。TypeScript + Canvas 2D で作るブラウザゲームで、外部ゲームエンジンは使わず、ゲームループ・シーン管理・入力処理を `src/core/` に自前で実装している。

- オンライン対戦あり: P2P のホスト・クライアント方式で、ブラウザ同士を WebRTC DataChannel でつなぐ。接続情報はコードのコピペで手渡しし、自前のサーバーは立てない (NAT 越えは公開 STUN のみ)。接続方式は `docs/design/network.md`
- アートスタイルはピクセルアート。画像・BGM・SE はすべてローカルの AI で生成する

実装の基本:

- `Game` が固定タイムステップ (1/60 秒) で `update` を呼び、毎フレーム `render` する
- 画面は `Scene` 単位で管理し、`game.changeScene(new XxxScene(game))` で切り替える
- 入力は `game.input.isDown(code)` (押している間) / `wasPressed(code)` (押した瞬間) で取得する。キーは `KeyboardEvent.code` の値 (`'KeyA'`, `'ArrowLeft'`, `'Space'` など)

### ディレクトリ構成

```
src/
  main.ts       エントリーポイント (アセットを読み込んでからタイトルを出す)
  assetList.ts  読み込む画像・音声・データの一覧と、SE ごとの基準音量
  core/         エンジン層: Game / Input / Scene、カメラ・ワールド層、アセット、オーディオ、セーブ
  shared/       DOM に依存しない純粋な計算: 車の物理、コース、周回判定、ゴースト、TimeAttackSession (M4 でホストの Web Worker とも共有)
  render/       コース・タイヤ痕・車の描画
  scenes/       画面ごとのシーン (TitleScene, MenuScene, TimeAttackScene など)
  ui/           HUD・メニューの描画部品 (ビットマップフォントなど)
  entities/     パーティクルなど、描画用のゲームオブジェクト
public/assets/  画像・音声・データの静的アセット (実行時は /assets/... で参照)
promo/          宣伝用の一枚絵 (ゲーム内では使わない。scripts/build-promo.mjs で作り直せる)
```

## 技術スタック

- 言語: TypeScript 5 (`strict`, `noUnusedLocals`, `noUnusedParameters` 有効)
- ビルド / 開発サーバー: Vite 6
- 描画: Canvas 2D API (800×600、`index.html` で定義)
- 実行環境: Node.js 24 / npm (開発時)、モダンブラウザ (実行時)
- 外部ランタイム依存なし (devDependencies は typescript、vite、画像変換用の sharp)

### コマンド

```bash
npm run dev        # 開発サーバー (http://localhost:5173)
npm run typecheck  # 型チェックのみ
npm run build      # 型チェック + 本番ビルド (dist/)
npm run preview    # ビルド結果の確認
npm run dashboard  # Claude 利用状況ダッシュボード (http://127.0.0.1:5190)
node scripts/sim-lap.mjs  # 物理・周回判定のヘッドレス確認 (AI の周回、壁の突き抜け、ゴースト)。src/shared/ を変えたら通す
```

開発時は `http://localhost:5173/?scene=timeattack` で走行画面から始められる。

Claude 利用状況ダッシュボード (`tools/claude-dashboard/`) は `~/.claude/projects/` の会話記録を読み、現在のタスク・エージェント稼働状況・推定コストを表示する。費用は API 単価 (`pricing.json`) による推定値で、料金改定時は `pricing.json` を更新する。会話記録を含むため 127.0.0.1 でのみ待ち受ける。

変更後は `npm run build` が通ることを確認する。

### アセット生成 (ローカル AI)

- ComfyUI は `C:\Users\yutak\ComfyUI` にあり、`http://127.0.0.1:8188` で動かす。セットアップと使い方は `docs/setup/comfyui.md`
- 画像 (ピクセルアート): SDXL + pixel-art-xl LoRA。`npm run gen:image` で元画像を生成し、`npm run gen:sprite` で透過 PNG に変換して `public/assets/images/` に置く
- BGM: ACE-Step、SE: Stable Audio Open。`npm run gen:sound` で元音声を生成し、`npm run gen:sound-convert` で OGG に変換 (ループ化・音量調整) して `public/assets/sounds/bgm/`・`se/` に置く
- ComfyUI の呼び出しは `scripts/lib/comfyui.mjs` に共通化している
- `assets-src/` は中間ファイル置き場 (git 管理外)。スタイルガイドは `docs/art/`、サウンドの方針と一覧は `docs/sound/`
- `sharp` (画像変換) と ffmpeg (音声変換、winget で導入) は生成スクリプト専用で、ゲーム本体では使わない
- Claude は音を聴けないため、サウンドの最終確認は必ずユーザーの試聴で行う

## サブエージェント

`.claude/agents/` に定義。企画 → 見た目・音の方針 → 素材 → 実装 → 確認の順につながる。

| エージェント | 担当 |
| --- | --- |
| game-designer | 仕様書 (`docs/design/`) |
| art-director | スタイルガイド・パレット・見た目のレビュー (`docs/art/`) |
| 2d-illustrator | ピクセルアートの生成と配置 (`public/assets/images/`) |
| sound-designer | BGM・SE の方針、生成、加工、配置 (`docs/sound/`, `public/assets/sounds/`) |
| game-engineer | エンジン層・基盤機能 (`src/core/`) |
| scene-builder | シーンの実装 (`src/scenes/`) |
| build-checker | ビルド確認とエラー修正 |
| code-reviewer | 変更のレビュー (コードは変更しない) |

## 命名規則

### ファイル

- クラスを 1 つ公開するファイル: PascalCase でクラス名と一致させる (`Player.ts`, `PlayScene.ts`)
- シーンは `〇〇Scene.ts`、クラス名も `〇〇Scene`
- エントリーポイントなどクラスを持たないファイル: camelCase (`main.ts`)

### コード

| 対象 | 規則 | 例 |
| --- | --- | --- |
| クラス / インターフェース / 型 | PascalCase | `Game`, `Scene`, `Player` |
| 変数 / 関数 / メソッド / プロパティ | camelCase | `changeScene`, `accumulator` |
| 真偽値を返すメソッド | `is` / `was` / `has` で始める | `isDown`, `wasPressed` |
| 定数的なクラスプロパティ | `private readonly` の camelCase | `speed`, `step` |

- インターフェースに `I` 接頭辞は付けない (`Scene`、`IScene` ではない)
- 型のみの import は `import type` を使う
- 可視性は必要最小限に: 外部から読むだけのものは `readonly`、内部状態は `private`

### スタイル

- インデント 2 スペース、シングルクォート、セミコロンあり
- 時間の単位は秒 (`dt` は秒)、速度は px/秒
- コメントは日本語で、コードから読み取れない意図だけを書く
