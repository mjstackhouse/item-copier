# Item Copier for Kontent.ai

An unofficial tool. It is not made, endorsed or supported by Kontent.ai.

A browser-only React app for copying content items (and the assets they use) from one Kontent.ai environment to another. The actual copying is done by [`@kontent-ai/migration-toolkit`](https://github.com/kontent-ai/migration-toolkit); this app adds the parts a non-technical user needs around it: choosing items, pulling in linked items, a preview with safety checks, and a live progress log.

There is no backend. API keys are kept in memory in the browser tab and are gone when it is closed or reloaded.

## Run it

Requires Node.js 20 or later for development.

```bash
npm install
npm run dev      # local dev server
npm run build    # typecheck + production build into dist/
```

`dist/` is a static site and can be hosted anywhere (Netlify, Vercel, Azure Static Web Apps, an S3 bucket).

## Before you rely on it: check browser access

The app calls the Management API and downloads asset files directly from the browser, so both must allow cross-origin requests (CORS). The data-ops GUI proof of concept already calls the Management API from the browser, which is a good sign, but asset downloads have not been confirmed. Run this in the browser console on the page where the app is hosted:

```js
const env = "<environment-id>", key = "<management-api-key>";
await fetch(`https://manage.kontent.ai/v2/projects/${env}`, { headers: { Authorization: `Bearer ${key}` } }).then((r) => r.status);
await fetch("<url of any asset in that environment>").then((r) => r.status);
```

If both print a status code instead of a CORS error, you are clear. Then try a real copy into a test environment before anything else.

## How it works

1. **Connect.** The user enters an environment ID and Management API key for the source and the target. Each is checked by loading the environment's name.
2. **Choose items.** The user picks a language, then searches the source by item name or text content (an empty search lists every item in that language). Each search uses the Management API's filter endpoint, 50 items per page, with a **Load more** button for further pages, plus one bulk request for the items' names and types. Picked items stay in a "Selected items" list across searches. Other options: how many levels of linked items to include (0 to 3), and whether to skip references to deleted items.
3. **Preview.** The app works out the full list and checks the target:
   - loads the selected items and each level of linked items with bulk requests (up to 100 items each), and follows linked-items elements, subpages elements, rich-text linked items, rich-text links to items, and the same inside rich-text components
   - drops linked items that have no variant in the chosen language (and says so)
   - blocks the copy if:
     - a selected item has no variant in that language, or no longer exists
     - the target lacks the language, or any content type, collection, workflow or workflow step the items use (matched by codename, like the toolkit does)
     - an item already exists in the target with a different content type
     - a content type the items use has a taxonomy element (directly or through a snippet) whose taxonomy group no longer exists in the source. The toolkit looks the group up even when no terms are selected, and fails the whole copy.
   - shows for each item whether it is new, a new language variant, or will overwrite an existing one
   - lets the user choose how publishing is handled:
     - **Match the source** (the toolkit's own behavior): items published in the source are published in the target right away, items that are published in the target but not in the source are unpublished, and schedules in the target are replaced with the source's.
     - **Copy as drafts**: nothing is published or unpublished. Between the toolkit's export and import, the app drops published versions that have a newer draft, moves published, scheduled and archived versions to the workflow's first step, and removes schedules. Items that are live in the target stay live, with the copied content as a new draft on top (this needs the second patch below). The toolkit still cancels any schedule on a target item before copying.
   - shows the publishing state each item will have after the copy, for the chosen option. In "Match the source" the toolkit makes the target match the source: items published in the source are published in the target right away, items that are published in the target but not in the source are unpublished, and schedules in the target are replaced with the source's. The preview flags these per item ("goes live", "replaces live content", "removed from live site", "schedule replaced") and summarizes them above the table. This takes one extra request per item for each side whose latest version is not the published one.
   - requires a confirmation when anything will be overwritten, published or unpublished, and asks again when the publishing option changes
4. **Copy.** Runs the toolkit's `exportAsync` and then `importAsync` (the two halves of `migrateAsync`) with a custom logger that streams every toolkit log line into the page, then shows a summary of items, variants and assets copied or failed. The toolkit skips items it cannot read from the source without reporting an error, so the app compares what was read with what was requested and lists any missing items.
   - **Cancel copy** stops at the next safe point. During the export (reading the source) it stops right away and nothing is written to the target. During the import it lets the item being copied finish and stops before the next one, so no item is left half-copied. The toolkit has no built-in way to stop; the app's logger throws when the toolkit is about to send the next item's first request.

## Where things are

| File | What it does |
| --- | --- |
| `vite.config.ts`, `shims/` | Makes the toolkit build for the browser by swapping two Node-only modules (`node:fs` and the `ora` terminal spinner) for stubs. The copy path never uses them. |
| `patches/` | Two small changes to the toolkit, applied automatically after every `npm install` by [patch-package](https://github.com/ds300/patch-package) (the `postinstall` script). 1) `core/utils/binary-data.utils.js`: in the browser the toolkit downloads asset files as an `ArrayBuffer`, which its own data check rejects ("expected Buffer2, received ArrayBuffer"); the patch wraps it in a `Blob`. In Node.js nothing changes. 2) `import/importers/language-variant-importer.js`: the toolkit unpublishes a target item when the imported data has no published version; the patch skips that for items the app marks with `keepTargetPublished`, which "Copy as drafts" does. `vite.config.ts` makes the patch contents part of Vite's development cache key, so a changed patch is never served from a stale cache. |
| `src/lib/kontent.ts` | Connecting, loading languages and types, item search and bulk item loading, small helpers |
| `src/lib/linkedItems.ts` | Finding linked items and rich-text references, breadth first |
| `src/lib/plan.ts` | Building the preview and the checks against the target |
| `src/lib/copy.ts` | Calling `migrateAsync` and summarizing the result |
| `src/components/` | One component per step, plus `ui.tsx` for the shared message and tooltip pieces |
| `src/styles.css` | The visual style, matching the author's other Kontent.ai tools (export tool, content localization auditor, usage insights, asset description auditor): the same colors, Inter font, gradient title bar, pill buttons and inputs, and two-part messages |

## Known limitations and next steps

- **One language per run.** The toolkit copies one language variant per item per run. Run it again for other languages.
- **Content model.** The target must already have matching content types, taxonomies, collections and workflows. The preview checks the language, content types, collections, workflows and workflow steps, but not individual elements or taxonomy terms; those mismatches surface as errors during the copy. Use data-ops `sync` to align models.
- **Workflow extras.** Tasks, comments, assignees and other workflow data are not copied (a toolkit limitation, also documented by data-ops).
- **Deleted references.** References to deleted items are only detected when linked items are included (depth 1 or more). With depth 0, such a reference makes the copy fail unless "Skip references to deleted items" is on.
- **Keep the tab open.** The copy runs in the browser, so closing the tab stops it (possibly in the middle of an item; use **Cancel copy** instead). Re-running is safe: the toolkit matches existing items and assets by codename instead of creating duplicates.
- **Toolkit updates.** The toolkit is built for Node.js and does not document browser support, so upgrades can break the app. Keep its version pinned and, after upgrading, copy at least one item that uses an asset into a test environment.
  - If a new version imports another Node-only module, the build fails with a "not exported by __vite-browser-external" error. Add an alias and stub for it in `vite.config.ts`.
  - If a new version changes the patched lines, `npm install` fails with "patch failed". Make the same edits in `node_modules/@kontent-ai/migration-toolkit/dist/core/utils/binary-data.utils.js` and `dist/import/importers/language-variant-importer.js`, run `npx patch-package @kontent-ai/migration-toolkit`, and delete the old file in `patches/`. Then test both publishing options against a test environment, because "Copy as drafts" depends on the second patch to keep live items live.
  - Builds must run npm's install scripts (the default on Netlify, Vercel and Azure Static Web Apps). With `--ignore-scripts` the patch is not applied and copies with assets fail.

## Tested so far

Typecheck and production build pass. Against a mocked Management API in the browser, the full flow was clicked through: connecting, search with **Load more**, linked items through linked-items elements, subpages elements and rich-text links, the deleted-reference and missing-variant warnings, the missing content type blocker, overwrite detection and confirmation, a full copy including an asset, and cancelling during both the export and the import.

Against real Kontent.ai environments, one copy has succeeded so far: an item with linked items and an asset, between an environment and its clone. Broader testing (several languages, components, published and scheduled items, large selections) is still to do.
