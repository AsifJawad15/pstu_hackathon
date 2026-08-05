# 4-Minute Video Presentation Script

**Hard constraints from the rules:** no team name, no member names, no
university or institution name — not spoken, not on any slide, not in the
filename shown on screen, not in a visible browser tab or window title. Check
your screen recording for all of these before exporting.

**Target:** 3:45–3:55. Do not run to 4:00 exactly; encoders round up and a
4:01 file may be rejected.

Word counts below assume ~150 wpm, which is a calm, clear pace. Read it aloud
and time it before recording.

---

## Slide 1 — The framing (0:00 – 0:30) · ~75 words

> Emergency dispatch is not primarily a routing problem. Routing is a solved
> commodity — any open-source engine will give you a shortest path in
> microseconds.
>
> The hard problems are three. Allocating scarce units when demand exceeds
> supply. Staying stable while the world changes underneath you. And being
> accountable for decisions that affect whether someone lives.
>
> Our system, AEGIS, is organised around those three. Everything I show you
> follows from them.

**On screen:** title, and the three words — *Scarcity · Stability ·
Accountability*. Nothing else.

---

## Slide 2 — Architecture (0:30 – 1:15) · ~110 words

> Four planes over a partitioned event log.
>
> The edge accepts, validates and deduplicates. Incidents are written durably
> **before** any allocation is attempted — because during a cyclone the
> optimiser is exactly the component most likely to be saturated, and the
> moment you cannot accept a call is the moment you have failed.
>
> The partition key is region, not incident. That single choice gives us three
> things at once: ordered events per region, a single writer for each region's
> fleet so conflicts are impossible by construction, and a bounded solver
> matrix. Geography is our unit of scale — we add shards, not bigger matrices.

**On screen:** the four-plane architecture diagram from the report, animated
one plane at a time if your tool allows.

---

## Slide 3 — Triage (1:15 – 1:45) · ~75 words

> Every incident gets a priority from a versioned additive model: severity,
> scale, deadline pressure, vulnerability, hazard, plus a **bounded** aging
> term so nothing starves.
>
> We deliberately did not use a learned ranker here. Monotonicity is a safety
> property — more severity must never mean less priority, and here that is true
> by construction and unit-tested. Machine learning belongs upstream, predicting
> casualty counts that feed this transparent aggregator. Never as the
> aggregator itself.

**On screen:** the six weighted terms, and one real decision record showing the
per-term breakdown.

---

## Slide 4 — The optimisation (1:45 – 2:35) · ~125 words

> Allocation is a generalized assignment problem with side constraints —
> NP-hard. Our key step is **requirement expansion**.
>
> An incident needing two ambulances and one rescue team becomes three
> independent unit-slots. Once expanded, the core problem is a rectangular
> linear assignment problem — solvable *exactly* by Jonker–Volgenant in
> milliseconds. Scarcity, hospital beds, coverage reserve and plan stability
> become terms in the cost matrix, not heuristics bolted on afterwards.
>
> Two tiers share that one cost function. Tier one is a greedy admission
> decision — measured p99 of two-point-four milliseconds, so nobody waits for a
> solver. Tier two re-solves each shard exactly, budgeted and anytime.
>
> One cost function drives the fast path, the optimal path, and the explanation
> the dispatcher reads.

**On screen:** the expansion illustration, then the cost function with each
term labelled.

---

## Slide 5 — Stability and conflicts (2:35 – 3:05) · ~75 words

> Two things we got wrong first, and they matter.
>
> Re-optimisation is worthless if it thrashes crews. The cost of changing your
> mind is *inside* our objective — moving an en-route unit costs a hundred and
> sixty urgency-minutes. Before we did that, we issued two thousand two hundred
> assignments for a hundred and forty-eight incidents, and the optimised system
> was **worse** than the naive baseline.
>
> And no assignment ships without a TTL lease. If a worker crashes mid-commit,
> the lease expires and the ambulance comes back. A lock without a timeout
> strands it forever.

**On screen:** churn before/after, and the three conflict-prevention layers.

---

## Slide 6 — Results (3:05 – 3:40) · ~90 words

> We built it and measured it. Twelve simulated hours, three hundred and
> forty-two incidents, a cyclone surge, road closures, vehicle failures, and a
> routing-engine outage — every policy replaying a byte-identical event stream,
> three seeds, fully deterministic.
>
> Against a nearest-available baseline: p90 response down thirty-nine percent,
> p99 down twenty-five, severity-weighted response down eighteen, incidents
> never reached down eighteen, utilisation up thirty-seven. Zero resource
> conflicts, in every configuration and every seed.
>
> One number got worse: the median, by five minutes. That is triage working —
> routine calls wait so contended ones are reached at all. We report it because
> hiding it would misrepresent the trade.

**On screen:** the results table. Highlight the median row in a different
colour rather than hiding it — judges notice honesty, and they *will* read the
table.

---

## Slide 7 — Close (3:40 – 3:50) · ~30 words

> Four bugs individually made our optimised system worse than the baseline
> while every architecture diagram still looked correct. That is the argument
> for building the thing, not just describing it.

**On screen:** the four bugs, one line each.

---

## Production notes

- **Rehearse to time before recording.** The most common failure is a
  brilliant submission that runs 4:20 and gets disqualified.
- **Show the code running once**, briefly — even five seconds of the test
  suite passing or the simulation printing results is worth more than another
  diagram. It substantiates the central claim that this was built, not
  imagined.
- **Do not read the slides aloud.** Slides carry the numbers; you carry the
  reasoning.
- **Record audio separately** if you can. Laptop-mic-plus-screen-capture is
  the single most common quality problem in hackathon videos.
- Export MP4, H.264, 1080p, target well under 400 MB. A 4-minute 1080p H.264
  at 5 Mbps is roughly 150 MB.
- **Final check before upload:** play the whole file back and watch for your
  own name in a file path, a Slack notification, a browser bookmark bar, or a
  desktop wallpaper. This is how anonymity rules get broken.
