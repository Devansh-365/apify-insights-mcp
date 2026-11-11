# Tools

| Tool | Answers |
|---|---|
| `daily_brief` | How did I do yesterday and this month so far vs the same days last month, and which three actors should I look at, each with the rule that flagged it. |
| `revenue_summary` | Revenue, cost, profit and margin for any period (yesterday, last7d, a month, a date range), optionally compared with the previous period. Paying users or all users. |
| `actor_profitability` | Money per actor for a month: top, losers, movers, no_revenue, below_cost. Includes cost and revenue per 1,000 results and the break-even price. |
| `run_health` | Which actors need attention: flagged by Apify (hidden from Store search), failing, or charging nothing. With money: revenue at risk. With `period`: failed, timed-out and aborted runs per day (today included) and the actors behind them; with `actor` too, the failed runs users shared, their log tails, recent builds and the build before the failures began. |
| `actor_report` | One actor in depth: users, run results, flags, price, default memory and timeout, latest build, reviews, local source folder, last three months of money. |
| `growth` | Views to runs to paying users for a month, per actor; one actor adds top referrers and countries. |
| `acquisition_score` | Which actors need attention for acquisition and what to do: Leaking, Rising, Fading, Converting, Steady or Quiet, against the same point last month and your other actors, with the reason. Same numbers and field names as `growth`. |
| `actor_quality` | Apify's quality scores and the highest-impact suggestions across your actors (security, operations, schema, pricing, listing), or one actor's score, praises and suggestions. |
| `list_actors` | My actors with users (7/30 days), users' runs and failure rate, last run, Apify notice. |
| `store_rank` | My positions in Apify Store search for up to 10 keywords, and who ranks above. |
| `competitor_benchmark` | My public portfolio vs another creator's. |
| `auth_status` | Is the token working, for which account, and is a Console session connected? |

Prompts: `morning-brief`, `loss-hunt`, `health-check`, `funnel-check`, `quality-review`. The resource `apify-insights://glossary` defines every metric and rule.

## Rules

- **Money** is what the Apify Console shows. Per-actor money is paying users only and exists per calendar month; day ranges per actor cover only named actors or your top 10 earners.
- **failing**: at least 3 failed or timed-out runs and a 5% or higher failure rate in users' runs over 30 days. Aborted runs do not count.
- **Runs per day** (`run_health` with `period`): UTC calendar days from the Console, every run counted, today partial. A period that ends before today reports today separately. Counts can differ from the 30-day numbers, which are public stats of users' runs. Log tails are shown to your AI client only and never saved; only runs users shared have logs.
- **flagged**: Apify has put a notice on the actor, such as "under maintenance".
- **losing / thin_margin / below_cost / no_revenue / declining / growing**: see the glossary; thresholds scale with your portfolio (1% of the monthly profit pace, at least $1).
- **Acquisition buckets**, first match wins: Leaking (enough viewers, few start: fix the listing), Rising (viewers up 30%+: market it more), Fading (viewers down 25%+: find out why), Converting (top-quarter conversion: double down), Steady, Quiet (too few viewers). Thresholds come from the actors scanned (your top 20 by 30-day users unless you pass `top`). Rising and Fading wait until day 8 of the month.
- **Quality impact**: work-type weight (security 5, operations 4, schema 3, pricing 2, listing 1) times the actor's traffic. Across actors, the top 20% of suggestions are high, the next 30% medium.
- **Portfolio scans**: an actor whose data fails to load is left out and named in the notes, never shown with zeros.
- A missing value is `null`, with a note saying why. It never means zero.
- **Cached money**: a finished month may come from the local cache (up to 24 hours old). The notes then say which months and when they were fetched.

## Early warning (experimental)

Off by default. Set `APIFY_INSIGHTS_WATCH=1` in the server's environment to register `decline_watch` and add one line to `daily_brief`; the CLI takes `--experimental` instead.

| Command | Does |
|---|---|
| `watch backfill --experimental` | One time: day-level money and runs for the last 63 days, one Console request at a time. |
| `watch run --experimental` | One snapshot and rule pass. The first run lists existing problems as a silent backlog. |
| `watch status --experimental` | Last run, errors, open alerts. Exit code 1 when the last run had errors. |
| `watch snooze <actor> [--rule R4] --days 7 --experimental` | Stops notifications for that actor (it stays in the digest). |
| `watch replay --experimental --from YYYY-MM-DD [--to ...] [--actor a,b] [--explain actor@day]` | Re-runs the rules over stored data, one run per day, to see when each actor would have paged. |
| `watch install --experimental [--print] [--times 05:45,09:00,13:00,19:00]` | Writes and loads a LaunchAgent. `--print` only shows it. `watch uninstall` removes it. |

- **PAGE** notifies when new or 50% worse (at most once a day, one reminder after 14 days). **WATCH** and info appear only in the digest.
- Money is paying-users money. Run counts cover every run of the actor; R4 subtracts your own runs where the run list has them (the list keeps only recent runs, so older windows are not netted).
- Thresholds: R1 steady actors -35% vs the 8-week median with a $5/week floor; R4 5 failures and a 10% rate (fast path: 5 failures and 25% over 2 days); R7 a $1 loss in 24 hours. They are a starting point to review after 4 weeks.
- Files live in `~/.apify-insights/watch/` (folders 0700, files 0600). No token is ever written there.

