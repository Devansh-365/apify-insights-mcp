export const GLOSSARY = `# Apify Insights glossary

Definitions used by every tool in this server. Repeat numbers as they are given; do not estimate missing ones.

- **Users (7d / 30d / 90d)**: distinct users who ran the actor in that window, from public Store stats. Matches the actor's Store page. A user of two actors counts once per actor, so per-actor counts do not add up to a portfolio total.
- **Users' runs (30d)**: runs started by other users in the last 30 days. Your own runs are not included.
- **Failure rate**: (failed + timed-out) ÷ all runs. Aborted runs are excluded because users often abort on purpose. Same rule as the Apify Insights Plus extension.
- **failing**: at least 3 failed or timed-out runs and a failure rate of 5% or more.
- **flagged**: Apify has set a notice on the actor (for example UNDER_MAINTENANCE). The actor is pulled from Store search until the notice is cleared.
- **Private actor**: not listed in the Store. Public stats are empty, so users and run results show as null.
- **null**: the value is not available from the source this tool used. A note says why. It never means zero.
- **Revenue, cost, profit, paying users**: come from the Apify Console (unofficial) and need the Console session. Not available in this version.
`;
