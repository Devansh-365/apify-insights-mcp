import type { Marketing } from '../clients/console.js';
import { round } from './envelope.js';

// The view-to-run numbers shared by `growth` and `acquisition_score`. Both tools output these fields
// from this one function, so for the same actor and month they cannot disagree.

// A type alias (not an interface) so it fits the envelope's Record<string, unknown> fields.
export type Funnel = {
    storePageViews: number;
    consolePageViews: number;
    viewingUsers: number;
    usersWithRun: number;
    /** Not capped: users can run an actor (API, schedules) without viewing its page that month. */
    viewToRunPct: number | null;
};

export function funnel(data: Marketing): Funnel {
    const viewers = data.numUniqueViewingUsers;
    return {
        storePageViews: data.numUniqueWebPageViews,
        consolePageViews: data.numUniqueConsolePageViews,
        viewingUsers: viewers,
        usersWithRun: data.numUniqueUsersWithRun,
        viewToRunPct: viewers > 0 ? round((data.numUniqueUsersWithRun / viewers) * 100, 1) : null,
    };
}
