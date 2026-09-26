# pix-lights-out-signal

PIX LIGHTS OUT のオンライン対戦の中継 (シグナリング)。Cloudflare Workers + Durable Objects (SQLite バックエンド、WebSocket Hibernation API)。
部屋 (ロビー) ごとに 1 つの Durable Object が、ホストと参加者の間で **暗号化済みの接続情報** を受け渡すだけ。中身は読めず、保存・記録もしない。
仕組みとセキュリティは `docs/design/network.md` の「中継による接続」、プロトコルは `src/shared/net/relayProtocol.ts`。

ゲーム本体とは別の package.json。ゲーム本体の依存は増やさない。

## ファイル

| 場所 | 中身 |
| --- | --- |
| `src/index.ts` | Worker の入口 (`/rooms/<部屋 ID>` の WebSocket、Origin の確認) と Durable Object (`RoomObject`) |
| `src/RoomCore.ts` | 部屋の処理 (名乗り・中継・上限・期限)。Cloudflare の型に依存しない (`scripts/sim-net.mjs` からも動かす) |
| `src/origin.ts` | Origin の確認 |
| `scripts/check-local.mjs` | wrangler dev を起動して Node の WebSocket で確かめ、終わったら止める |
| `scripts/check-browser.mjs` | Vite + wrangler dev + ヘッドレス Chrome (`--mute-audio`) の 3 タブで、リンクから WebRTC がつながるまでを確かめる |

## 開発

```bash
cd signaling
npm install
npm run dev            # wrangler dev (http://127.0.0.1:8787)。ゲームの npm run dev はここにつなぐ
npm run typecheck
npm run check:local    # 中継だけの確認 (ポート 8788 で起動して止める)
node scripts/check-browser.mjs   # ブラウザでの確認 (ポート 5174 / 8790 / 9333)
```

ゲームの開発サーバーでは `?signal=off` で中継を使わない (返答コード方式の確認)、`?signal=ws://…` で別の中継を使う。

## 設定 (wrangler.toml)

| 項目 | 内容 |
| --- | --- |
| `ALLOWED_ORIGINS` | 許可する Origin (カンマ区切り、`http://localhost:*` のようにポートを `*` にできる)。配信先を変えたらここを変えて deploy し直す |
| `ROOM_LIFETIME_SEC` | 部屋の寿命 (秒、省略時 1800)。30 分より長くはできない。確認用に短くするときだけ使う |
| `observability.enabled = false` | ログを残さない |

## デプロイ

```bash
cd signaling
npx wrangler login     # 初回だけ
npx wrangler deploy    # 初回は workers.dev のサブドメインの登録を求められることがある
```

表示された URL (`https://pix-lights-out-signal.<サブドメイン>.workers.dev`) の `https` を `wss` にして、
`src/net/netConfig.ts` の `deployedSignalingUrl` に入れ、ゲームを push する (GitHub Pages に公開される)。

公開後の確認: `SIGNAL_URL=wss://… SIGNAL_ORIGIN=https://kaseliaepenguin.github.io node scripts/check-local.mjs`
(wrangler は起動せず、期限切れの確認は飛ばす)。
