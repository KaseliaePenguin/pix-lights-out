/**
 * オンライン対戦の設定値 (network.md)。STUN サーバーを差し替えるときはここだけを変える。
 * 対称 NAT の判定に 2 つ必要 (違う STUN サーバーから違うポートに見えるかで判定する)
 */
export const stunServers: readonly RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/** 待ち時間・間隔 (ms) */
export const netTimings = {
  /** 接続先候補の収集の上限。超えたら集まった候補でコードを出す */
  gatherTimeoutMs: 5000,
  /** 招待コードの有効期限 (ホスト) */
  inviteLifetimeMs: 10 * 60 * 1000,
  /** 返答コードを出してからホストが貼り付けるまで (参加者) */
  replyWaitMs: 120 * 1000,
  /** ホストが返答コードを貼ってから DataChannel 2 本が開くまで */
  connectTimeoutMs: 15 * 1000,
  /** DataChannel が開いてから join / welcome が来るまで (ロビーで使う) */
  handshakeTimeoutMs: 5000,
  /** ping の間隔 (network.md: 1 回/秒) */
  pingIntervalMs: 1000,
  /** 参加者は始めにこの回数だけ短い間隔で ping を送り、時刻合わせを早く収束させる */
  pingBurstCount: 10,
  pingBurstIntervalMs: 100,
  /** 相手から何も届かない時間の上限。超えたら切断扱い (network.md: 10 秒 pong が返らない) */
  peerTimeoutMs: 10 * 1000,
  /** 接続経路 (LAN / NET) を調べ直す間隔 */
  routeRefreshMs: 5000,
  /** 中継: WebSocket を開いて名乗りが通るまで。超えたら中継は使えないものとする (返答コード方式に切り替える) */
  relayConnectTimeoutMs: 6000,
  /** 中継: 参加者が offer を送ってからホストの answer が届くまで */
  relayAnswerWaitMs: 10 * 1000,
  /** 中継: answer を作って (受け取って) から DataChannel 2 本が開くまで (候補は trickle で届く) */
  relayLinkTimeoutMs: 20 * 1000,
  /** 中継: 生存確認の間隔 (つなぎっぱなしの WebSocket が途中の機器に切られないように) */
  relayKeepaliveMs: 30 * 1000,
  /** 中継: ホストの WebSocket が切れたときに入り直す回数と間隔 (同じ部屋・同じ招待リンクのまま) */
  relayReconnectAttempts: 3,
  relayReconnectDelayMs: 2000,
} as const;

/**
 * 中継 (シグナリング、signaling/ の Cloudflare Worker) の URL (wss://…、末尾の / なし)。デプロイした URL をここに入れる。
 * 開発時 (npm run dev) は wrangler dev (signaling/ で npm run dev、ポート 8787) を使う。
 * 開発時だけ ?signal=off で中継を使わない (返答コード方式の確認用)、?signal=ws://… で別の中継を使う
 */
const deployedSignalingUrl = 'wss://pix-lights-out-signal.kaseliaepenguin.workers.dev';
const devSignalingPort = 8787;

/** 中継の URL。使わないときは null */
export function signalingUrl(): string | null {
  if (!import.meta.env.DEV) return deployedSignalingUrl;
  const override = new URLSearchParams(location.search).get('signal');
  if (override === 'off') return null;
  if (override && /^wss?:\/\//.test(override)) return override.replace(/\/+$/, '');
  return `ws://${location.hostname}:${devSignalingPort}`;
}
