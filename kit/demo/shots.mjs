#!/usr/bin/env node
// The demo site's browser (kit/demo/demo.sh), muted, through its Traefik (demo.test mapped to this Mac, Traefik's own
// certificate accepted) as a visitor arriving through Cloudflare:
//   node kit/demo/shots.mjs visit <post slug>            one visit (a real page hit for visits.py to copy)
//   GRAFANA_PASSWORD=… node kit/demo/shots.mjs shots <dir>   the screenshots, as <dir>/*.png
import { chromium } from '../theme-test/node_modules/playwright/index.mjs';

const [mode, arg] = process.argv.slice(2);
const BASE = 'https://demo.test';
const GRAFANA = 'http://grafana.localhost';
const browser = await chromium.launch({ args: [
    '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    '--host-resolver-rules=MAP demo.test 127.0.0.1, MAP live.demo.test 127.0.0.1, MAP grafana.localhost 127.0.0.1',
] });
const visitor = (extra = {}) => browser.newContext({
    ignoreHTTPSErrors: true, timezoneId: 'Etc/UTC',
    // Ghost's tracker skips automated browsers, so it looks like a visitor's Chrome
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'CF-Connecting-IP': '203.0.113.7', 'CF-IPCountry': 'DE' },
    ...extra,
});
const settle = page => page.waitForLoadState('networkidle').catch(() => {});
try {
    if (mode === 'visit') {
        const ctx = await visitor();
        await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
        const page = await ctx.newPage();
        const hit = page.waitForResponse(r => r.url().includes('/.ghost/analytics/'), { timeout: 20000 });
        await page.goto(`${BASE}/${arg}/`);
        console.log((await hit).status());
    } else if (mode === 'shots') {
        const dir = arg;
        // The home page with the LIVE NOW bar, on a laptop and a phone
        for (const [name, viewport, scale] of [['site', { width: 1280, height: 1100 }, 1], ['phone', { width: 390, height: 844 }, 2]]) {
            const ctx = await visitor({ viewport, deviceScaleFactor: scale, isMobile: name === 'phone' });
            const page = await ctx.newPage();
            await page.goto(`${BASE}/`);
            await page.locator('#live-now').waitFor({ state: 'visible', timeout: 20000 });
            await settle(page);
            await page.waitForTimeout(1500);
            await page.screenshot({ path: `${dir}/${name}.png` });
            await ctx.close();
        }
        // Grafana's dashboards (kiosk: no menus); Health only its tiles (Docker Desktop hides containers from cAdvisor)
        const auth = 'Basic ' + Buffer.from(`admin:${process.env.GRAFANA_PASSWORD}`).toString('base64');
        const graf = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { Authorization: auth } });
        const page = await graf.newPage();
        for (const [name, uid, range, clip] of [['traffic', 'demo-traffic', 'from=now-30d&to=now'],
                                                ['overview', 'demo-overview', 'from=now-30d&to=now'],
                                                ['health', 'demo-health', 'from=now-1h&to=now', { x: 0, y: 0, width: 1440, height: 440 }]]) {
            await page.goto(`${GRAFANA}/d/${uid}?orgId=1&kiosk&${range}`);
            await settle(page);
            await page.waitForTimeout(4000);
            await page.screenshot({ path: `${dir}/${name}.png`, ...(clip ? { clip } : {}) });
        }
    } else {
        throw new Error('usage: shots.mjs visit <slug> | shots <dir>');
    }
} finally {
    await browser.close();
}
