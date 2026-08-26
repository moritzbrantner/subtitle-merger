import baseConfig from './playwright.config'

export default {
  ...baseConfig,
  webServer: {
    command:
      'bunx tsc -b frontend && bunx vite build frontend --config frontend/vite.acceptance.config.ts && bun run --cwd frontend preview -- --host 127.0.0.1 --port 5174 --strictPort',
    reuseExistingServer: false,
    timeout: 120_000,
    url: 'http://127.0.0.1:5174',
  },
}
