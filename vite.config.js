import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ command }) => ({
  // ビルド時はGitHub Pages用のサブディレクトリbaseを使用、開発時は/
  base: command === 'build'
    ? `/${process.env.GITHUB_REPOSITORY?.split('/')[1] ?? 'DeContradictor'}/`
    : '/',
  server: {
    port: 5173
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(rootDir, 'index.html'),
        live: resolve(rootDir, 'live.html'),
      },
    },
  },
}));
