// Phase 0, gate G5: can a dedicated login window (system Chrome, its own profile) mint a UI token
// that reads analytics? You log in yourself in the window; this script never sees your password.
// It prints and saves only token-free measurements.
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OUT_DIR = join(homedir(), '.apify-insights', 'phase0');
const PROFILE_DIR = join(OUT_DIR, 'login-profile');
const BACKEND = 'https://console-backend.apify.com';
const WAIT_MS = 10 * 60 * 1000;

mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });

const month = (() => {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
})();

const context = await chromium.launchPersistentContext(PROFILE_DIR, { channel: 'chrome', headless: false, viewport: null });
const page = context.pages()[0] ?? (await context.newPage());
await page.goto('https://console.apify.com/');
console.log('A Chrome window opened. Log in to Apify there (password, 2FA or Google/GitHub). Waiting up to 10 minutes...');

const report = { startedAt: new Date().toISOString(), resumeStatuses: [] };
const deadline = Date.now() + WAIT_MS;
let token = null;
while (Date.now() < deadline && !token) {
    try {
        const result = await page.evaluate(async (backend) => {
            const response = await fetch(`${backend}/public/authentication/resume`, { method: 'POST', credentials: 'include' });
            let body = null;
            try {
                body = await response.json();
            } catch {}
            return {
                status: response.status,
                errorCode: body?.errorCode ?? null,
                uiToken: body?.uiToken ?? null,
                resumeTokenExpiresAt: body?.resumeToken?.expiresAt ?? null,
            };
        }, BACKEND);
        const last = report.resumeStatuses.at(-1);
        if (!last || last.status !== result.status) report.resumeStatuses.push({ status: result.status, errorCode: result.errorCode, at: new Date().toISOString() });
        if (result.uiToken) {
            token = result.uiToken;
            report.loggedInAt = new Date().toISOString();
            report.resumeTokenExpiresAt = result.resumeTokenExpiresAt;
        }
    } catch {
        // The page is navigating during login; try again shortly.
    }
    if (!token) await new Promise((resolve) => setTimeout(resolve, 5000));
}

if (token) {
    const parts = token.split('.');
    report.uiToken = { length: token.length, dots: parts.length - 1 };
    if (parts.length === 3) {
        try {
            const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
            report.uiToken.claimKeys = Object.keys(claims).sort();
            if (claims.iat && claims.exp) report.uiToken.lifetimeSec = claims.exp - claims.iat;
            if (claims.exp) report.uiToken.exp = new Date(claims.exp * 1000).toISOString();
        } catch {}
    }
    // The real MCP calls the backend from Node, not from the page, so test exactly that.
    const response = await fetch(`${BACKEND}/actor-analytics/profit-margin?month=${month}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    let body = null;
    try {
        body = await response.json();
    } catch {}
    report.analyticsFromNode = {
        status: response.status,
        errorCode: body?.errorCode ?? null,
        topLevelKeys: body && typeof body === 'object' ? Object.keys(body).slice(0, 12) : null,
        totals: body?.totalProfitMarginStats ?? null,
    };
} else {
    report.result = 'no token within 10 minutes';
}

await context.close();
token = null;
writeFileSync(join(OUT_DIR, 'login-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
