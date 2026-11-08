// Phase 0 spike. Answers: can an MV3 service worker get a Console UI token on its own (G1),
// does that token read analytics (G2), how long does a token live (G3), and does refreshing
// every minute keep the Console session alive (G4)?
// The UI token never leaves the browser: it lives in chrome.storage.session (memory only) and
// only token-free measurements are sent to the native host, which writes them to a local file.

const HOST = 'com.apify_insights.phase0';
const BACKEND = 'https://console-backend.apify.com';
const MAX_CYCLES = 35;

chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create('cycle', { periodInMinutes: 1 });
    cycle('installed');
});
chrome.runtime.onStartup.addListener(() => cycle('startup'));
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'cycle') cycle('alarm');
});

function currentMonth() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function jwtInfo(token) {
    const parts = token.split('.');
    if (parts.length !== 3) return { isJwt: false };
    try {
        const json = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        return {
            isJwt: true,
            claimKeys: Object.keys(json).sort(),
            iat: json.iat ? new Date(json.iat * 1000).toISOString() : null,
            exp: json.exp ? new Date(json.exp * 1000).toISOString() : null,
            lifetimeSec: json.exp && json.iat ? json.exp - json.iat : null,
        };
    } catch {
        return { isJwt: true, decodeFailed: true };
    }
}

async function readJson(response) {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

async function analyticsProbe(token) {
    const started = Date.now();
    const response = await fetch(`${BACKEND}/actor-analytics/profit-margin?month=${currentMonth()}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const body = await readJson(response);
    const totals = body?.totalProfitMarginStats;
    return {
        status: response.status,
        ms: Date.now() - started,
        errorCode: body?.errorCode ?? null,
        topLevelKeys: body && typeof body === 'object' ? Object.keys(body).slice(0, 12) : null,
        // The owner's own monthly totals, so G2 can be compared with the Console Monetization page.
        totals: totals ?? null,
    };
}

async function resume() {
    const attempts = [];
    // Same body Console sends: empty viewedUserId = the logged-in user's own context.
    for (const init of [
        {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ viewedUserId: '', forceAdminToken: false }),
        },
    ]) {
        const started = Date.now();
        const response = await fetch(`${BACKEND}/public/authentication/resume`, init);
        const body = await readJson(response);
        attempts.push({ status: response.status, ms: Date.now() - started, errorCode: body?.errorCode ?? null });
        if (response.ok && body?.uiToken) return { attempts, body };
        if (response.status === 401) break;
    }
    return { attempts, body: null };
}

async function send(message) {
    const started = Date.now();
    try {
        const reply = await chrome.runtime.sendNativeMessage(HOST, message);
        return { ok: true, ms: Date.now() - started, reply };
    } catch (error) {
        return { ok: false, ms: Date.now() - started, error: String(error?.message ?? error) };
    }
}

async function cycle(trigger) {
    const local = await chrome.storage.local.get(['cycles']);
    const cycles = (local.cycles ?? 0) + 1;
    if (cycles > MAX_CYCLES) {
        await chrome.alarms.clear('cycle');
        return;
    }
    await chrome.storage.local.set({ cycles });

    const session = await chrome.storage.session.get(['firstToken', 'firstAt', 'firstDeadAfterSec']);
    const report = { cycle: cycles, trigger, at: new Date().toISOString() };

    try {
        const consoleTabs = await chrome.tabs.query({ url: 'https://console.apify.com/*' });
        report.consoleTabsOpen = consoleTabs.length;
    } catch (error) {
        report.consoleTabsOpen = `unknown: ${error?.message ?? error}`;
    }

    report.nativePing = await send({ op: 'ping' });

    try {
        const { attempts, body } = await resume();
        report.resume = attempts;
        report.gotUiToken = Boolean(body?.uiToken);
        if (body?.uiToken) {
            const token = body.uiToken;
            report.uiToken = { length: token.length, dots: token.split('.').length - 1, ...jwtInfo(token) };
            report.resumeTokenExpiresAt = body.resumeToken?.expiresAt ?? null;
            report.responseKeys = Object.keys(body).sort();
            report.userIdPresent = Boolean(body.userId);
            report.analyticsWithFreshToken = await analyticsProbe(token);
            if (!session.firstToken) {
                await chrome.storage.session.set({ firstToken: token, firstAt: Date.now() });
            }
        }
    } catch (error) {
        report.resumeError = String(error?.message ?? error);
    }

    // G3: keep probing the very first token until it stops working.
    if (session.firstToken && session.firstDeadAfterSec === undefined) {
        try {
            const probe = await analyticsProbe(session.firstToken);
            const ageSec = Math.round((Date.now() - session.firstAt) / 1000);
            report.firstToken = { ageSec, status: probe.status, errorCode: probe.errorCode };
            if (probe.status === 401 || probe.status === 400 || probe.status === 403) {
                await chrome.storage.session.set({ firstDeadAfterSec: ageSec });
                report.firstToken.diedAfterSec = ageSec;
            }
        } catch (error) {
            report.firstToken = { error: String(error?.message ?? error) };
        }
    } else if (session.firstDeadAfterSec !== undefined) {
        report.firstToken = { diedAfterSec: session.firstDeadAfterSec };
    }

    report.nativeWrite = await send({ op: 'report', report });
    console.log('[phase0]', report);
}
