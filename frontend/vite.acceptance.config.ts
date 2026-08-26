import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vite'
import baseConfig from './vite.config'

const workspaceReact = fileURLToPath(new URL('../node_modules/react', import.meta.url))
const workspaceReactDom = fileURLToPath(new URL('../node_modules/react-dom', import.meta.url))

export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      alias: [
        { find: /^react(\/.*)?$/, replacement: `${workspaceReact}$1` },
        { find: /^react-dom(\/.*)?$/, replacement: `${workspaceReactDom}$1` },
      ],
    },
  }),
)
