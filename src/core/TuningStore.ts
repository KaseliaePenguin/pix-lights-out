/**
 * 調整する数値の出どころ (例: 車のパラメータ、カメラ)。
 * defaults の数値の項目 (入れ子のオブジェクトの中も含む) が、そのまま調整の項目になる
 */
export interface TuningSource {
  /** JSON のキー (例: 'carParams') */
  readonly id: string;
  /** 最初のグループの名前 */
  readonly label: string;
  /** 既定値。数値の項目だけを読む (Infinity などの有限でない数・真偽値は対象外) */
  readonly defaults: object;
  /** 値を実際のパラメータに反映する */
  apply(path: readonly string[], value: number): void;
  /**
   * 上の階層の数値の項目で、そのキーから新しいグループが始まるもの (キー → グループ名)。
   * ここにないキーは直前のグループに入るので、項目を足してもこの表を直さなくてよい。
   * 入れ子のオブジェクト (例: surfaces) は、キーの名前で自動的に 1 つのグループになる
   */
  readonly groupStarts?: Readonly<Record<string, string>>;
}

export interface TuningItem {
  readonly source: TuningSource;
  readonly path: readonly string[];
  readonly group: string;
  /** グループ内での表示名 (入れ子なら親のキーを含む) */
  readonly label: string;
  readonly defaultValue: number;
  /** 1 回の操作で変える量 */
  readonly step: number;
  value: number;
}

/**
 * 開発時の調整の値を持ち、変えた値を localStorage に保存する。
 * 保存・書き出しの形は「変えた項目だけを、元の構造どおりに入れ子にした JSON」: { [source.id]: { key: value, nested: { key: value } } }
 */
export class TuningStore {
  readonly items: TuningItem[] = [];
  /** グループ名 (表示順) */
  readonly groups: string[] = [];

  constructor(
    private readonly storageKey: string,
    sources: readonly TuningSource[],
  ) {
    for (const source of sources) collectItems(source, this.items);
    for (const item of this.items) if (!this.groups.includes(item.group)) this.groups.push(item.group);
    this.load();
  }

  /** 既定値と違う項目があるか */
  get isModified(): boolean {
    return this.items.some((item) => item.value !== item.defaultValue);
  }

  isItemModified(item: TuningItem): boolean {
    return item.value !== item.defaultValue;
  }

  /** steps 回分 (負なら減らす) 変える。既定値が 0 以上の項目は負にしない */
  adjust(item: TuningItem, steps: number): void {
    let value = roundValue(item.value + item.step * steps);
    if (item.defaultValue >= 0) value = Math.max(0, value);
    this.setValue(item, value);
  }

  setValue(item: TuningItem, value: number): void {
    if (!Number.isFinite(value) || value === item.value) return;
    item.value = value;
    item.source.apply(item.path, value);
    this.save();
  }

  resetItem(item: TuningItem): void {
    this.setValue(item, item.defaultValue);
  }

  resetAll(): void {
    for (const item of this.items) {
      if (item.value === item.defaultValue) continue;
      item.value = item.defaultValue;
      item.source.apply(item.path, item.value);
    }
    this.save();
  }

  /** 変えた項目だけの JSON (整形済み) */
  toJson(): string {
    return JSON.stringify(this.changedValues(), null, 2);
  }

  private changedValues(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const item of this.items) {
      if (item.value === item.defaultValue) continue;
      let node = (out[item.source.id] ??= {});
      for (let i = 0; i < item.path.length - 1; i++) {
        node = (node[item.path[i]] ??= {}) as Record<string, unknown>;
      }
      node[item.path[item.path.length - 1]] = item.value;
    }
    return out;
  }

  private load(): void {
    let data: unknown = null;
    try {
      const text = window.localStorage.getItem(this.storageKey);
      data = text === null ? null : (JSON.parse(text) as unknown);
    } catch {
      return;
    }
    if (!isObject(data)) return;
    for (const item of this.items) {
      let node: unknown = data[item.source.id];
      for (const key of item.path) node = isObject(node) ? node[key] : undefined;
      if (typeof node === 'number' && Number.isFinite(node) && node !== item.value) {
        item.value = node;
        item.source.apply(item.path, node);
      }
    }
  }

  private save(): void {
    try {
      const changed = this.changedValues();
      if (Object.keys(changed).length === 0) window.localStorage.removeItem(this.storageKey);
      else window.localStorage.setItem(this.storageKey, JSON.stringify(changed));
    } catch {
      // 保存できなくても、起動中は変えた値で走れる
    }
  }
}

function collectItems(source: TuningSource, out: TuningItem[]): void {
  let group = source.label;
  const visit = (node: Record<string, unknown>, path: string[], nestedGroup: string | null): void => {
    for (const [key, value] of Object.entries(node)) {
      const itemPath = [...path, key];
      if (isObject(value)) {
        // 入れ子のオブジェクトは、いちばん上のキーの名前で 1 つのグループにまとめる
        visit(value, itemPath, nestedGroup ?? key);
        continue;
      }
      if (nestedGroup === null) group = source.groupStarts?.[key] ?? group;
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      out.push({
        source,
        path: itemPath,
        group: nestedGroup ?? group,
        label: nestedGroup === null ? key : itemPath.slice(1).join(' '),
        defaultValue: value,
        step: stepFor(value),
        value,
      });
    }
  };
  visit(source.defaults as Record<string, unknown>, [], null);
}

/** 既定値の約 5% を 1・2・2.5・5 × 10^n に丸めた量 */
function stepFor(value: number): number {
  const base = value === 0 ? 0.05 : Math.abs(value) * 0.05;
  const exp = Math.pow(10, Math.floor(Math.log10(base)));
  const m = base / exp;
  const nice = m < 1.5 ? 1 : m < 2.25 ? 2 : m < 3.5 ? 2.5 : m < 7.5 ? 5 : 10;
  return nice * exp;
}

/** 足し算の誤差 (0.30000000000000004 など) を消す */
function roundValue(value: number): number {
  return Number(value.toPrecision(10));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
