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

interface Status {
  message: HudMessage;
  order: number;
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
  private readonly statuses = new Map<string, Status>();
  private statusOrder = 0;
  private time = 0;
  private shownKey = '';
  private shownSince = 0;

  push(message: HudMessage): void {
    if (this.current === null) {
      const status = this.getTopStatus();
      if (status === null || message.priority <= status.priority) {
        this.show(message);
        return;
      }
    } else if (message.priority < this.current.priority) {
      this.show(message);
      return;
    }
    this.pending.push({ message, waited: 0 });
  }

  /** key ごとに 1 件。文言だけ変える (カウントダウンなど) 場合も同じ key で呼び直す */
  setStatus(key: string, message: HudMessage | null): void {
    if (message === null) {
      this.statuses.delete(key);
      return;
    }
    const existing = this.statuses.get(key);
    if (existing) existing.message = message;
    else this.statuses.set(key, { message, order: this.statusOrder++ });
  }

  clear(): void {
    this.current = null;
    this.pending.length = 0;
    this.statuses.clear();
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

    for (const item of this.pending) item.waited += dt;
    for (let i = this.pending.length - 1; i >= 0; i--) {
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
  }

  /** いま帯に出すもの。何もなければ null */
  getDisplay(): DisplayedMessage | null {
    const status = this.getTopStatus();
    let message: HudMessage | null = null;
    let key = '';
    if (this.current !== null && (status === null || this.current.priority <= status.priority)) {
      message = this.current;
      key = `once:${message.text}`;
    } else if (status !== null) {
      message = status;
      key = `status:${status.priority}:${status.text.split(' ')[0]}`;
    }
    if (message === null) return null;

    // 点滅の位相は表示が切り替わった時点から数える (カウントの数字が変わっても位相は保つ)
    if (key !== this.shownKey) {
      this.shownKey = key;
      this.shownSince = this.time;
    }
    const isBlinking = message.priority === 1 && message !== this.current;
    const phase = (this.time - this.shownSince) % blinkPeriod;
    return { text: message.text, color: message.color, isTextVisible: !isBlinking || phase < blinkOn };
  }

  private show(message: HudMessage): void {
    this.current = message;
    this.currentRemaining = showDuration;
  }

  private getTopStatus(): HudMessage | null {
    let topPriority = Infinity;
    for (const s of this.statuses.values()) topPriority = Math.min(topPriority, s.message.priority);
    if (topPriority === Infinity) return null;
    const tops = [...this.statuses.values()]
      .filter((s) => s.message.priority === topPriority)
      .sort((a, b) => a.order - b.order);
    if (tops.length === 1) return tops[0].message;
    const index = Math.floor(this.time / rotateInterval) % tops.length;
    return tops[index].message;
  }
}
