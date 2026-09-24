import baseConfig from './playwright.config'

export default {
  ...baseConfig,
  retries: 0,
  use: {
    ...baseConfig.use,
    baseURL: 'http://127.0.0.1:5175/subtitle-merger/',
  },
  webServer: {
    command: 'GITHUB_ACTIONS=false bun run --cwd site build && python3 -m http.server 5175 --bind 127.0.0.1 --directory site/out',
    reuseExistingServer: false,
    timeout: 120_000,
    url: 'http://127.0.0.1:5175',
  },
}
