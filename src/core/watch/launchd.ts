import { execFile } from 'node:child_process';
import { join } from 'node:path';

// macOS delivery: a user LaunchAgent that starts `watch run` four times a day (the first successful run
// per UTC day does the work, later ones exit at once; a run missed during sleep fires on wake), and a
// local notification through osascript. Nothing here is installed by the tests or by `watch run`:
// only `watch install`, which the owner runs.

export const LAUNCH_AGENT_LABEL = 'com.apify-insights.watch';
/** Local time of day (the Mac's time zone). */
export const DEFAULT_TIMES = ['05:45', '09:00', '13:00', '19:00'];

export function launchAgentPath(homeDir: string): string {
    return join(homeDir, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

function xml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function parseTimes(spec: string | undefined): Array<{ hour: number; minute: number }> {
    const list = spec ? spec.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_TIMES;
    return list.map((t) => {
        const match = /^(\d{1,2}):(\d{2})$/.exec(t);
        const hour = Number(match?.[1]);
        const minute = Number(match?.[2]);
        if (!match || hour > 23 || minute > 59) throw new Error(`Not a time of day (HH:MM): ${t}`);
        return { hour, minute };
    });
}

export interface PlistOptions {
    nodePath: string;
    entryPath: string;
    home: string;
    times?: Array<{ hour: number; minute: number }>;
}

/** The LaunchAgent plist. The feature flag is baked in, so the job runs only because the owner installed it. */
export function launchAgentPlist(options: PlistOptions): string {
    const times = options.times ?? parseTimes(undefined);
    const args = [options.nodePath, options.entryPath, 'watch', 'run', '--experimental'];
    const log = join(options.home, 'watch', 'launchd.log');
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '    <key>Label</key>',
        `    <string>${LAUNCH_AGENT_LABEL}</string>`,
        '    <key>ProgramArguments</key>',
        '    <array>',
        ...args.map((arg) => `        <string>${xml(arg)}</string>`),
        '    </array>',
        '    <key>EnvironmentVariables</key>',
        '    <dict>',
        '        <key>APIFY_INSIGHTS_HOME</key>',
        `        <string>${xml(options.home)}</string>`,
        '        <key>APIFY_INSIGHTS_WATCH</key>',
        '        <string>1</string>',
        '    </dict>',
        '    <key>StartCalendarInterval</key>',
        '    <array>',
        ...times.flatMap((t) => ['        <dict>', '            <key>Hour</key>', `            <integer>${t.hour}</integer>`, '            <key>Minute</key>', `            <integer>${t.minute}</integer>`, '        </dict>']),
        '    </array>',
        '    <key>RunAtLoad</key>',
        '    <false/>',
        '    <key>ProcessType</key>',
        '    <string>Background</string>',
        '    <key>StandardOutPath</key>',
        `    <string>${xml(log)}</string>`,
        '    <key>StandardErrorPath</key>',
        `    <string>${xml(log)}</string>`,
        '</dict>',
        '</plist>',
        '',
    ].join('\n');
}

/** AppleScript string literal. */
function appleString(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;
}

export function notificationScript(title: string, message: string): string {
    return `display notification ${appleString(message)} with title ${appleString(title)}`;
}

export type Notifier = (title: string, message: string) => Promise<boolean>;

/** Shows a macOS notification. Never throws; false when it could not be shown (not macOS, no osascript). */
export const osascriptNotifier: Notifier = (title, message) =>
    new Promise((resolve) => {
        if (process.platform !== 'darwin') return resolve(false);
        execFile('osascript', ['-e', notificationScript(title, message)], { timeout: 10_000 }, (error) => resolve(!error));
    });
