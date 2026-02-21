import path from 'path';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8')
) as { version: string };

export default defineConfig(({ mode }) => {
    const base = mode === 'production' ? '/exr-lab/' : '/';
    return {
      base,
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      define: {
        __APP_VERSION__: JSON.stringify(packageJson.version),
      },
      plugins: [
        react(),
        VitePWA({
          registerType: 'prompt',
          includeAssets: ['icons/*.svg'],
          workbox: {
            globPatterns: ['**/*.{js,css,html,svg,woff2,wasm}'],
            maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
            runtimeCaching: [
              {
                // Cache Tailwind CDN
                urlPattern: /^https:\/\/cdn\.tailwindcss\.com\/.*/i,
                handler: 'CacheFirst',
                options: {
                  cacheName: 'tailwind-cdn',
                  expiration: { maxEntries: 5, maxAgeSeconds: 60 * 60 * 24 * 30 },
                  cacheableResponse: { statuses: [0, 200] },
                },
              },
              {
                // Cache esm.sh imports
                urlPattern: /^https:\/\/esm\.sh\/.*/i,
                handler: 'CacheFirst',
                options: {
                  cacheName: 'esm-cdn',
                  expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 30 },
                  cacheableResponse: { statuses: [0, 200] },
                },
              },
            ],
          },
          manifest: {
            name: 'EXR Lab',
            short_name: 'EXR Lab',
            description: 'An OpenEXR image viewer and inspector — works entirely offline in your browser.',
            theme_color: '#0a0a0a',
            background_color: '#0a0a0a',
            display: 'standalone',
            scope: base,
            start_url: base,
            orientation: 'any',
            categories: ['graphics', 'utilities', 'developer tools'],
            icons: [
              {
                src: 'icons/icon-192x192.svg',
                sizes: '192x192',
                type: 'image/svg+xml',
              },
              {
                src: 'icons/icon-512x512.svg',
                sizes: '512x512',
                type: 'image/svg+xml',
              },
              {
                src: 'icons/maskable-512x512.svg',
                sizes: '512x512',
                type: 'image/svg+xml',
                purpose: 'maskable',
              },
            ],
            file_handlers: [
              {
                action: base,
                accept: {
                  'image/x-exr': ['.exr'],
                },
              },
            ],
          },
          devOptions: {
            enabled: true,
          },
        }),
      ],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
