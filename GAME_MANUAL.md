# Code Compiler Empire: Player Manual

Build a software empire by balancing engineers, agent swarms, compute, quality,
delivery, research, and maintenance. This manual describes the **current
playable game**, not proposed features. The desktop app and browser preview use
the same simulation, but keep separate local saves.

## Your first session

1. Follow or dismiss the five-step quick tour. Start on **Resource overview**:
   check Unmet Demand, Money, Source, Binaries, Releases, Technical Debt, and the production
   path. The numbers are live; the flow indicators need at least one tick.
2. Let the game run at **1x** for a few ticks. Source is generated, compiled
   into Binaries, tested into Releases, then deployed for revenue. Check where
   work accumulates rather than assuming every resource should rise.
3. On **Source & agents**, compare headcount with *funded* people and agents.
   Hiring spends credits immediately and adds payroll every tick. Try a team
   focus or a small skill-training purchase only if you can afford its upkeep.
4. On **Build & compilation**, inspect the selected hardware, Compute, and
   binary    buffer. Queue a modest manual job for Any Source or a producing team, then
   watch its processed, successful, and failed units. Unused build capacity
   still serves automatic work.
5. On **Testing & runtime**, compare the Binary and Release backlogs with
   incidents and deployment strategy. Visit **Technical debt**, **Policy**,
   and **Research / insight** to adjust the tradeoffs behind those results.
6. Open **Settings & saves** and save to a manual slot before experimenting.
   AUTO-SAVE is separate and does not replace your manual slot.

Buttons send commands to the simulation, which validates costs and rules.
The status strip reports accepted commands and rejections. A command processes
a simulation tick even when timed playback is paused; pause is not an
undo button.

## Time, playback, and saving

| Control | What it does |
| --- | --- |
| Pause / Resume | Stops or resumes **visible timed** advancement; commands can still process a tick. Resume returns to the last running speed. |
| 1x / 2x / 5x | Advances at the chosen multiplier of real time; one simulation tick represents one second at 1x. |
| Max 10x | A fixed, capped 10x playback rate, not unlimited fast-forward. |
| AUTO-SAVE | Saves to its own slot while visible at the configured interval (30 seconds by default). Hiding the window saves at the hide boundary; hidden timer autosaves are skipped. |
| Three manual slots | Explicit Save, Load, backup restore, and confirmed Delete controls. Loading replaces the game in memory and can discard unsaved progress. |

Closing and reopening a saved game, or returning after the window was hidden,
advances the elapsed **offline** interval at normal offline time, regardless of
the visible playback multiplier. Pausing visible playback does not opt out of
later offline progress. Catch-up is exact and uncapped in this game: a long
absence can take noticeable real time, with progress shown while the worker
processes its ticks. Commands wait for that ordered catch-up. A manual save
while hidden first catches up through its save time, so the elapsed interval is
not counted twice.

On startup, a valid AUTO-SAVE is preferred; if absent, the latest valid manual
save is loaded. A corrupt AUTO-SAVE is **not** silently bypassed: play pauses
and the recovery controls offer its backup, another slot, or a confirmed new
game. Where a slot has a backup, its prior valid version can be loaded
explicitly. Saving a recovered game later updates only the chosen slot. Old
single-save data is readable as an AUTO-SAVE fallback. Browser saves use
localStorage; the native desktop app stores them in platform app data. Saves do not
automatically transfer between the two.

## The production and feedback loops

The usual path is **unmet demand → funded teams and swarms + Compute → Source
→ compilation → Binaries → testing → Releases → deployment → Money,
reputation, and new demand**.
Human source work, builds, incidents, maintenance, and automation can also
produce Insight. A selected research project consumes Insight and Money to
gain Knowledge. Knowledge helps several existing systems; it is not a
separate unlock tree. Debt and bugs generated along the way affect future
builds and incidents. Maintenance retires debt, while risky automation can
make more Source *and* more instability, debt, and emergency work.

### Resource guide

Every registered resource appears on Resource overview. Some are stockpiles;
others are **reset and recomputed each tick**, so a low balance at the end of a
tick does not prove that no work was done.

| Resources | How to read them |
| --- | --- |
| **Unmet Demand** | Bounded market requests (starting at 40; cap 2,000). Source generation and automation fill requests not already represented by Source, Binaries, or Releases; only requests satisfied by deployment can earn revenue. New organic requests arrive even if the queue runs dry. |
| **Money** | Credits from deployment revenue, spent on payroll, hardware, research, paid upgrades, training, maintenance, and crisis response. A team or swarm may exist but be unfunded. |
| **Compute** | Per-tick hardware output shared by source tooling, compilation, and testing. It resets each tick; purchasing a larger profile raises its possible supply and cost. |
| **Source → Binaries → Releases** | Stock waiting at each successive stage. Source capacity is 1,000, the Binary buffer is 500, and the Release buffer is 100 in the current balance. Full downstream buffers can stop upstream work. |
| **Hot Deploy Requests** | Bounded automation-generated requests that can increase deployment work. They are not free Releases. |
| **Insight / Knowledge** | Insight pays for research progress; completed research grants extra Knowledge. Knowledge also affects existing production, quality, maintenance, and automation calculations. |
| **Technical Debt / Bugs / Incidents** | Different risks: debt penalizes compilation and can create bug pressure through category interest; bugs can be detected in tests or escape; incidents damage reputation and can trigger crises. |
| **Reputation / Test Confidence** | Reputation responds to reliable deployments or incidents and affects revenue; Test Confidence is a per-tick testing signal, not a banked reward. The UI displays these signals as percentages. |
| **Automation Power / Agent Instability / Crisis Severity** | Automation can improve its own output; instability and active crises are costs of unsafe growth. Crisis severity reflects unresolved episodes and response pressure. |
| **Human, Agent, Maintenance, and Response Capacity** | Per-tick funded capacity allocated to authoring, maintenance, or emergency work. They reset rather than accumulate. |
| **Policy Strength, Coding Standards, Risk Tolerance, Release Cadence, Morale, Agent Autonomy, Verification, Operations, and Research Skill** | Per-tick policy/workforce signals used by the corresponding systems. Resource overview displays their percentage-like values; team skills and policies are managed in their own panels. |

**Net / tick** is the change in the displayed balance between sampled
projections. **In** and **Out / tick** are measured gross production and
consumption from committed exact ticks. For example, Compute can show net
zero while being produced and spent heavily. Ephemeral resets are not counted
as economic consumption. Gross rates are unavailable rather than guessed
when the sample does not cover exact measured ticks. Backlog counts and
bottleneck messages describe observed stock and recent blocked work, **not**
predictions of future throughput.

## The seven gameplay sections

| Section | What you can do and what to watch |
| --- | --- |
| **Resource overview** | See every balance, net and gross rates, unmet requests vs work already in flight, actual Source/Binary/Release backlogs, recent bottlenecks, and debt pressure. Debt status considers recent retirement and growth, not just leftover end-of-tick maintenance. |
| **Source & agents** | Hire/fire engineers; recruit/retire swarm agents; set team focus, train skills, adjust autonomy/alignment, and edit or clear team-policy overrides. Compare owned headcount with funded output. |
| **Build & compilation** | Pick hardware; queue Any Source or a specific producing team's work, prioritize, move, or cancel jobs; inspect compile stages, Compute costs, failures, binary capacity, and pipeline diagnostics. |
| **Testing & runtime** | Select canary, rolling, all-at-once, or hot deployment; inspect confidence, incidents, backlogs, crisis response thresholds, and the important engine-event log. |
| **Technical debt** | Inspect category principal, interest and last maintenance; set global maintenance allocation and request category-specific manual paydown. |
| **Policy** | Choose Balanced, Careful, or Aggressive presets, or edit each global policy field individually. Team overrides remain in force until cleared. |
| **Research / insight** | Select an eligible project, track progress and Knowledge, then optionally purchase the completed project's upgrade for a one-time Money and Knowledge cost. |

**Settings & saves** is a separate eighth navigation tab, not another
simulation layer. It holds AUTO-SAVE, three manual slots, recovery actions,
and validated preferences: default speed (Paused/1x/2x/5x/10x), UI scale,
dark/midnight theme, and autosave interval (15, 30, 60, 120, or 300 seconds).
Theme and scale apply immediately. A changed **default** speed applies the
next time the app starts, not to the currently selected playback speed.
Introduction completion and preferences are stored separately from game
saves. There is no tray/background-ticking mode.

## Decisions that matter

### Staff, focus, and policy

A new game starts with 1,000 credits, a 10-engineer `platform-team`, and a
four-agent `compiler-swarm`. Their base salary/upkeep is **2 credits per
funded person or agent per tick**. Hiring or recruiting costs **five ticks of
that unit's rate up front** (10 credits at the starting rates); firing does
not refund past costs. Each cohort can have 0–100 members. The UI changes
staffing one unit at a time.

Funding matters more than the roster alone: teams are paid from available
Money and unfunded engineers provide no capacity. The global AI allocation
also limits how many agents are put to work; the starting 500/1,000 allocation
funds up to half the roster before affordability is considered. Morale,
alignment, instability, and autonomy further affect effective output.

Team focus may be Generalist, Source generation, Verification, Operations,
or Research. A focused skill gains **20%** and the other skill axes lose
**25%**, affecting actual simulation capacity. Training a displayed skill
costs **5 credits per skill point**, can add up to 10 points per UI click,
and caps that skill at 2,000. These are per-team values, not research
projects.

Global and team policies use 0–1,000 values (1,000 = 100%). AI allocation,
maintenance allocation, review/test strength, coding standards, risk
tolerance, and release cadence all have systemic effects. A saved team
policy is a **full override**: subsequent global edits do not replace it
until you choose *Inherit global policy again*. Increasing maintenance takes
team capacity away from delivery; lowering quality controls or raising risk
can improve short-term pace at the cost of debt, bugs, morale, or incidents.
Swarm autonomy and alignment can be adjusted in 100-point UI steps within
0–1,000; high autonomy without sufficient alignment/control can feed
instability.

### Build, testing, and deployment

Starting **balanced** hardware can provide up to 80 Compute for 20 credits
per tick; **high-throughput** can provide up to 160 for 55 credits per tick.
If Money cannot cover the profile, provisioned Compute and its cost scale
down. Source generation uses Compute first, then compilation and testing
compete for the remainder.

Demand is an **outstanding request count**, not a stash of free Source.
Organic demand adds at least one request per tick, plus one per 250
Reputation points, up to the 2,000 cap. Source generation and automation
can only supply the portion not already in Source, Binaries, or Releases:
the same request is not generated twice while its work is in flight.
Deployment satisfies up to one outstanding request per Release and
earns revenue only on that served amount. Each served deployment without
an incident creates a new referral request; reputation adds another
`floor(successful requests × Reputation / 500)` referrals, all bounded
by the cap. These arrivals occur after Source generation in the current
tick, so new work starts on a later tick. Incidents can slow referral
growth; the organic trickle avoids a permanent empty-demand deadlock.
There is no separate contract, customer segment, or pricing simulator.

Build throughput starts at **up to 12 Source units per tick**, before debt,
Compute, cache, Source availability, and the binary-buffer limit. The
parse → compile → link stages consume Compute. Technical Debt reduces the
throughput limit by one per 20 debt units (never below one) and can increase
failure risk. Successful builds warm a cache; failures still consume their
Source and Compute and do **not** award Binaries. Testing handles up to
**8 Binaries per tick**, also limited by Compute and the Release buffer;
rejected/defective results are not Releases.

A manual build job is a **priority request to process Source**, not a
reservation and not newly created Source. Requests can wait for Source that
will be generated later. Select **Any Source** (including agent output) or
an engineering team's Source. Jobs are served in queue order from the *same*
per-tick build capacity before automatic compilation gets any remaining
capacity. A team job skips Source from other teams; an unmatched request
does not stall automatic compilation. Since cohorts carry quality and
policy, prioritizing a different producer can change compilation quality
and failure outcomes, not just the label on a job. You may start, move,
prioritize, or cancel requests: at most **16
pending jobs**, **256 Source units per job**, and **1,000 outstanding
requested units**. Cancellation removes unprocessed work from the request;
it does not restore already consumed Source or costs. Watch both successful
and failed units on the job. Source generated before this update may have
already been compacted across producers; such mixed-provenance cohorts can
still be processed by **Any Source** or automatic builds, but cannot be
retroactively assigned to a specific team.

Deployment consumes actual Releases and generates revenue from the current
service economy, modified by reputation. With the starting six-per-tick
base, **canary** attempts one release per tick, **rolling** up to three,
**all-at-once** up to six, and **hot** up to twelve before any queued hot
requests and available Releases are considered. Faster strategies have
different incident risks; canary is slower and safer. Revenue is not a
promise of fixed income if Releases are unavailable.

### Research, debt, and crises

Research needs an **eligible selected project**, Insight, and Money. A new
game starts with `incremental-builds` selected: it requires 20 progress, costs 1 Insight
and 1 credit per progress, and awards 20 extra Knowledge on completion.
After that, `verified-generation` becomes eligible: 40 progress, 2 Insight
and 2 credits per progress, and 50 extra Knowledge on completion. Each
progress unit also adds one Knowledge. The base limit is four progress per
tick, subject to available resources and skill/evidence effects. Completion
clears the selection: choose the next project yourself. Completion also
**makes an optional upgrade purchasable**, but does not activate it,
auto-select the next project, or unlock hardware automatically:

| Upgrade (required completed project) | One-time cost | Actual effect |
| --- | --- | --- |
| `incremental-build-cache` (`incremental-builds`) | 80 credits + 10 Knowledge | Each compiled Source costs one less Compute, with a minimum cost of one. |
| `verified-ai-source` (`verified-generation`) | 160 credits + 20 Knowledge | New AI-authored Source carries +200/1,000 test strength (up to 1,000), influencing existing build/testing decisions downstream. Existing queued Source is unchanged. |

Purchased upgrades persist in the game save. Duplicate purchases and
unaffordable/locked purchases are rejected. Both projects still grant
Knowledge even if you do not buy their upgrades.

Debt is tracked by `source-complexity` and `build-fragility`. Their current
interest rates are 10% and 15% in the category calculation; interest
pressure can create Bugs, **not compound the debt balance directly**.
Allocated Maintenance Capacity can automatically retire debt. Base terms
are up to two debt units per maintenance capacity and **one credit per unit
actually retired**, modified by Knowledge and category efficiency
(`build-fragility` starts at 80% of `source-complexity`'s 100%). Select a
category and request up to 1,000 units of manual paydown; it takes priority
within *that tick's generated maintenance*, then automatic paydown uses
what remains. The request cannot conjure capacity or funding, so an accepted
request may retire less than requested, even zero. Check **Last manual
pay-down** and **Last maintenance tick** for the real outcome.

Incidents, excessive debt, or swarm instability can open outage,
debt-explosion, or rebellion episodes. The starting crisis protocol
thresholds are **3 incidents**, **100 debt**, and **800** for
instability + autonomy − morale. Automatic response initially budgets 10%
of available credits, but also needs Response Capacity. Response can reduce
incidents, debt, and instability; unresolved severity can cost reputation,
while severe episodes can shut down automation. Adjust the response budget
and thresholds under Testing & runtime; high reserves alone do not
guarantee containment.

## Troubleshooting a stalled empire

| Symptom | Check first | Possible response |
| --- | --- | --- |
| Unmet Demand low but Source/Binaries/Releases are full | Requests already in flight | Clear the downstream pipeline rather than minting more Source. Watch actual served requests and referrals. |
| Source at 1,000 and generation blocked | Binary stock, build bottleneck, Compute, debt | Improve the *downstream* build/testing path before adding more authors. High-throughput hardware helps only if credits support it. |
| Binaries near 500 or Releases near 100 | Testing Compute, test throughput, deployment strategy | Clear the downstream backlog; speeding Source alone can worsen the queue. Faster deployment increases risk. |
| Owned staff exceed funded staff; Money falling | Salary/upkeep, AI allocation, hardware cost, releases deployed | Reduce costs or restore the release/revenue pipeline before hiring again. |
| Debt rising despite some retirement | Gross debt inflow, funded maintenance, category efficiency, Money | Improve standards/review, reserve maintenance, fund paydown, or direct available maintenance to a category. A zero *remaining* maintenance balance can mean capacity was successfully spent. |
| Incidents, reputation loss, rebellion pressure | Testing confidence, deployment risk, autonomy/alignment, crisis status | Slow delivery, strengthen quality/operations, align swarms, and inspect the response protocol. |
| Research not progressing | Selected eligible project, dependency, Insight and credits | Choose a project and supply its real per-progress costs; completed projects need no more progress. |

**Example: Source piles up.** Check whether the build panel reports a full
Binary buffer, inadequate Compute, or debt-reduced throughput. If Binaries
are full, first address testing or the Release buffer; if Compute is short,
check the funded hardware profile and its credit cost. Queueing a manual job
changes *whose Source is built first*, not total build capacity.

**Example: revenue falls while incidents rise.** Check the actual deployment
and test rates, then try canary or rolling delivery while strengthening
verification and paying down debt. Watch Money before adding hardware or
staff: the slower, safer deployment strategy can also reduce short-term
revenue. Return to faster delivery only when the backlog and risk warrant it.

The **Important events** log in Testing & runtime retains the latest 64
selected engine events (including hiring, build jobs, research, debt, and
crises) in saves. It is a bounded history, not a complete replay. Status-strip
command and save notices are immediate UI feedback and are not part of that
persisted log. There is a bounded demand backlog but no customer/contract market simulator, no tray process, no
arbitrary playback speed, and no rule that every resource must grow.
