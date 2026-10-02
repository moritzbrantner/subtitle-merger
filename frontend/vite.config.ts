import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const timelineEditorSource = fileURLToPath(
  new URL('../node_modules/@moritzbrantner/timeline-editor/src/', import.meta.url),
)

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      {
        find: '@moritzbrantner/timeline-editor/audio',
        replacement: `${timelineEditorSource}audio.ts`,
      },
      {
        find: '@moritzbrantner/timeline-editor/text',
        replacement: `${timelineEditorSource}text.ts`,
      },
      {
        find: /^@moritzbrantner\/timeline-editor$/,
        replacement: `${timelineEditorSource}index.ts`,
      },
    ],
  },
  optimizeDeps: {
    // Timeline Editor stays source-first, but its UI dependency chain contains
    // CommonJS shims. Serving these raw breaks ESM linking before App can mount.
    // Production bundling handles them; ordinary Vite dev needs explicit entries.
    include: [
      'use-sync-external-store/shim',
      'use-sync-external-store/shim/with-selector',
    ],
    exclude: [
      '@moritzbrantner/timeline-editor',
      '@moritzbrantner/timeline-editor/audio',
      '@moritzbrantner/timeline-editor/text',
    ],
  },
  server: {
    proxy: {
      '/api': process.env.VITE_BACKEND_URL || 'http://127.0.0.1:3000',
    },
  },
})
