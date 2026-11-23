import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode, command }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      // The Gemini key is only injected for `npm run dev`. A production build
      // (served publicly from CloudFront) must never contain it.
      define: {
        'process.env.API_KEY': JSON.stringify(command === 'serve' ? env.GEMINI_API_KEY ?? '' : ''),
        'process.env.GEMINI_API_KEY': JSON.stringify(command === 'serve' ? env.GEMINI_API_KEY ?? '' : '')
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
