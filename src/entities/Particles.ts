import type { WorldLayer } from '../core/WorldLayer';

/**
 * 粒子のエフェクト (style-guide.md §8)。ドット単位の正方形で描き、消えるときは色の段階で表す (半透明・縮小なし)。
 * 位置・速度はワールド座標 (px)。
 */
export type ParticleKind = 'spark' | 'gravel' | 'grass' | 'smoke';

interface Particle {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  /** 大きさ (ドット) */
  size: number;
  /** 砂利・芝の 2 色のどちらを使うか */
  variant: number;
}

// 寿命の割合に応じて色を段階的に変える
const sparkColors = ['#ffffff', '#ffd60a', '#ff8c1a'];
const smokeColors = ['#cdd6f4', '#a6adc8', '#7f849c'];
const gravelColors = ['#b8a37a', '#8a7550'];
const grassColors = ['#3e7a33', '#2e5e2a'];

const maxParticles = 600;

export class Particles {
  private readonly items: Particle[] = [];

  /** 火花: 接触点から、進行方向の後ろ (vx, vy の逆) へ飛ぶ */
  emitSparks(x: number, y: number, count: number, carVx: number, carVy: number): void {
    const back = Math.atan2(-carVy, -carVx);
    for (let i = 0; i < count; i++) {
      const a = back + (Math.random() - 0.5) * 1.6;
      const v = 120 + Math.random() * 220;
      this.push('spark', x, y, Math.cos(a) * v, Math.sin(a) * v, 0.2 + Math.random() * 0.2, 1);
    }
  }

  /** 砂利・芝の跳ね: 車輪の位置から、車の速度の一部を持って散る */
  emitDirt(kind: 'gravel' | 'grass', x: number, y: number, carVx: number, carVy: number): void {
    const a = Math.random() * Math.PI * 2;
    const v = 30 + Math.random() * 60;
    this.push(kind, x, y, carVx * -0.15 + Math.cos(a) * v, carVy * -0.15 + Math.sin(a) * v, 0.25 + Math.random() * 0.2, 1 + Math.floor(Math.random() * 2));
  }

  /** タイヤスモーク (スピン中) */
  emitSmoke(x: number, y: number): void {
    const a = Math.random() * Math.PI * 2;
    this.push('smoke', x, y, Math.cos(a) * 20, Math.sin(a) * 20, 0.5, 4 + Math.floor(Math.random() * 5));
  }

  update(dt: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const p = this.items[i];
      p.age += dt;
      if (p.age >= p.life) {
        this.items.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      // 空気抵抗の代わりに速度を減らす
      const k = p.kind === 'smoke' ? 0.9 : 0.85;
      p.vx *= Math.pow(k, dt * 10);
      p.vy *= Math.pow(k, dt * 10);
    }
  }

  clear(): void {
    this.items.length = 0;
  }

  render(layer: WorldLayer): void {
    const ctx = layer.ctx;
    for (const p of this.items) {
      if (!layer.isVisible(p.x, p.y, 16)) continue;
      const stage = p.age / p.life;
      let color: string;
      if (p.kind === 'spark') color = sparkColors[Math.min(2, Math.floor(stage * 3))];
      else if (p.kind === 'smoke') color = smokeColors[Math.min(2, Math.floor(stage * 3))];
      else color = (p.kind === 'gravel' ? gravelColors : grassColors)[p.variant];
      ctx.fillStyle = color;
      const x = layer.dotX(p.x);
      const y = layer.dotY(p.y);
      if (p.kind === 'spark') ctx.fillRect(x, y, 2, 1);
      else ctx.fillRect(x - Math.floor(p.size / 2), y - Math.floor(p.size / 2), p.size, p.size);
    }
  }

  private push(kind: ParticleKind, x: number, y: number, vx: number, vy: number, life: number, size: number): void {
    if (this.items.length >= maxParticles) this.items.shift();
    this.items.push({ kind, x, y, vx, vy, age: 0, life, size, variant: Math.random() < 0.5 ? 0 : 1 });
  }
}
