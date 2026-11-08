# Tools

| Tool | Answers |
|---|---|
| `daily_brief` | How did I do yesterday and this month so far vs the same days last month, and which three actors should I look at, each with the rule that flagged it. |
| `revenue_summary` | Revenue, cost, profit and margin for any period (yesterday, last7d, a month, a date range), optionally compared with the previous period. Paying users or all users. |
| `actor_profitability` | Money per actor for a month: top, losers, movers, no_revenue, below_cost. Includes cost and revenue per 1,000 results and the break-even price. |
| `run_health` | Which actors need attention: flagged by Apify (hidden from Store search), failing, or charging nothing. With money: revenue at risk. |
| `actor_report` | One actor in depth: users, run results, flags, price, default memory and timeout, latest build, reviews, local source folder, last three months of money. |
| `growth` | Views to runs to paying users for a month, per actor; one actor adds top referrers and countries. |
| `list_actors` | My actors with users (7/30 days), users' runs and failure rate, last run, Apify notice. |
| `store_rank` | My positions in Apify Store search for up to 10 keywords, and who ranks above. |
| `competitor_benchmark` | My public portfolio vs another creator's. |
| `auth_status` | Is the token working, for which account, and is a Console session connected? |

Prompts: `morning-brief`, `loss-hunt`, `health-check`. The resource `apify-insights://glossary` defines every metric and rule.

## Rules

- **Money** is what the Apify Console shows. Per-actor money is paying users only and exists per calendar month; day ranges per actor cover only named actors or your top 10 earners.
- **failing**: at least 3 failed or timed-out runs and a 5% or higher failure rate in users' runs over 30 days. Aborted runs do not count.
- **flagged**: Apify has put a notice on the actor, such as "under maintenance".
- **losing / thin_margin / below_cost / no_revenue / declining / growing**: see the glossary; thresholds scale with your portfolio (1% of the monthly profit pace, at least $1).
- A missing value is `null`, with a note saying why. It never means zero.
