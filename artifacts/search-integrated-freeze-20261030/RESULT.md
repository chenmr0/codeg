# Integrated search validation

Code freeze: `ced3725` (on f41b859 + reviewed beac767/0bbbc6e).

- Build passed.
- Search regressions: **68/68** across four files.
- Diagnostic targeted tests: **9/9**, including real five-client streamed evidence equality, normal close, SQL receiver/return/error preservation, and cached statements charging only current scope.
- Initial observer incorrectly captured per-call mutable metrics in cached statement wrappers. The journal equality test exposed later queries mutating earlier rows; failure output retained. Fixed using a shared observer whose current scope is selected at execution, with a regression verifying historical metrics never change.
- Small fixture overhead: 20 alternating paired batches × 100 queries. Median paired observed-minus-plain **0.03295 ms**. This ran alongside the prototype suite, so it is only a rough overhead check, not an isolated latency experiment or large-repository guarantee.
- Full prototype suite: **226/226**, zero failures or skips; raw result in linux/run.log and exit.json.

Every client row now includes searchSql.{fts,supplement,other}.{prepareMs,executeMs,calls}; scalar sums enter stageQuantiles. Outer searchMs still measures full public search entrypoint. SQL durations include row retrieval; ranking/conversion/other JavaScript are not separately claimed. No additional diagnostic SQL is issued.

No production API, schema or publication protocol changes from diagnostics. Windows and new full three-round real-repository benchmarks remain required. Previous code-version results do not validate this source. Phase two remains disabled.
