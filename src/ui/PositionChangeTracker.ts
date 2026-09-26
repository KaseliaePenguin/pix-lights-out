export type PositionChange = 'up' | 'down';

/** 順位が変わった車の色を出し続ける時間 (秒、game-design.md 10.1 節) */
const highlightTime = 3;

/**
 * 順位変動の表示用 (順位表の数字を 3 秒間、上がれば緑・下がれば赤にする)。描画はしない。
 * 毎フレーム update(dt, order) を呼ぶ。order は先頭から順に並べた車番。
 */
export class PositionChangeTracker {
  private readonly positions = new Map<number, number>();
  private readonly changes = new Map<number, { kind: PositionChange; remaining: number }>();
  private readonly changedNow = new Set<number>();

  update(dt: number, order: readonly number[]): void {
    this.changedNow.clear();
    for (const [carNumber, change] of this.changes) {
      change.remaining -= dt;
      if (change.remaining <= 0) this.changes.delete(carNumber);
    }
    order.forEach((carNumber, index) => {
      const before = this.positions.get(carNumber);
      if (before !== undefined && before !== index) {
        this.changes.set(carNumber, { kind: index < before ? 'up' : 'down', remaining: highlightTime });
        this.changedNow.add(carNumber);
      }
      this.positions.set(carNumber, index);
    });
  }

  /** 最初の並び (グリッド) を覚え直し、表示中の変動を消す */
  reset(order: readonly number[]): void {
    this.positions.clear();
    this.changes.clear();
    this.changedNow.clear();
    order.forEach((carNumber, index) => this.positions.set(carNumber, index));
  }

  /** 表示中の変動 (なければ null) */
  changeOf(carNumber: number): PositionChange | null {
    return this.changes.get(carNumber)?.kind ?? null;
  }

  /** この update で順位が変わったか (自車なら position-change を鳴らす) */
  hasChangedNow(carNumber: number): boolean {
    return this.changedNow.has(carNumber);
  }
}
