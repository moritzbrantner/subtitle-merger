import baseConfig from './playwright.config'

export default {
  ...baseConfig,
  webServer: {
    command:
      'bun run build:frontend && bun run --cwd frontend preview -- --host 127.0.0.1 --port 5174 --strictPort',
    reuseExistingServer: false,
    timeout: 120_000,
    url: 'http://127.0.0.1:5174',
  },
}
