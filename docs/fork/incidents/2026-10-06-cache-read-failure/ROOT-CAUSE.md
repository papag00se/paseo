# Paseo cache incident: confirmed underlying storage failure

Investigation used an isolated copy of ~/.config/Paseo/IndexedDB with Electron 44.2.0, the installed app's Electron version. No production cache rows or agent sessions were deleted or modified by the diagnostic harness.

## Evidence

Two timeline rows fail individual IndexedDB reads with UnknownError: Failed to read large IndexedDB value:

- 2635e08f-9b46-4cf8-a79e-1c8d5d9f5466 (Reorganize Daz), backed by paseo_app_0.indexeddb.blob/2/3f/3f90.
- b562603f-1e51-4b2e-bca4-0695ddbde078 (Important Projects Restore Confidence), backed by paseo_app_0.indexeddb.blob/2/3f/3f8d.

The original blob files both exist but contain zero bytes. Their birth, modification and change times are equal:

- 3f8d: 2026-10-06 17:01:28.953412283 -0700.
- 3f90: 2026-10-06 17:01:57.301026573 -0700.

An LD_PRELOAD file-open tracer in the isolated Electron harness maps each failing row to its corresponding blob file. Other rows read successfully. A new row writes successfully. The profile has ~16 MB of IndexedDB data, with ~33 GB reported quota. The home filesystem has ~463 GB available. LevelDB recovery logs report normal recovery, not corruption. The journal slice around blob creation has no matching Paseo crash, OOM kill, or filesystem I/O-error record.

Removing only these two unusable rows FROM THE ISOLATED COPY permits getAll and rewriting every remaining row to complete successfully. See cache-forensics-before.json, cache-blob-mapping.log and cache-forensics-after-copy-repair.json.

## Failure propagation

ReplicaCache.ensureStoredIndex initializes its size/eviction index by calling rowStore.readAll (IndexedDB getAll). Either corrupt large-value blob aborts the entire read, not just its own conversation. The rejected storedIndexPromise is retained. Subsequent cache persistence therefore fails before attempting a write. persist restores its pending changes. The old readRows implementation then loops waiting for those pending changes to disappear. They cannot disappear while initial indexing is failing. Viewed timeline preparation waits for readRows, so authoritative network catch-up never starts.

The original apparent cache-write failure is thus downstream of a corrupt-value READ failure, not evidence that IndexedDB generally cannot write.

While the timeline has no authoritative baseline, processAgentStreamEvent feeds the current live overlay to applyStreamEvent as tail with an empty head. Assistant text already resumes its tail prefix, but reasoning did not. Every reasoning delta therefore became a new Thinking card. The adjacent-position reasoning-resume fix addresses this path as well as hydrated-prefix continuation.

## Remaining uncertainty

The physical reason the two rows cannot be read is confirmed: their external value files are empty. The evidence does not establish what originally left the files empty. An interrupted/failed Chromium blob write is consistent with birth=mtime and zero length, but there is no captured original write error or identified interruption. Do not describe a crash, shutdown, disk-full event, custom-fork regression, or specific Chromium bug as proven.

Production corrupt cache entries are still present. Installed fixes unblock network loading and merge Thinking chunks; they do not repair these two unreadable cached values. Agent histories remain available through the daemon/provider sessions.
