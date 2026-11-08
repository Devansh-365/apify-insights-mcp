import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Every tool answers with the same envelope (plan §7): totals first, top-N rows, what was left out,
// and notes. Missing values are null with a note, never 0 or a placeholder.

export type Source = 'apify-api' | 'console (unofficial)';

export interface Envelope {
    asOf: string;
    source: Source[];
    period?: { label: string; from?: string; to?: string; partial?: boolean };
    totals?: Record<string, unknown>;
    rows?: unknown[];
    omitted?: { rows: number; hint: string };
    notes: string[];
    [key: string]: unknown;
}

export type ErrorCode =
    | 'public_auth_missing'
    | 'public_api_error'
    | 'bridge_missing'
    | 'logged_out'
    | 'warming_up'
    | 'other_account'
    | 'endpoint_changed'
    | 'disabled'
    | 'actor_not_found'
    | 'actor_ambiguous'
    | 'period_invalid'
    | 'granularity_unavailable';

export class ToolError extends Error {
    constructor(
        readonly code: ErrorCode,
        message: string,
        readonly fix: string,
        readonly details?: Record<string, unknown>,
    ) {
        super(message);
    }
}

export function ok(summary: string, envelope: Envelope): CallToolResult {
    return {
        content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(envelope)}` }],
        structuredContent: envelope,
    };
}

export function fail(error: ToolError): CallToolResult {
    const body = { ok: false, code: error.code, message: error.message, fix: error.fix, ...(error.details ?? {}) };
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
}

export function round(value: number | null | undefined, digits = 2): number | null {
    if (value == null || !Number.isFinite(value)) return null;
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

export function topN<T>(rows: T[], top: number, hint: string): { rows: T[]; omitted?: { rows: number; hint: string } } {
    if (rows.length <= top) return { rows };
    return { rows: rows.slice(0, top), omitted: { rows: rows.length - top, hint } };
}
