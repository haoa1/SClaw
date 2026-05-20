import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'cd ../backend && npx tsx src/index.ts',
      port: 3001,
      timeout: 30_000,
      reuseExistingServer: true,
    },
    {
      command: 'npx vite --port 5173 --host',
      port: 5173,
      timeout: 30_000,
      reuseExistingServer: true,
    },
  ],
});
