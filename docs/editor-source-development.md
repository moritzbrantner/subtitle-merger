# Editor-family source development

Subtitle Merger consumes Timeline Editor as a product dependency. Timeline Editor in turn consumes Editor Core. Coordinated editor-family changes should be validated from source instead of waiting for either upstream package to be published.

## Local workflow

Keep sibling `editor-core/`, `timeline-editor/`, and `subtitle-merger/` checkouts next to each other, then run:

```sh
bun run source:prepare
bun run source:smoke
bun run verify:source
```

`EDITOR_CORE_SOURCE` and `TIMELINE_EDITOR_SOURCE` can override the default sibling locations. `source:prepare` builds Editor Core, recursively prepares Timeline Editor against that same Editor Core checkout, builds Timeline Editor, and materializes both packages under their real package identities in Subtitle Merger's `node_modules`.

Source revision state lives only in `node_modules/.editor-source-deps`. It is validation infrastructure and must never enter application state, persisted subtitle projects, or committed source paths. `.source/` is ignored for the same reason.

Use `bun run source:restore` or `bun run verify:registry` to return to the committed fallback dependencies. The Timeline Editor Git revision in `frontend/package.json` and `bun.lock` is a reproducible ordinary-install fallback; it is not the coordinated-development mechanism.

## CI boundary

Browser Acceptance checks out current Editor Core and Timeline Editor source, prepares the same source chain, smoke-tests the active package identities, and then runs the browser acceptance suites. This keeps browser integration ahead of package publication without aliases for obsolete Editor Core package names.
