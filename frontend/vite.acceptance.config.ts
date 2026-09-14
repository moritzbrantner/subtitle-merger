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
    exclude: ['@moritzbrantner/timeline-editor', '@moritzbrantner/timeline-editor/text'],
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
  },
})
