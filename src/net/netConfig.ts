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
} as const;
