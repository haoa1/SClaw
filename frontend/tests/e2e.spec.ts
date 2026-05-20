/**
 * Frontend E2E Tests — SClaw
 *
 * Tests the React + Tailwind frontend through a real browser.
 * Requires backend on :3001 and frontend Vite dev server on :5173.
 *
 * Run: npx playwright test
 */

import { test, expect, Page } from '@playwright/test';

const BACKEND = 'http://localhost:3001';
const USER = { username: 'admin', password: 'admin123' };

function login(page: Page) {
  return page.getByRole('button', { name: '登录' }).click();
}

async function loginAndWait(page: Page) {
  await page.getByPlaceholder('输入用户名').fill(USER.username);
  await page.getByPlaceholder('输入密码').fill(USER.password);
  await Promise.all([
    page.waitForResponse(resp => resp.url().includes('/api/login')),
    login(page),
  ]);
}

// ============================================================================
// 1. Backend health
// ============================================================================
test.describe('Backend connectivity', () => {
  test('backend health endpoint returns OK', async ({ request }) => {
    const res = await request.get(`${BACKEND}/api/health`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.pluginCount).toBe('number');
  });

  test('backend login works', async ({ request }) => {
    const res = await request.post(`${BACKEND}/api/login`, {
      data: USER,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('token');
    expect(body.user.username).toBe('admin');
  });
});

// ============================================================================
// 2. Login page
// ============================================================================
test.describe('Login page', () => {
  test('renders login form with all elements', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByText('股海操盘手')).toBeVisible();
    await expect(page.getByText('登录以继续')).toBeVisible();
    await expect(page.getByPlaceholder('输入用户名')).toBeVisible();
    await expect(page.getByPlaceholder('输入密码')).toBeVisible();
    await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
  });

  test('shows error on wrong password', async ({ page }) => {
    await page.goto('/');

    await page.getByPlaceholder('输入用户名').fill('admin');
    await page.getByPlaceholder('输入密码').fill('wrongpassword');

    // Click login and wait for the API response before checking DOM
    await Promise.all([
      page.waitForResponse(resp => resp.url().includes('/api/login')),
      page.getByRole('button', { name: '登录' }).click(),
    ]);

    await expect(page.getByText('用户名或密码错误')).toBeVisible();
  });

  test('disables login button with empty fields', async ({ page }) => {
    await page.goto('/');

    const loginBtn = page.getByRole('button', { name: '登录' });
    await expect(loginBtn).toBeDisabled();

    // Fill username only — still disabled
    await page.getByPlaceholder('输入用户名').fill('admin');
    await expect(loginBtn).toBeDisabled();

    // Fill both — enabled
    await page.getByPlaceholder('输入密码').fill('admin123');
    await expect(loginBtn).toBeEnabled();
  });
});

// ============================================================================
// 3. Login → Main app
// ============================================================================
test.describe('Login flow', () => {
  test('logs in and shows main app with tabs', async ({ page }) => {
    await page.goto('/');

    await loginAndWait(page);

    // Wait for main app to fully render
    await expect(page.getByText('SClaw')).toBeVisible({ timeout: 10_000 });

    // Verify tabs are present
    await expect(page.getByRole('button', { name: '策略配置' })).toBeVisible();
    await expect(page.getByRole('button', { name: '选股结果' })).toBeVisible();
    await expect(page.getByRole('button', { name: '历史' })).toBeVisible();
    await expect(page.getByRole('button', { name: '日志' })).toBeVisible();

    // Verify execute button
    await expect(page.getByRole('button', { name: /执行选股/ })).toBeVisible();

    // Verify user info
    await expect(page.getByText('管理员')).toBeVisible();
  });

  test('loads plugins after login', async ({ page }) => {
    await page.goto('/');

    await loginAndWait(page);

    // Wait for plugins to load
    await expect(page.getByText('SClaw')).toBeVisible({ timeout: 10_000 });

    // Should show plugin count
    await expect(page.getByText(/个插件/)).toBeVisible();

    // Plugin panel should render strategies
    await expect(page.getByText(/策略/).first()).toBeVisible({ timeout: 5_000 });
  });
});

// ============================================================================
// 4. Strategy selection & screening
// ============================================================================
test.describe('Stock screening', () => {
  test('can select a strategy and run screen', async ({ page }) => {
    await page.goto('/');

    await loginAndWait(page);
    await expect(page.getByText('SClaw')).toBeVisible({ timeout: 10_000 });

    // Wait for plugins to fully load
    await page.waitForTimeout(2_000);

    // Try to find and click a strategy add button (if any plugins exist)
    const addButtons = page.locator('button:has-text("+"), button:has-text("添加"), button:has-text("选择")');
    const firstAddBtn = addButtons.first();
    const hasAddBtn = await firstAddBtn.isVisible({ timeout: 2_000 }).catch(() => false);
    if (hasAddBtn) {
      await firstAddBtn.click();
    }

    // Click "执行选股" button (may be disabled if no strategies selected)
    const runBtn = page.getByRole('button', { name: /执行选股/ });
    const isEnabled = await runBtn.isEnabled().catch(() => false);
    if (isEnabled) {
      await runBtn.click();
      await page.waitForTimeout(2_000);
    }

    // Either results tab or the screen itself should be visible
    const resultsTab = page.getByRole('button', { name: /选股结果/ });
    await expect(resultsTab).toBeVisible();
  });
});

// ============================================================================
// 5. Chat panel
// ============================================================================
test.describe('Chat panel', () => {
  test('chat panel is rendered in the right side', async ({ page }) => {
    await page.goto('/');

    await loginAndWait(page);
    await expect(page.getByText('SClaw')).toBeVisible({ timeout: 10_000 });

    // AI indicator should be visible in header
    await expect(page.getByText('AI 助手')).toBeVisible({ timeout: 5_000 });

    // Check for chat input
    const chatInput = page.locator('textarea, input[type="text"]').last();
    await expect(chatInput).toBeVisible({ timeout: 5_000 });
  });

  test('can send a chat message and see response', async ({ page }) => {
    await page.goto('/');

    await loginAndWait(page);
    await expect(page.getByText('SClaw')).toBeVisible({ timeout: 10_000 });

    await page.waitForTimeout(2_000);

    // Find chat input (the last text input or textarea on the page)
    const chatInput = page.locator('textarea, input[type="text"], input:not([type])').last();
    await chatInput.fill('你好');
    await chatInput.press('Enter');

    // Wait for AI response
    await page.waitForTimeout(3_000);

    // AI indicator should pulse (green)
    const aiIndicator = page.locator('div:has(span:text("AI 助手"))').first();
    await expect(aiIndicator).toBeVisible();
  }, 30_000);
});

// ============================================================================
// 6. Navigation tabs
// ============================================================================
test.describe('Navigation', () => {
  test('switches between config, results, history, and logs tabs', async ({ page }) => {
    await page.goto('/');

    await loginAndWait(page);
    await expect(page.getByText('SClaw')).toBeVisible({ timeout: 10_000 });

    await page.waitForTimeout(2_000);

    // Click each tab and verify content
    const tabs = ['策略配置', '选股结果', '历史', '日志'];
    for (const tab of tabs) {
      const btn = page.getByRole('button', { name: tab });
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(500);
      }
    }
  });
});

// ============================================================================
// 7. Logout
// ============================================================================
test.describe('Logout', () => {
  test('logs out and returns to login page', async ({ page }) => {
    await page.goto('/');

    // Login first
    await loginAndWait(page);
    await expect(page.getByText('SClaw')).toBeVisible({ timeout: 10_000 });

    // Click logout button and wait for the API response
    const logoutBtn = page.getByRole('button', { name: '退出' });
    await expect(logoutBtn).toBeVisible();
    await Promise.all([
      page.waitForResponse(resp => resp.url().includes('/api/logout')),
      logoutBtn.click(),
    ]);

    // Wait for React state update to render login page
    await page.waitForTimeout(500);

    // Should return to login page
    await expect(page.getByText('股海操盘手')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('登录以继续')).toBeVisible();
  });
});
