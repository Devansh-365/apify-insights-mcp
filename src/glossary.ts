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
`;
