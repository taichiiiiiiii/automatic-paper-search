# apps/web test fixtures

| Directory | Origin | Used by |
|---|---|---|
| `legacy/` | Frozen copies of the old Python-generated site; see `legacy/README.md` | catalog / misc / lineage graph tests |
| `lineage-pilot/positive-release/` | Byte-identical copy (`git show`) of the deleted `paperpilot/tests/fixtures/lineage-pilot/positive-release/` | `test/catalog/catalog-pilot-lineage.test.ts`, `test/lineage/focus/{FocusView,loader,v2-core}.test.*` |
| `lineage-v1/node_display_cases.json` | Byte-identical copy of the deleted `paperpilot/tests/fixtures/lineage-v1/node_display_cases.json` | `test/lineage/core.test.ts` |

The Python test suite that generated/owned the `lineage-*` fixtures was
deleted in Tier C (docs/migration/p5-plan.md §6.3). Do not edit these
files by hand: their content hashes are referenced from inside the
fixtures themselves.
