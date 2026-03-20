/**
 * E2E test: Wallet import from seed + balance display on dashboard.
 * Tests the full flow: Import page -> enter seed -> click Import -> dashboard balance update.
 *
 * Requires:
 *   - node server.js running on port 3000 (light-wallet-service)
 *   - USDmd daemon on port 17750
 *
 * Run: npx playwright test tests/import-balance.spec.js
 *
 * Test seed (25-word Monero mnemonic, no real funds):
 *   camp coexist roomy hobby inmate festival alarms ailments bias warped sprig
 *   pedantic elbow always ablaze awful vexed down second strained atlas magically
 *   lobster luxury lobster
 */

const { test, expect } = require('@playwright/test');

const APP_URL    = process.env.APP_URL || 'http://localhost:3000';
const TEST_SEED  = 'camp coexist roomy hobby inmate festival alarms ailments bias warped sprig pedantic elbow always ablaze awful vexed down second strained atlas magically lobster luxury lobster';
const TIMEOUT_IMPORT   = 180000;  // 3 min — restore_deterministic_wallet can be slow
const TIMEOUT_BALANCE  = 120000;  // 2 min — balance poll after sync

// Valid balance display: "—" or a dollar amount (e.g. "$0.00", "$1,234.56")
function isValidBalanceText(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (t === '—') return true;
  // After import the UI sets balance to "$X.XX"
  return /^\$?\d{1,3}(,\d{3})*(\.\d{2,6})?$|^\$?\d+(\.\d{2,6})?$/.test(t);
}

test.describe('Wallet import from seed + balance update', () => {

  test.setTimeout(TIMEOUT_IMPORT + TIMEOUT_BALANCE + 30000);

  test('imports test seed and shows valid balance on dashboard', async ({ page }) => {

    // ── 1. Load app and wait for session to initialise ──────────────────────
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // Give the bootstrap + session creation time to settle
    await page.waitForTimeout(3000);

    // ── 2. Navigate to Import page ───────────────────────────────────────────
    const importNavBtn = page.locator('.nav-btn[data-page="import"]');
    await importNavBtn.waitFor({ state: 'visible', timeout: 15000 });
    await importNavBtn.click();

    // Confirm the import form is visible
    const seedInput = page.locator('#importSeed');
    await seedInput.waitFor({ state: 'visible', timeout: 10000 });

    // ── 3. Fill in the seed (unmask first so we can interact with textarea) ──
    // The textarea starts masked (CSS class) but is still editable
    await seedInput.fill(TEST_SEED);

    // Leave password blank (no password wallet)
    // Leave language as English (default)
    // Leave restore height as 0 (scan from genesis)

    // ── 4. Click Import and wait for success message ─────────────────────────
    const importBtn = page.locator('#btnImport');
    await importBtn.waitFor({ state: 'visible', timeout: 5000 });
    await importBtn.click();

    // Wait for "Wallet restored" or "Importing" message to appear
    const importMsg = page.locator('#importMessage');
    await importMsg.waitFor({ state: 'visible', timeout: 10000 });

    // Wait until the import message shows success (not an error)
    await page.waitForFunction(
      () => {
        const el = document.getElementById('importMessage');
        if (!el) return false;
        const t = el.textContent || '';
        // Success states
        if (t.includes('Wallet restored') || t.includes('Syncing')) return true;
        // Error states — fail fast
        if (t.toLowerCase().includes('error') || t.toLowerCase().includes('timed out') ||
            t.includes('invalid') || t.includes('failed')) {
          throw new Error('Import failed: ' + t.trim());
        }
        return false;
      },
      null,
      { timeout: TIMEOUT_IMPORT }
    );

    // ── 5. The app auto-navigates to dashboard after restore ──────────────────
    const balanceEl = page.locator('#balanceUsdm');
    await balanceEl.waitFor({ state: 'visible', timeout: 20000 });

    // ── 6. Wait for balance to resolve from "…" to a real value ──────────────
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const t = el.textContent.trim();
        return t !== '' && t !== '…' && t !== 'Loading…';
      },
      '#balanceUsdm',
      { timeout: TIMEOUT_BALANCE }
    );

    const balanceText = (await balanceEl.textContent()).trim();
    console.log('Balance after import:', balanceText);

    // ── 7. Assert balance is a valid display value ────────────────────────────
    expect(
      isValidBalanceText(balanceText),
      `Balance should be "—" or a dollar amount, got: "${balanceText}"`
    ).toBe(true);

    // ── 8. Verify sync status banner appeared at some point ───────────────────
    // (it may have already cleared — just check it exists in the DOM)
    const syncBanner = page.locator('#syncStatusBanner');
    const bannerExists = await syncBanner.count();
    expect(bannerExists, 'Sync status banner element should exist').toBeGreaterThan(0);

    // ── 9. Click Refresh and confirm balance remains valid ────────────────────
    const refreshBtn = page.locator('#btnRefresh');
    if (await refreshBtn.count() > 0 && await refreshBtn.isVisible()) {
      await refreshBtn.click();
      await page.waitForFunction(
        (sel) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          const t = el.textContent.trim();
          return t !== '…' && t !== '';
        },
        '#balanceUsdm',
        { timeout: 60000 }
      );
      const balanceAfterRefresh = (await balanceEl.textContent()).trim();
      console.log('Balance after Refresh click:', balanceAfterRefresh);
      expect(
        isValidBalanceText(balanceAfterRefresh),
        `Balance after refresh should be valid, got: "${balanceAfterRefresh}"`
      ).toBe(true);
    }
  });

  test('import with invalid seed count shows error', async ({ page }) => {
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    const importNavBtn = page.locator('.nav-btn[data-page="import"]');
    await importNavBtn.waitFor({ state: 'visible', timeout: 15000 });
    await importNavBtn.click();

    await page.locator('#importSeed').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#importSeed').fill('only three words here');
    await page.locator('#btnImport').click();

    const msg = page.locator('#importMessage');
    await msg.waitFor({ state: 'visible', timeout: 5000 });
    const msgText = await msg.textContent();
    expect(msgText).toMatch(/seed must be|words/i);
  });

  test('import with empty seed shows error', async ({ page }) => {
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    const importNavBtn = page.locator('.nav-btn[data-page="import"]');
    await importNavBtn.waitFor({ state: 'visible', timeout: 15000 });
    await importNavBtn.click();

    await page.locator('#importSeed').waitFor({ state: 'visible', timeout: 10000 });
    // Leave seed empty
    await page.locator('#btnImport').click();

    const msg = page.locator('#importMessage');
    await msg.waitFor({ state: 'visible', timeout: 5000 });
    const msgText = await msg.textContent();
    expect(msgText).toMatch(/enter your.*seed/i);
  });
});
