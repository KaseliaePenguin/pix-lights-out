export interface Scene {
  enter?(): void;
  exit?(): void;
  update(dt: number): void;
  render(ctx: CanvasRenderingContext2D): void;
}
