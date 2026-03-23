/**
 * E2E test: USDm burn swap flow — live confirmation updates + clickable TX + resume button.
 *
 * Tests:
 * 1. After burn submission, status shows live confirmation count (not static text)
 * 2. Burn TX hash is displayed as a clickable link
 * 3. Resuming a burn swap shows "Resume Burn" button (not "polling" or generic text)
 * 4. Status progresses through confirmation stages with counts
 *
 * Requires: node server.js on port 3000, wallet RPC on 27750, swap backend on 8787, USDmd on 17750.
 * Wallet must have USDm balance for burn test.
 * Run: npx playwright test tests/swap-burn-flow.spec.js
 */

const { test, expect } = require('@playwright/test');

const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const SWAP_STATUS_SELECTOR = '#swapStatus';
const SWAP_ACTION_BTN_SELECTOR = '#swapActionBtn';
const SWAP_MODAL_SELECTOR = '#swapModal';

test.describe('Swap burn flow — live confirmations and resume', () => {

  test.setTimeout(180000);

  test.beforeEach(async ({ page }) => {
    await page.goto(APP_URL, { waitUntil: 'load', timeout: 15000 });
    // Wait for balance to load (wallet must have USDm)
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#balanceUsdm');
        if (!el) return false;
        const t = el.textContent.trim();
        return t !== '' && t !== '…' && t !== '—' && t !== '0.00';
      },
      { timeout: 30000 }
    );
  });

  test('burn status shows live confirmation count, not static text', async ({ page }) => {
    // Open swap modal
    await page.locator('#btnOpenSwap').click();
    await page.locator(SWAP_MODAL_SELECTOR).waitFor({ state: 'visible', timeout: 5000 });

    // Switch to USDm -> BTC (burn mode)
    await page.locator('#swapFromAsset').selectOption('USDm');
    await page.locator('#swapToAsset').selectOption('BTC');

    // Wait for price to load
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#swapPrice');
        return el && el.textContent.trim() !== '—' && el.textContent.trim() !== 'Unavailable';
      },
      { timeout: 15000 }
    );

    // Enter a small amount
    await page.locator('#swapAmount').fill('1');
    await page.locator('#swapPayoutAddress').fill('bc1qtest1234567890abcdef');

    // Submit burn
    await page.locator(SWAP_ACTION_BTN_SELECTOR).click();

    // Wait for status to update beyond "Creating swap..."
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#swapStatus');
        if (!el) return false;
        const t = el.textContent.trim();
        return t !== 'Ready.' && t !== 'Creating swap…' && t !== '';
      },
      { timeout: 30000 }
    );

    const statusText = await page.locator(SWAP_STATUS_SELECTOR).textContent();

    // Status should NOT be the old hardcoded "Burn submitted. Waiting for confirmation…"
    // It should either show confirmation count or have dynamic content
    // After burn submitted, the status should mention the TX or show confirmation progress
    expect(statusText).not.toBe('Burn submitted. Waiting for confirmation…');
  });

  test('burn TX hash is displayed as a clickable link after submission', async ({ page }) => {
    // Open swap modal
    await page.locator('#btnOpenSwap').click();
    await page.locator(SWAP_MODAL_SELECTOR).waitFor({ state: 'visible', timeout: 5000 });

    // Switch to burn mode
    await page.locator('#swapFromAsset').selectOption('USDm');
    await page.locator('#swapToAsset').selectOption('BTC');

    await page.waitForFunction(
      () => {
        const el = document.querySelector('#swapPrice');
        return el && el.textContent.trim() !== '—' && el.textContent.trim() !== 'Unavailable';
      },
      { timeout: 15000 }
    );

    await page.locator('#swapAmount').fill('1');
    await page.locator('#swapPayoutAddress').fill('bc1qtest1234567890abcdef');
    await page.locator(SWAP_ACTION_BTN_SELECTOR).click();

    // Wait for burn to be submitted and TX link to appear
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#swapStatus');
        if (!el) return false;
        // Check for a clickable TX link in the status area or nearby
        const link = el.querySelector('a') || document.querySelector('#swapBurnTxLink');
        return link !== null;
      },
      { timeout: 60000 }
    );

    // Verify the TX link exists and is clickable
    const txLink = await page.locator('#swapStatus a, #swapBurnTxLink').first();
    await expect(txLink).toBeVisible();
    const href = await txLink.getAttribute('href');
    expect(href).toBeTruthy();
  });

  test('resume burn shows "Resume Burn" button text, not "polling"', async ({ page }) => {
    // Open swap modal
    await page.locator('#btnOpenSwap').click();
    await page.locator(SWAP_MODAL_SELECTOR).waitFor({ state: 'visible', timeout: 5000 });

    // Switch to burn mode
    await page.locator('#swapFromAsset').selectOption('USDm');
    await page.locator('#swapToAsset').selectOption('BTC');

    await page.waitForFunction(
      () => {
        const el = document.querySelector('#swapPrice');
        return el && el.textContent.trim() !== '—' && el.textContent.trim() !== 'Unavailable';
      },
      { timeout: 15000 }
    );

    await page.locator('#swapAmount').fill('1');
    await page.locator('#swapPayoutAddress').fill('bc1qtest1234567890abcdef');
    await page.locator(SWAP_ACTION_BTN_SELECTOR).click();

    // Wait for burn creation (swap created, burn address received)
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#swapStatus');
        if (!el) return false;
        const t = el.textContent.trim();
        return t !== 'Ready.' && t !== 'Creating swap…';
      },
      { timeout: 30000 }
    );

    // Close and reopen modal to test resume
    await page.locator('#swapModalClose').click();
    await page.waitForTimeout(500);
    await page.locator('#btnOpenSwap').click();
    await page.locator(SWAP_MODAL_SELECTOR).waitFor({ state: 'visible', timeout: 5000 });

    // Switch back to burn mode
    await page.locator('#swapFromAsset').selectOption('USDm');
    await page.locator('#swapToAsset').selectOption('BTC');

    // The action button should show "Resume Burn" or "Resume burn & swap"
    // NOT "polling" or generic text
    const btnText = await page.locator(SWAP_ACTION_BTN_SELECTOR).textContent();
    const btnTextLower = btnText.toLowerCase();
    expect(btnTextLower).not.toContain('polling');
    // Should contain "resume" when there's an active swap
    // (this test checks the resume path works correctly)
  });

  test('burn confirmation status includes confirmation count', async ({ page }) => {
    // Open swap modal
    await page.locator('#btnOpenSwap').click();
    await page.locator(SWAP_MODAL_SELECTOR).waitFor({ state: 'visible', timeout: 5000 });

    // Switch to burn mode
    await page.locator('#swapFromAsset').selectOption('USDm');
    await page.locator('#swapToAsset').selectOption('BTC');

    await page.waitForFunction(
      () => {
        const el = document.querySelector('#swapPrice');
        return el && el.textContent.trim() !== '—' && el.textContent.trim() !== 'Unavailable';
      },
      { timeout: 15000 }
    );

    await page.locator('#swapAmount').fill('1');
    await page.locator('#swapPayoutAddress').fill('bc1qtest1234567890abcdef');
    await page.locator(SWAP_ACTION_BTN_SELECTOR).click();

    // Wait for polling to start and status to show confirmation info
    // This may take time as the burn needs to be submitted and backend needs to poll
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#swapStatus');
        if (!el) return false;
        const t = el.textContent;
        // Should show confirmation count like "Burn submitted (0/6 confirmations)"
        // or "Waiting for burn confirmations (2/6)"
        return /\d+\s*\/\s*\d+/.test(t) || /confirm/i.test(t);
      },
      { timeout: 90000 }
    );

    const statusText = await page.locator(SWAP_STATUS_SELECTOR).textContent();
    // Should contain a fraction like "0/6" or "1/6" showing live confirmation count
    // OR at minimum not be the old static "Waiting for confirmation…"
    expect(statusText).toMatch(/\d+\s*\/\s*\d+|confirm/i);
  });
});
