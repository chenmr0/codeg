# Deterministic drain-request lifetime review

Base: 366b594926d461185ab3ef59aa46366fe7af8945. This change touches acceptance harness only; no protocol, production source, budget or benchmark change.

## Original Windows failure remains evidence

Run 40993418535, Windows 225/226; long-request expected cancelled but received published, 2090.9955 ms total. Full logs retained separately in ci-fixed-path-evidence/search-freeze1. The original artifact has no hold/start/draining timestamps, so retrospective exact attribution is not possible.

The test has a demonstrable invalid premise: its 1500 ms request timer starts BEFORE publisher process startup, candidate validation, prepared durability, old checkpoint/hash and admission closure. If the request expires before draining (or before the drain deadline), publication is legitimate. Total test duration cannot establish lifetime inside drain.

## Corrected proof

- Old request stays active behind explicit IPC release until cancellation AND the queued request finish; active===1 assertion proves the old request did not expire to produce a false pass.
- Same cancellation case is run with zero and 1700 ms startup delay. No timed hold is used.
- Existing queued request <1000 ms and synchronous SDK <1000 ms assertions unchanged; publisher configured budget remains 1000 ms.
- Separate no-queued case verifies publisher's own `Drain budget exceeded`, not merely queued-admission early cancellation.
- A preflight barrier counterexample holds publisher at prepared until the original timed request completes, then verifies legitimate publication.
- Cold first-open case creates participant before drain but asserts reopens===0; only requests its first DB open during drain. This removes child-startup timing from its admission assertion.
- Same-process synchronous cancellation also uses controlled lifetime.

## Scope and follow-up

Independent review confirmed invalid premise and explicit lifetime proof. Its observations concerning unrelated variable insertion, cold startup timing, and pure publisher budget coverage were addressed. Linux results are attached. New Windows CI is REQUIRED; this change does not retroactively declare the failed Windows run passed. No production safety failure was established by that artifact, nor has absence of all such failures been proven. The full large-repository freeze and running trials are unchanged.

Final Linux: Node 24.22.1, 52/52 pass, 0 skipped, 19.429 s. See final-linux.log and final-linux/acceptance.json. Earlier runs retained, not substituted.
