# CLAUDE.md

## プロジェクト概要

TypeScript + Canvas 2D で作るブラウザ向け 2D ゲームのひな形。外部ゲームエンジンは使わず、ゲームループ・シーン管理・入力処理を `src/core/` に自前で実装している。

- `Game` が固定タイムステップ (1/60 秒) で `update` を呼び、毎フレーム `render` する
- 画面は `Scene` 単位で管理し、`game.changeScene(new XxxScene(game))` で切り替える
- 入力は `game.input.isDown(code)` (押している間) / `wasPressed(code)` (押した瞬間) で取得する。キーは `KeyboardEvent.code` の値 (`'KeyA'`, `'ArrowLeft'`, `'Space'` など)

### ディレクトリ構成

```
src/
  main.ts       エントリーポイント (Game 生成と最初のシーン設定)
  core/         エンジン層: Game / Input / Scene。ゲーム固有のロジックは置かない
  scenes/       画面ごとのシーン (TitleScene, PlayScene など)
  entities/     プレイヤー・敵などのゲームオブジェクト
public/assets/  画像・音声などの静的アセット (実行時は /assets/... で参照)
```

## 技術スタック

- 言語: TypeScript 5 (`strict`, `noUnusedLocals`, `noUnusedParameters` 有効)
- ビルド / 開発サーバー: Vite 6
- 描画: Canvas 2D API (800×600、`index.html` で定義)
- 実行環境: Node.js 24 / npm (開発時)、モダンブラウザ (実行時)
- 外部ランタイム依存なし (devDependencies は typescript と vite のみ)

### コマンド

```bash
npm run dev        # 開発サーバー (http://localhost:5173)
npm run typecheck  # 型チェックのみ
npm run build      # 型チェック + 本番ビルド (dist/)
npm run preview    # ビルド結果の確認
```

変更後は `npm run build` が通ることを確認する。

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
