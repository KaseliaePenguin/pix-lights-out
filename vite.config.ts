import { defineConfig } from 'vite';

// 相対パスで出力する。GitHub Pages (https://<user>.github.io/<リポジトリ名>/) のようなサブパスでも、そのまま動かせる
export default defineConfig({
  base: './',
});
