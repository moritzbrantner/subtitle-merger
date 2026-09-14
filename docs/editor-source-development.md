# Editor-family source development

Subtitle Merger consumes Timeline Editor as a product dependency. Timeline Editor in turn consumes Editor Core. Coordinated editor-family changes should be validated from source instead of waiting for either upstream package to be published.

## Shared contract

`coding-tooling source-deps` owns source graph validation, deterministic source build ordering, package materialization, status/smoke evidence, and restoration of the ordinary install. Subtitle Merger only declares the exact graph in `.coding-tooling.source-deps.json` and provides checkout transport through `scripts/source-deps`.

The declaration pins exact Git revisions for `@moenarch/editor-core` and `@moritzbrantner/timeline-editor`. Source packages are built and materialized under those real package identities; no acceptance-only alias or alternate package namespace is introduced.

Source paths are transport, not identity. CI checks the pinned repositories out under `.source/`. For local work, `scripts/source-deps` bridges `EDITOR_CORE_SOURCE` and `TIMELINE_EDITOR_SOURCE`, or sibling `../editor-core` and `../timeline-editor` checkouts, into those ignored `.source/` paths before delegating to coding-tooling.

## Local workflow

Keep sibling `coding-tooling/`, `editor-core/`, `timeline-editor/`, and `subtitle-merger/` checkouts available at the revisions declared by `.coding-tooling.source-deps.json`, then run:

```sh
bun run source:verify-graph
bun run source:prepare
bun run source:smoke
bun run verify:source
```

`source:verify-graph` fails closed when a declared local checkout is missing or at a different revision. `source:prepare` starts from the frozen ordinary install, builds Editor Core before Timeline Editor because Timeline declares that dependency, and materializes both into Subtitle Merger's `node_modules`. `source:smoke` verifies that the active packages resolve under their canonical identities.

Source revision state lives only under `node_modules/.coding-tooling-source-deps`. It is validation infrastructure and must never enter application state, persisted subtitle projects, or release metadata. `.source/` remains ignored for the same reason.

Use `bun run source:restore` or `bun run verify:registry` to return to the committed fallback dependencies. The Timeline Editor Git revision in `frontend/package.json` and `bun.lock` remains the reproducible ordinary-install fallback; changing the source graph does not publish packages or rewrite that distribution contract.

## CI boundary

Browser Acceptance checks out coding-tooling plus the exact Editor Core and Timeline Editor revisions declared by the source graph. It verifies the graph before preparation, smoke-tests the materialized canonical package identities, and then runs the existing browser suites. Advancing either source revision is therefore an explicit integration change with reviewable evidence rather than implicitly following a moving branch.

This keeps browser integration ahead of package publication while preserving a separately reproducible ordinary-install path.
