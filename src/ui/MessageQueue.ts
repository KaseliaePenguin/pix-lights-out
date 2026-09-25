/** メッセージ帯の 1 件 (文言は HUD フォントで描ける英大文字・数字・記号のみ) */
export interface HudMessage {
  text: string;
  color: string;
  /** 小さいほど優先。0 はゴール表示など最優先 (game-design.md 10.2 節の表の 1〜4) */
  priority: number;
}

/** 描画に渡す形 */
export interface DisplayedMessage {
  text: string;
  color: string;
  /** 点滅中で文字を消している間は false (帯の地は出し続ける) */
  isTextVisible: boolean;
}

interface Pending {
  message: HudMessage;
  waited: number;
}

/** 1 回きりのメッセージの表示時間 (秒) */
const showDuration = 2;
/** 待たせたメッセージを捨てるまでの時間 (秒) */
const maxWait = 3;
/** 優先度 1 のメッセージが複数出ているときに切り替える間隔 (秒) */
const rotateInterval = 2;
/** 優先度 1 の点滅: 周期と、そのうち文字を出す時間 (秒) */
const blinkPeriod = 0.6;
const blinkOn = 0.4;

/**
 * メッセージ帯の表示順を決める (game-design.md 10.2 節)。描画はしない。
 * - push: 1 回きりのメッセージ (2 秒表示)。表示中より優先度が高ければ差し替え、低ければ待たせる (3 秒で捨てる)
 * - setStatus: 状態が続く間だけ出し続けるメッセージ (WRONG WAY、RESET のカウントなど)。null で消す
 * - 優先度 1 は点滅させる。優先度 1 が複数あるときは 2 秒ごとに切り替える
 */
export class MessageQueue {
  private current: HudMessage | null = null;
  private currentRemaining = 0;
  private readonly pending: Pending[] = [];
  private readonly statuses = new Map<string, HudMessage>();
  /** 最優先の状態メッセージ (同じ優先度が複数あれば全部)。配列は使い回す */
  private readonly topStatuses: HudMessage[] = [];
  private time = 0;
  /** いま帯に出しているもの (update / push / setStatus で決め直す) */
  private shown: HudMessage | null = null;
  private shownKey = '';
  /** 点滅の起点 (表示が切り替わった時刻) */
  private shownSince = 0;

  push(message: HudMessage): void {
    if (this.current === null) {
      const status = this.getTopStatus();
      if (status === null || message.priority <= status.priority) this.show(message);
      else this.pending.push({ message, waited: 0 });
    } else if (message.priority < this.current.priority) {
      this.show(message);
    } else {
      this.pending.push({ message, waited: 0 });
    }
    this.refreshShown();
  }

  /** key ごとに 1 件。文言だけ変える (カウントダウンなど) 場合も同じ key で呼び直す */
  setStatus(key: string, message: HudMessage | null): void {
    if (message === null) this.statuses.delete(key);
    else this.statuses.set(key, message); // Map は最初に入れた順を保つので、切り替えの順番も保たれる
    this.refreshTopStatuses();
    this.refreshShown();
  }

  clear(): void {
    this.current = null;
    this.pending.length = 0;
    this.statuses.clear();
    this.refreshTopStatuses();
    this.refreshShown();
  }

  update(dt: number): void {
    this.time += dt;

    if (this.current !== null) {
      this.currentRemaining -= dt;
      const status = this.getTopStatus();
      // 優先度の高い状態メッセージに差し替えられたものは捨てる
      if (this.currentRemaining <= 0 || (status !== null && status.priority < this.current.priority)) {
        this.current = null;
      }
    }

    for (let i = this.pending.length - 1; i >= 0; i--) {
      this.pending[i].waited += dt;
      if (this.pending[i].waited >= maxWait) this.pending.splice(i, 1);
    }

    if (this.current === null && this.pending.length > 0) {
      const status = this.getTopStatus();
      const limit = status === null ? Infinity : status.priority;
      let best = -1;
      for (let i = 0; i < this.pending.length; i++) {
        const p = this.pending[i].message.priority;
        if (p <= limit && (best < 0 || p < this.pending[best].message.priority)) best = i;
      }
      if (best >= 0) this.show(this.pending.splice(best, 1)[0].message);
    }

    this.refreshShown();
  }

  /** いま帯に出すもの。何もなければ null (状態は変えない) */
  getDisplay(): DisplayedMessage | null {
    const message = this.shown;
    if (message === null) return null;
    const isBlinking = message.priority === 1 && message !== this.current;
    const phase = (this.time - this.shownSince) % blinkPeriod;
    return { text: message.text, color: message.color, isTextVisible: !isBlinking || phase < blinkOn };
  }

  private show(message: HudMessage): void {
    this.current = message;
    this.currentRemaining = showDuration;
  }

  /** 帯に出すものを決め、切り替わったら点滅の起点を今にする */
  private refreshShown(): void {
    const status = this.getTopStatus();
    let key = '';
    if (this.current !== null && (status === null || this.current.priority <= status.priority)) {
      this.shown = this.current;
      key = `once:${this.current.text}`;
    } else if (status !== null) {
      this.shown = status;
      // カウントの数字が変わっても同じ表示として扱い、点滅の位相を保つ
      key = `status:${status.priority}:${status.text.split(' ')[0]}`;
    } else {
      this.shown = null;
    }
    if (key !== this.shownKey) {
      this.shownKey = key;
      this.shownSince = this.time;
    }
  }

  private refreshTopStatuses(): void {
    this.topStatuses.length = 0;
    let topPriority = Infinity;
    for (const message of this.statuses.values()) {
      if (message.priority < topPriority) {
        topPriority = message.priority;
        this.topStatuses.length = 0;
      }
      if (message.priority === topPriority) this.topStatuses.push(message);
    }
  }

  private getTopStatus(): HudMessage | null {
    const count = this.topStatuses.length;
    if (count === 0) return null;
    if (count === 1) return this.topStatuses[0];
    return this.topStatuses[Math.floor(this.time / rotateInterval) % count];
  }
}
