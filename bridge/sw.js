// Apify Insights Bridge: hands a fresh Console UI token to the local apify-insights-mcp server,
// but only while the MCP actually wants one (design: actorstack .omc/plans/apify-insights-mcp.md §4).
//
// Each 1-minute alarm runs one cycle of two one-shot native messages:
//   1. {op:"wanted?"}  -> the host says whether a private tool ran in the last 10 minutes.
//   2. only if wanted: POST resume with the browser's own Console cookies, then
//      {op:"write", uiToken, userId, profileId} -> the host stores it in a 0600 file.
// One-shot sendNativeMessage (not connectNative) because MV3 service workers are suspended
// ~30 s after an alarm handler returns, which would cut a long-lived port mid-write.
//
// The UI token exists only in local variables of one cycle: it is never logged and never put in
// chrome.storage. Logs carry HTTP status codes and error messages only.

const HOST = 'com.apify_insights.bridge';
const RESUME_URL = 'https://console-backend.apify.com/public/authentication/resume';
const ALARM = 'refresh';

// Skip a cycle while the previous one is still running (slow network, host start-up).
let inFlight = false;

chrome.runtime.onInstalled.addListener(() => ensureAlarm());
chrome.runtime.onStartup.addListener(() => ensureAlarm());
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) runCycle();
});
ensureAlarm();

async function ensureAlarm() {
    // create() would restart the period on every service-worker wake, so only create when missing.
    if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}

// A random id per Chrome profile, so two profiles (maybe two Apify accounts) write separate files.
async function profileId() {
    const stored = await chrome.storage.local.get('profileId');
    if (typeof stored.profileId === 'string' && /^[a-z0-9-]{8,64}$/.test(stored.profileId)) return stored.profileId;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ profileId: id });
    return id;
}

async function runCycle() {
    if (inFlight) return;
    inFlight = true;
    try {
        await cycle();
    } catch (error) {
        console.warn('[bridge] cycle failed:', error?.message ?? String(error));
    } finally {
        inFlight = false;
    }
}

async function cycle() {
    const wanted = await chrome.runtime.sendNativeMessage(HOST, { op: 'wanted?' });
    if (wanted?.wanted !== true) return;

    // Personal context only: empty viewedUserId and forceAdminToken false are a hard rule
    // (never another user's context). Console rejects any other body shape with 400.
    const response = await fetch(RESUME_URL, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewedUserId: '', forceAdminToken: false }),
        signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
        // 401 = not logged in to Console in this profile; nothing to hand over.
        console.warn('[bridge] resume returned HTTP', response.status);
        return;
    }
    const body = await response.json().catch(() => null);
    const uiToken = body?.uiToken;
    const userId = body?.userId;
    if (typeof uiToken !== 'string' || typeof userId !== 'string') {
        console.warn('[bridge] resume reply had no token');
        return;
    }

    const reply = await chrome.runtime.sendNativeMessage(HOST, { op: 'write', uiToken, userId, profileId: await profileId() });
    if (reply?.ok !== true) console.warn('[bridge] host refused the write:', reply?.error ?? 'no reply');
}
