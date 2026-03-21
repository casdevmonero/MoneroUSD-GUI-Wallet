/**
 * E2E test: Wallet import from seed via welcome screen + balance display on dashboard.
 *
 * Flow: Welcome page → "Restore from seed" → enter seed → submit → dashboard balance.
 *
 * Requires:
 *   - node server.js running on port 3000 (light-wallet-service)
 *   - USDmd daemon on port 17750
 *
 * Run: npx playwright test tests/import-balance.spec.js
 

const { test, expect } = require('@playwright/test');

const APP_URL    = process.env.APP_URL || 'http://localhost:3000';
const TEST_SEED  = 'camp coexist roomy hobby inmate festival alarms ailments bias warped sprig pedantic elbow always ablaze awful vexed down second strained atlas magically lobster luxury lobster';
const TIMEOUT_RESTORE  = 180000; // 3 min — restore_deterministic_wallet can be slow
const TIMEOUT_BALANCE  = 120000; // 2 min — balance poll after sync

// Valid balance: "—" or number like "$0.00" or "0.00" (with/without $ prefix)
function isValidBalanceText(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (t === '—') return true;
  return /^\$?\d{1,3}(,\d{3})*(\.\d{2,6})?$|^\$?\d+(\.\d{2,6})?$/.test(t);
}

test.describe('Wallet import from seed + balance update', () => {

  test.setTimeout(TIMEOUT_RESTORE + TIMEOUT_BALANCE + 60000);

  test('imports test seed via welcome screen and shows valid balance on dashboard', async ({ page }) => {

    // ── 1. Load app and wait for welcome page ───────────────────────────────
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for session to initialise (the app calls /api/session on load)
    await page.waitForTimeout(4000);

    // Welcome page should be visible
    const welcomePage = page.locator('#welcomePage');
    await welcomePage.waitFor({ state: 'visible', timeout: 15000 });

    // ── 2. Click "Restore from seed" on the welcome screen ──────────────────
    const restoreBtn = page.locator('#welcomeRestoreBtn');
    await restoreBtn.waitFor({ state: 'visible', timeout: 10000 });
    await restoreBtn.click();

    // The restore step should now be visible
    const restoreStep = page.locator('#welcomeRestore');
    await restoreStep.waitFor({ state: 'visible', timeout: 10000 });

    // ── 3. Enter the test seed ───────────────────────────────────────────────
    const seedInput = page.locator('#welcomeRestoreSeed');
    await seedInput.waitFor({ state: 'visible', timeout: 5000 });
    await seedInput.fill(TEST_SEED);

    // Leave password blank, restore height = 0 (defaults)

    // ── 4. Submit restore ────────────────────────────────────────────────────
    const submitBtn = page.locator('#welcomeRestoreSubmit');
    await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
    await submitBtn.click();

    // ── 5. App shows main UI immediately; welcome page hides ─────────────────
    // Wait for welcome page to become hidden (app calls showMainApp() right away)
    await page.waitForFunction(
      () => {
        const wp = document.getElementById('welcomePage');
        if (!wp) return true;
        return wp.classList.contains('hidden') || wp.style.display === 'none';
      },
      { timeout: 30000 }
    );

    // ── 6. Balance element should appear on dashboard ────────────────────────
    const balanceEl = page.locator('#balanceUsdm');
    await balanceEl.waitFor({ state: 'visible', timeout: 20000 });

    // ── 7. Wait for balance to resolve from "…" spinner ─────────────────────
    // The background restore sets the balance once the wallet RPC syncs
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#balanceUsdm');
        if (!el) return false;
        const t = el.textContent.trim();
        return t !== '' && t !== '…' && t !== 'Loading…';
      },
      { timeout: TIMEOUT_RESTORE + TIMEOUT_BALANCE }
    );

    const balanceText = (await balanceEl.textContent()).trim();
    console.log('[test] Balance after import:', balanceText);

    // ── 8. Balance must be a valid display value ─────────────────────────────
    expect(
      isValidBalanceText(balanceText),
      `Balance should be "—" or a dollar amount, got: "${balanceText}"`
    ).toBe(true);

    // ── 9. Sync status banner should exist in DOM ────────────────────────────
    await expect(page.locator('#syncStatusBanner')).toHaveCount(1);

    // ── 10. Click Refresh; balance should remain valid ───────────────────────
    const refreshBtn = page.locator('#btnRefresh');
    if (await refreshBtn.count() > 0 && await refreshBtn.isVisible()) {
      await refreshBtn.click();
      await page.waitForFunction(
        () => {
          const el = document.querySelector('#balanceUsdm');
          if (!el) return false;
          const t = el.textContent.trim();
          return t !== '…' && t !== '';
        },
        { timeout: 60000 }
      );
      const balanceAfterRefresh = (await balanceEl.textContent()).trim();
      console.log('[test] Balance after Refresh:', balanceAfterRefresh);
      expect(
        isValidBalanceText(balanceAfterRefresh),
        `Balance after refresh should be valid, got: "${balanceAfterRefresh}"`
      ).toBe(true);
    }
  });

  test('welcome restore rejects wrong word count', async ({ page }) => {
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    await page.locator('#welcomeRestoreBtn').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('#welcomeRestoreBtn').click();

    await page.locator('#welcomeRestoreSeed').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#welcomeRestoreSeed').fill('only four words here');
    await page.locator('#welcomeRestoreSubmit').click();

    const msg = page.locator('#welcomeRestoreMsg');
    await msg.waitFor({ state: 'visible', timeout: 5000 });
    const msgText = await msg.textContent();
    expect(msgText).toMatch(/seed must be|words/i);
    // Welcome page must still be showing (restore was rejected)
    await expect(page.locator('#welcomePage')).toBeVisible();
  });

  test('welcome restore rejects empty seed', async ({ page }) => {
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    await page.locator('#welcomeRestoreBtn').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('#welcomeRestoreBtn').click();

    await page.locator('#welcomeRestoreSeed').waitFor({ state: 'visible', timeout: 10000 });
    // Leave seed empty
    await page.locator('#welcomeRestoreSubmit').click();

    const msg = page.locator('#welcomeRestoreMsg');
    await msg.waitFor({ state: 'visible', timeout: 5000 });
    const msgText = await msg.textContent();
    expect(msgText).toMatch(/enter your.*seed/i);
    await expect(page.locator('#welcomePage')).toBeVisible();
  });
});
