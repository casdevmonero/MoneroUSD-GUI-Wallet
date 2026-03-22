/**
 * E2E test: USDm balance on dashboard updates after load and after Refresh.
 * Requires: node server.js on port 3000, wallet RPC on 27750, USDmd on 17750 (optional for balance 0).
 * Run: npx playwright test tests/dashboard-balance.spec.js
 */

const { test, expect } = require('@playwright/test');

const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const BALANCE_SELECTOR = '#balanceUsdm';
const REFRESH_BTN_SELECTOR = '#btnRefresh';
const SYNC_BANNER_SELECTOR = '#syncStatusBanner';

// Valid balance display: "—" or number with optional commas and 2–6 decimals (e.g. "0.00", "1,234.56")
function isValidBalanceText(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (t === '—') return true;
  return /^\d{1,3}(,\d{3})*(\.\d{2,6})?$|^\d+(\.\d{2,6})?$/.test(t);
}

test.describe('Dashboard USDm balance', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto(APP_URL, { waitUntil: 'load', timeout: 15000 });
    await page.locator(BALANCE_SELECTOR).waitFor({ state: 'visible', timeout: 10000 });
  });

  test('balance element shows valid value after page load', async ({ page }) => {
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const t = el.textContent.trim();
        return t !== '' && t !== '…';
      },
      BALANCE_SELECTOR,
      { timeout: 10000 }
    );
    const balanceText = await page.locator(BALANCE_SELECTOR).textContent();
    expect(isValidBalanceText(balanceText), `Balance should be "—" or a number, got: ${balanceText}`).toBe(true);
  });

  test('balance updates after Refresh click', async ({ page }) => {
    const balanceBefore = await page.locator(BALANCE_SELECTOR).textContent();
    await page.locator(REFRESH_BTN_SELECTOR).click();

    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const t = el.textContent.trim();
        return t !== '…';
      },
      BALANCE_SELECTOR,
      { timeout: 120000 }
    );

    const balanceAfter = await page.locator(BALANCE_SELECTOR).textContent();
    expect(isValidBalanceText(balanceAfter), `Balance after refresh should be valid, got: ${balanceAfter}`).toBe(true);
  });
});
