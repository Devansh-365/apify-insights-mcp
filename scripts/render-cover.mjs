// Renders docs/assets/cover.html to docs/assets/cover.png at 2x with a transparent background, so the
// rounded corners stay rounded on GitHub's light and dark themes. Needs Google Chrome; no npm packages.
//   node scripts/render-cover.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [width, height, scale] = [1200, 360, 2];
const page = `file://${resolve('docs/assets/cover.html')}`;
const profile = await mkdtemp(join(tmpdir(), 'cover-'));

const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--hide-scrollbars', 'about:blank'], {
    stdio: ['ignore', 'ignore', 'pipe'],
});
try {
    // Chrome prints its DevTools websocket URL on stderr.
    const browserUrl = await new Promise((done, fail) => {
        let buffer = '';
        chrome.stderr.on('data', (chunk) => {
            buffer += chunk;
            const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
            if (match) done(match[1]);
        });
        chrome.on('exit', () => fail(new Error('Chrome exited before it was ready')));
    });
    const { port } = new URL(browserUrl);
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(page)}`, { method: 'PUT' })).json();

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((done) => socket.addEventListener('open', done, { once: true }));
    let nextId = 0;
    const pending = new Map();
    socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        pending.get(message.id)?.(message);
    });
    const send = (method, params = {}) =>
        new Promise((done, fail) => {
            const id = ++nextId;
            pending.set(id, (message) => (message.error ? fail(new Error(message.error.message)) : done(message.result)));
            socket.send(JSON.stringify({ id, method, params }));
        });

    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await send('Page.navigate', { url: page });
    // Wait for the web fonts, then one more frame.
    await send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => r())))', awaitPromise: true });
    const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } });
    await writeFile('docs/assets/cover.png', Buffer.from(data, 'base64'));
    console.log(`docs/assets/cover.png (${width * scale}x${height * scale})`);
    socket.close();
} finally {
    // Let Chrome finish writing its profile before deleting it.
    const exited = new Promise((done) => chrome.once('exit', done));
    chrome.kill();
    await exited;
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
