# test-game-project

TypeScript + Vite + Canvas 2D によるブラウザゲームのひな形です。

## セットアップ

```bash
npm install
npm run dev      # 開発サーバー起動 (http://localhost:5173)
npm run build    # 型チェック + 本番ビルド (dist/)
npm run preview  # ビルド結果の確認
```

## 構成

```
src/
  main.ts            エントリーポイント
  core/
    Game.ts          メインループ (固定 60fps 更新) とシーン管理
    Input.ts         キーボード入力 (isDown / wasPressed)
    Scene.ts         シーンのインターフェース
  scenes/
    TitleScene.ts    タイトル画面
    PlayScene.ts     プレイ画面
  entities/
    Player.ts        プレイヤー (WASD / 矢印キーで移動)
public/assets/       画像・音声などの静的アセット
```

## 操作

- Enter / Space: ゲーム開始
- WASD / 矢印キー: 移動
- Esc: タイトルへ戻る
