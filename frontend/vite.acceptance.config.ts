import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vite'
import baseConfig from './vite.config'

const workspaceReact = fileURLToPath(new URL('../node_modules/react/index.js', import.meta.url))
const workspaceReactDom = fileURLToPath(new URL('../node_modules/react-dom/index.js', import.meta.url))

export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      alias: [
        { find: /^react$/, replacement: workspaceReact },
        { find: /^react-dom$/, replacement: workspaceReactDom },
      ],
    },
  }),
)
