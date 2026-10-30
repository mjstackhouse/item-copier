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
2. **Choose items.** The step leads with **Find items**: the user searches the source by item name or text content, in a language picked next to the search box (an empty search lists every item in that language). A **Filters** button opens filters for content type, collection, workflow step and taxonomy term, each a searchable multi-select: workflow steps are grouped by workflow and taxonomy terms by group, with nested terms indented and a "⌀ Not in <group>" option, as in the Kontent.ai app. Values within one filter match any of them, and different filters must all match (checked on real data). A parent term doesn't match items tagged only with its child terms, and "Not in <group>" matches items whose content type uses that group but that have none of its terms. Filters apply with the search. Each search uses the Management API's filter endpoint, 50 items per page, with a **Load more** button for further pages, plus one bulk request for the items' names and types. Picked items stay in a "Selected items" list across searches. Below it, **Copy settings** is collapsed to a one-line summary ("all 24 languages · linked items 1 level deep") and expands to show the languages to copy ("All languages" by default, since copying an item usually means all of its translations, or "Choose languages", a searchable multi-select built with react-select, as in the author's usage insights and asset description auditor) and how many levels of linked items to include (0 to 3). Explanations are in ⓘ tooltips.
3. **Preview.** The app works out the full list and checks the target:
   - loads the selected items and each level of linked items with bulk requests (up to 100 items each), and follows linked-items elements, subpages elements, rich-text linked items, rich-text links to items, and the same inside rich-text components
   - works per language: each item is copied in every chosen language it has a variant in, and linked items are followed separately in each language, because translations can link to different items. The preview has one row per language variant, grouped by item.
   - skips variants that don't exist in the source, and says so in a neutral one-line note that expands to a list grouped by item
   - blocks the copy if:
     - a selected item has a variant in none of the chosen languages, or no longer exists
     - the target lacks one of the chosen languages, or any content type, collection or workflow the items use (matched by codename, like the toolkit does). A missing workflow stays a blocker, because moving content into another workflow can change who may edit and publish it.
   - handles a workflow step the target's workflow lacks (for example one added after the environment was cloned) without blocking: the copy moves those variants to the target workflow's step of the same kind (Published, Archived, Scheduled) or its first step, and the preview says so in a note and shows the actual step in "After copy"
  - follows the target's workflow scopes: when they require a different workflow for an item's content type and collection, the copy puts the item in that workflow (same-named step, else the step of the same kind, else its first step), and the preview says so in a note
  - blocks archived items that can't stay archived: the toolkit archives by moving a variant from its workflow's first step to Archived, so if the target workflow doesn't allow that move, the copy would leave the item unarchived. Archiving is a deliberate decision, so the preview blocks the copy instead (for linked items, lowering the linked items depth leaves them out)
     - an item already exists in the target with a different content type
     - a content type the items use differs in the target: an element (including one from a snippet) is missing there or is a different kind of element. Extra elements in the target are fine.
     - a taxonomy term the items use (including inside rich-text components) is missing in the target, or its whole taxonomy group is
     - a content type the items use has a taxonomy element (directly or through a snippet) whose taxonomy group no longer exists in the source. The toolkit looks the group up even when no terms are selected, and fails the whole copy.
   - shows for each item whether it is new, a new language variant, or will overwrite an existing one
   - lets the user choose how publishing is handled:
     - **Match the source** (the toolkit's own behavior): items published in the source are published in the target right away, items that are published in the target but not in the source are unpublished, and schedules in the target are replaced with the source's.
     - **Copy as drafts**: nothing is published or unpublished. Between the toolkit's export and import, the app drops published versions that have a newer draft, moves published and scheduled versions to the workflow's first step, and removes schedules. Archived items stay archived; an archived source item whose target copy is live is blocked, because archiving it would take it offline. Items that are live in the target stay live, with the copied content as a new draft on top (this needs the second patch below). The toolkit still cancels any schedule on a target item before copying.
   - shows the publishing state each item will have after the copy, for the chosen option. In "Match the source" the toolkit makes the target match the source: items published in the source are published in the target right away, items that are published in the target but not in the source are unpublished, and schedules in the target are replaced with the source's. The preview flags these per item ("goes live", "replaces live content", "removed from live site", "schedule replaced") and summarizes them in a "Before you copy" panel above the Copy button, together with the confirmation. This takes one extra request per item for each side whose latest version is not the published one.
   - requires a confirmation when anything will be overwritten, published or unpublished, and asks again when the publishing option changes
4. **Copy.** Runs the toolkit's `exportAsync` and then `importAsync` (the two halves of `migrateAsync`) with a custom logger that streams every toolkit log line into the page, then shows a summary of items, variants and assets copied or failed. The toolkit skips items it cannot read from the source without reporting an error, so the app compares what was read with what was requested and lists any missing items.
   - **Cancel copy** stops at the next safe point. During the export (reading the source) it stops right away and nothing is written to the target. During the import it lets the item being copied finish and stops before the next one, so no item is left half-copied. The toolkit has no built-in way to stop; the app's logger throws when the toolkit is about to send the next item's first request.

## Where things are

| File | What it does |
| --- | --- |
| `vite.config.ts`, `shims/` | Makes the toolkit build for the browser by swapping two Node-only modules (`node:fs` and the `ora` terminal spinner) for stubs. The copy path never uses them. |
| `patches/` | Three small changes to the toolkit, applied automatically after every `npm install` by [patch-package](https://github.com/ds300/patch-package) (the `postinstall` script). 1) `core/utils/binary-data.utils.js`: in the browser the toolkit downloads asset files as an `ArrayBuffer`, which its own data check rejects ("expected Buffer2, received ArrayBuffer"); the patch wraps it in a `Blob`. In Node.js nothing changes. 2) `core/utils/management-client-utils.js`: the toolkit loads the asset folder tree but only searches its top level, so assets in nested folders lose their folder (and existing assets in nested target folders are updated on every copy); the patch flattens the tree. 3) `import/importers/language-variant-importer.js`: the toolkit unpublishes a target item when the imported data has no published version; the patch skips that for items the app marks with `keepTargetPublished`, which "Copy as drafts" does. `vite.config.ts` makes the patch contents part of Vite's development cache key, so a changed patch is never served from a stale cache. |
| `src/lib/kontent.ts` | Connecting, loading languages and types, item search and bulk item loading, small helpers |
| `src/lib/linkedItems.ts` | Finding linked items and rich-text references, breadth first |
| `src/lib/plan.ts` | Building the preview and the checks against the target |
| `src/lib/copy.ts` | Calling `migrateAsync` and summarizing the result |
| `src/components/` | One component per step, `LanguagePicker.tsx` for choosing the languages to copy, and `ui.tsx` for the shared message and tooltip pieces |
| `src/styles.css` | The visual style, matching the author's other Kontent.ai tools (export tool, content localization auditor, usage insights, asset description auditor): the same colors, Inter font, gradient title bar, pill buttons and inputs, and two-part messages |

## Request rate

The Management API allows 10 requests per second and 400 per minute per environment, shared by every API key and integration using that environment. This tool stays within half of both (5 per second, 200 per minute), so it doesn't crowd out other work in the environments:

- `src/lib/pacedHttp.ts` paces the app's own requests (search, preview) through a custom HTTP service for the Management SDK, with one pacer per environment.
- A patch to the toolkit's HTTP layer (in `patches/`) paces the toolkit's Management API requests during a copy, using the same per-environment pacer, so a preview followed straight away by a copy stays within the limits too. Asset file downloads aren't paced; they don't go to the Management API.
- The SDK's and the toolkit's retries still apply, so a request that hits the limit anyway (because of other traffic) is retried with back-off.
- The preview checks the target in bulk (one request per item to see whether it exists, then one per 100 variants) and makes at most two checks at a time.

With real environments, a preview of 50 items in 24 languages (65 variants) took about 35 seconds, and copying them about 3 minutes, with the busiest second at 5 requests and the busiest minute at 200 in both environments (measured by `scripts/real-env-test.ts`).

## Known limitations and next steps

- **Several languages in one run.** The toolkit takes a list of item and language pairs, so all chosen languages are copied in one run, and each content item is created once. Preview and copy time grow with the number of languages. Non-localizable elements (shared by all of an item's variants) copy correctly in one run: each variant and version keeps its value.
- **Content model.** The target must already have matching content types, taxonomies, collections and workflows. The preview checks the language, content types and their elements, taxonomy terms, collections and workflows (missing workflow steps fall back as described above). Element settings such as limits or validation aren't compared; a value the target's settings reject surfaces as an error during the copy. Use data-ops `sync` to align models.
- **Asset folders.** The toolkit puts each asset in the target folder with the same codename as in the source, and the Management API rejects the asset if that folder doesn't exist. This happens, for example, after cloning an environment without content items and assets, which leaves the clone without asset folders. Before importing, the app lists the target's folders (including nested ones) and puts assets whose folder is missing in the root folder instead, listing them in the copy summary. Copying again after creating the folders moves them, because the toolkit compares folders when deciding whether to update an asset. Nested folders work too: the toolkit only searched top-level folders, which the second patch in `patches/` fixes.
- **Workflow extras.** Tasks, comments, assignees and other workflow data are not copied (a toolkit limitation, also documented by data-ops).
- **Deleted references.** When the preview finds references to items that no longer exist in the source, it shows them in a warning with a "Skip these references when copying" checkbox, and the copy can't start until it is ticked (the toolkit fails the copy on such references otherwise). They are only detected when linked items are included (depth 1 or more), and not at the last level followed; an undetected one still makes the copy fail.
- **Keep the tab open.** The copy runs in the browser, so closing the tab stops it (possibly in the middle of an item; use **Cancel copy** instead). Re-running is safe: the toolkit matches existing items and assets by codename instead of creating duplicates.
- **Toolkit updates.** The toolkit is built for Node.js and does not document browser support, so upgrades can break the app. Keep its version pinned and, after upgrading, copy at least one item that uses an asset into a test environment.
  - If a new version imports another Node-only module, the build fails with a "not exported by __vite-browser-external" error. Add an alias and stub for it in `vite.config.ts`.
  - If a new version changes the patched lines, `npm install` fails with "patch failed". Make the same edits in `node_modules/@kontent-ai/migration-toolkit/dist/core/utils/binary-data.utils.js`, `dist/core/utils/management-client-utils.js` and `dist/import/importers/language-variant-importer.js`, run `npx patch-package @kontent-ai/migration-toolkit`, and delete the old file in `patches/`. Then test both publishing options against a test environment, because "Copy as drafts" depends on the second patch to keep live items live.
  - Builds must run npm's install scripts (the default on Netlify, Vercel and Azure Static Web Apps). With `--ignore-scripts` the patch is not applied and copies with assets fail.

## Testing against real environments

`scripts/real-env-test.ts` runs the app's own preview and copy code with Node.js against real environments, then checks the target against the preview's predictions variant by variant (published version, schedule, workflow step).

1. Create `.env.local` (git ignores it) with `SOURCE_ENVIRONMENT_ID`, `SOURCE_API_KEY`, `TARGET_ENVIRONMENT_ID` and `TARGET_API_KEY`. Don't prefix them with `VITE_`, which would put them into the browser bundle. Use dedicated Management API keys limited to these environments, with a short expiry, and a **test environment as the target**.
2. Preview only, read-only: `npm run test:real -- plan <item codename> [more codenames]`
3. Copy and verify: `npm run test:real -- copy <item codename> --yes`. Without `--yes` it stops after the preview.

Options: `--languages=en-US,cs`, `--depth=0..3`, `--drafts` ("Copy as drafts"), `--skip-deleted`, `--cancel-after=N` (cancels after N variants are imported), `--verbose` (every toolkit log line). It doesn't cover browser-only behavior, such as downloading and uploading assets from a browser.

## Tested so far

Typecheck and production build pass. Against a mocked Management API in the browser, the full flow was clicked through: connecting, search with **Load more**, linked items through linked-items elements, subpages elements and rich-text links, the deleted-reference and missing-variant warnings, the missing content type blocker, overwrite detection and confirmation, a full copy including an asset, and cancelling during both the export and the import.

Against real Kontent.ai environments (an environment and its clone made without content items and assets), with `scripts/real-env-test.ts`, these matched the preview's predictions variant by variant. All of them overwrote items that already existed in the target from earlier copies, so they test updating existing items, not creating new ones:

- "Match the source" for an item and its linked item, both live in the target (published version plus a newer draft).
- "Copy as drafts" for the same items: both stayed live, with the copied content as a new draft.
- A multilingual item (en-US and es-ES) with linked items that differ per language, and two images in a folder missing from the target: the images were newly uploaded to the root folder and the English variant was published.
- Cancelling after the first imported variant: 1 copied, 4 cancelled, none failed.

A further test created a new item in the target: a Fact item with a non-localizable text element, in four languages (two only drafts, one published with a newer draft, one only published). The item was created once, every variant's publishing state matched the preview, and the non-localizable element's value matched the source in every variant and version, including empty values in published versions. Writing the variants one after another didn't let one variant's value overwrite another's.

A scheduled item (a published version plus a newer version scheduled to publish, in a different display time zone) matched in both modes. "Match the source" reproduced the schedule exactly, time zone included. "Copy as drafts" over it cancelled the target's schedule, kept the live version and added a draft, without publishing anything. This test found that "Copy as drafts" had been re-publishing items in environments with more than one workflow (the Published, Archived and Scheduled steps share their ids across workflows); that is fixed, and the test script now fails a "Copy as drafts" run that sends any publishing request.

The workflow step fallback was tested with a step ("AI review") added to the source's Default workflow but not the target's: the preview showed the note, and the copied draft landed in the target's Draft step. A second run, with the item published and a newer version in "AI review", published the item in the target and put the newer draft in the Draft step.

A large selection (50 items in 24 languages, 65 variants, 54 of them new) copied correctly except for two variants, which exposed cases the preview doesn't check yet: an item in a workflow that the target's workflow scopes don't allow for its content type, and an archived item in a workflow whose steps can't move to Archived. The preview now handles both: the first item ("About us") moved to the workflow its scopes require ("Custom workflow", Draft step, published version kept), and the second is blocked. After the target's Default workflow was changed to allow its first step to move to Archived, the second item ("New article 869", whose target copy had been left unarchived) was no longer blocked: "Match the source" archived it in the target, and "Copy as drafts" over it kept it archived without sending any publishing request. A new archived item ("article 973") was created archived in the target. For an item archived in the source but published in the target ("30 years of expertise"), "Copy as drafts" was blocked, and "Match the source" predicted it would be archived and removed from the live site.
