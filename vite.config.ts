import path from 'path';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8')
) as { version: string };

export default defineConfig(({ mode }) => {
    return {
      base: mode === 'production' ? '/exr-lab/' : '/',
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      define: {
        __APP_VERSION__: JSON.stringify(packageJson.version),
      },
      plugins: [react()],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
