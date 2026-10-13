#!/usr/bin/env node
// kit/test.sh's browser: visits the test kit site through its Traefik (kit.test and live.kit.test mapped to this Mac,
// Traefik's own certificate accepted), as a visitor arriving through Cloudflare (CF-Connecting-IP, CF-IPCountry) whose
// browser says UTC, so Ghost's tracker leaves the country to Traefik's page-hit-country plugin. Muted.
//   node kit/theme-test/kit-site.mjs <published post slug> <draft uuid>
// Prints one JSON line: what it saw and which beacons went out.
import { chromium } from 'playwright';

const [slug, draftUuid] = process.argv.slice(2);
const BASE = 'https://kit.test';
const browser = await chromium.launch({ args: [
    '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    '--host-resolver-rules=MAP kit.test 127.0.0.1, MAP live.kit.test 127.0.0.1',
] });
const out = { errors: [], beacons: [] };
try {
    const context = await browser.newContext({
        ignoreHTTPSErrors: true, timezoneId: 'Etc/UTC',
        // Ghost's tracker skips automated browsers and its analytics service drops headless ones, so it looks like a
        // visitor's Chrome
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        extraHTTPHeaders: { 'CF-Connecting-IP': '203.0.113.7', 'CF-IPCountry': 'CA' },
    });
    await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
    await context.route('https://example.org/**', r => r.fulfill({ contentType: 'text/html', body: '<p>elsewhere</p>' }));
    const page = await context.newPage();
    page.on('pageerror', e => out.errors.push(e.message));
    // the beacons the theme sends (they go on to the bridge as they are: only watched here)
    page.on('request', r => { if (r.url().includes('/.site/click')) out.beacons.push(r.url().replace(BASE, '')); });
    const hits = [];
    page.on('response', r => { if (r.url().includes('/.ghost/analytics/')) hits.push(r.status()); });

    await page.goto(`${BASE}/`);
    await page.locator('#live-now').waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
    out.barVisible = await page.locator('#live-now').isVisible();
    out.track = (await page.locator('.live-bar__track').textContent().catch(() => '')) || '';
    if (out.barVisible) {
        await page.locator('.live-bar__play').click();
        // the player holds back a cushion before it plays; playing = time moving on
        await page.waitForFunction(() => { const a = document.querySelector('#live-now audio'); return a && a.currentTime > 0.5; },
            null, { timeout: 30000 }).then(() => { out.played = true; }, () => { out.played = false; });
    }
    await page.goto(`${BASE}/${slug}/`);
    await page.locator('a[href^="https://example.org/"]').click();
    await page.waitForTimeout(1500);
    await page.goto(`${BASE}/p/${draftUuid}/`);
    out.previewButton = await page.locator('a.kit-preview-button').count() === 1;
    out.pageHits = hits;
} finally {
    await browser.close();
}
console.log(JSON.stringify(out));
