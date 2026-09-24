import baseConfig from './playwright.config'

export default {
  ...baseConfig,
  retries: 0,
  use: {
    ...baseConfig.use,
    baseURL: 'http://127.0.0.1:5175/subtitle-merger/',
  },
  webServer: {
    command: 'bun run --cwd site dev -- --hostname 127.0.0.1 --port 5175',
    reuseExistingServer: false,
    timeout: 120_000,
    url: 'http://127.0.0.1:5175',
  },
}
