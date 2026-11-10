export const GLOSSARY = `# Apify Insights glossary

Definitions used by every tool in this server. Repeat numbers as they are given; do not estimate missing ones.

- **Users (7d / 30d / 90d)**: distinct users who ran the actor in that window, from public Store stats. Matches the actor's Store page. A user of two actors counts once per actor, so per-actor counts do not add up to a portfolio total.
- **Users' runs (30d)**: runs started by other users in the last 30 days. Your own runs are not included.
- **Failure rate**: (failed + timed-out) ÷ all runs. Aborted runs are excluded because users often abort on purpose. Same rule as the Apify Insights Plus extension.
- **failing**: at least 3 failed or timed-out runs and a failure rate of 5% or more.
- **flagged**: Apify has set a notice on the actor (for example UNDER_MAINTENANCE). The actor is pulled from Store search until the notice is cleared.
- **Private actor**: not listed in the Store. Public stats are empty, so users and run results show as null.
- **null**: the value is not available from the source this tool used. A note says why. It never means zero.
- **Revenue, cost, profit**: as the Apify Console shows them, from Console analytics (unofficial; needs the Console session). Profit = revenue − cost.
- **Paying users / audience**: "paying" counts only money from users on paid plans (what you earn). "all" adds free-plan users and exists for account totals only. Per-actor money is always paying users.
- **Per-actor periods**: per-actor money exists per calendar month. For day ranges, only named actors (max 10) or your top 10 earners are covered.
- **Cost per 1K results**: cost ÷ all results × 1000. **Revenue per 1K**: revenue ÷ charged results × 1000.
- **Break-even price**: current price × cost ÷ revenue, the price at which this month's paying-users revenue would have equalled cost, assuming the same usage.
- **Materiality**: 1% of the monthly profit pace (at least $1). Money rules ignore amounts below it, so tiny actors do not crowd the list. **Loss floor**: the larger of $0.25 and materiality ÷ 4.
- **losing**: profit at or below minus the loss floor. **thin_margin**: revenue at or above materiality at under 30% margin. **below_cost**: cost per 1K results above revenue per 1K. **no_revenue**: 10+ runs and a paying user but $0 revenue on a charging actor (often an event the code never charges).
- **declining / growing**: revenue per day this month vs last month changed by 25%+ and by at least materiality per month. Needs 7+ days of the month.
- **Revenue at risk**: revenue × failure rate.
- **Runs per day** (run_health \`byDay\`): failed, timed-out and aborted runs per UTC calendar day from Console run statistics, counting every run of the actor. The rest of run_health uses the public rolling 30 days of users' runs, so totals can differ. **Today** is partial (the day has not ended); a period that ends before today reports it separately and never adds it to the period totals.
- **Problem day**: a day with at least one failed or timed-out run. **Worst day**: the day with the most (the later one on a tie). Aborted runs never count.
- **Shared runs**: runs users chose to share with you. Only these can be opened, so their logs are a sample; the counts come from run statistics and cover every run. **buildBeforeFirstProblem**: the newest successful build that finished before the first problem day in the period, a fact to check rather than a proven cause.
- **Viewers, input-page views, users with a run** (growth, acquisition_score): from Console analytics (\`monthly-marketing\`), unique per month. Both tools use the same field names and values: \`viewingUsers\` (viewed the Store page), \`consolePageViews\` (opened the input page), \`usersWithRun\`, and \`viewToRunPct\` = users with a run ÷ viewers. viewToRunPct can exceed 100% because users can run an actor (API, schedules) without viewing its page that month.
- **growth vs acquisition_score**: growth gives the raw counts, paying users, referrers and countries. acquisition_score gives each actor's bucket, the reason and what to do.
- **Acquisition buckets** (acquisition_score), first match wins: **Leaking** (viewers ≥ leakFloor but under 2 start, or conversion in your bottom quarter: fix the listing), **Rising** (viewers up 30%+ and by 5+ vs the same point last month: market it more), **Fading** (viewers down 25%+ and by 5+: find out why), **Converting** (2+ start and conversion in your top quarter: double down), **Steady** (enough viewers, no strong signal), **Quiet** (too few viewers to judge). Same rules as the Apify Insights Plus extension.
- **viewerFloor / leakFloor**: thresholds relative to the scanned actors. viewerFloor = max(3, 25th percentile of viewers), leakFloor = max(10, median). Conversion quarters are computed among actors at or above viewerFloor, with conversion capped at 100%. Changing \`top\` changes the scanned set, so it can move an actor between buckets.
- **Same point last month**: for the current month, last month's counts scaled to the share of this month that has fully passed (Apify's own comparison: on day 20 of a 30-day month, 19/30 of last month). A past month is compared with the whole month before it.
- **Early month**: before day 8, Rising and Fading are not judged, because the change since the same point last month is too noisy.
- **Quality score** (actor_quality): Apify's quality score (shown as %) and its percentile among Store actors, with sub-scores when Apify returns them. **pending**: no real score yet, because the actor is not public in the Store (unpublished) or Apify has not scored it (unscored).
- **Quality work types**: security (weight 5), operations (4), schema (3), pricing (2), listing & docs (1), other (1). Market suggestions (rating, total users, weight 0.5) are not work you can do and are not listed across actors.
- **Quality impact**: work-type weight × traffic weight. Traffic weight = max(1, revenue × 100 + runs × 0.1 + paying users × 10 + users × 0.5), each the larger of last month and this month's pace (pace from day 8). Across actors, the top 20% of suggestions by impact are **high**, the next 30% **medium**, the rest **low**; actors with no traffic are always low.
`;
