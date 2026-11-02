# Developer guide

A browser-only React app (Vite, TypeScript) around [`@kontent-ai/migration-toolkit`](https://github.com/kontent-ai/migration-toolkit). The toolkit does the copying; the app finds the items, previews and checks the copy, and adapts the toolkit's data for the "Copy as drafts" option. There is no backend: API keys stay in memory in the browser tab.

Requires Node.js 20 or later (CI and Netlify use Node.js 22). The commands are in the [README](../README.md#developing).

## Where things are

| File | What it does |
| --- | --- |
| `src/lib/kontent.ts` | Connecting, loading the source's languages, types and workflows, item search and bulk item loading |
| `src/lib/linkedItems.ts` | Following linked items and references, breadth first, per language |
| `src/lib/plan.ts` | Building the preview: what will be copied, and the checks against the target |
| `src/lib/publishing.ts` | Workflow steps, publishing states, and the preview's prediction of each variant's outcome |
| `src/lib/copy.ts` | Running the toolkit's export and import, adapting the data in between, and summarizing the result |
| `src/lib/report.ts` | The downloadable copy report |
| `src/lib/pacedHttp.ts` | Request pacing (see [Request rate](#request-rate)) |
| `src/lib/selection.ts`, `src/lib/util.ts` | What the user chose to copy; small shared helpers |
| `src/components/` | One component per step, plus `LanguagePicker.tsx` and the shared pieces in `ui.tsx` (messages, tooltips, the codename icon, the error boundary) |
| `src/styles.css` | The visual style, shared with the author's other Kontent.ai tools |
| `vite.config.ts`, `shims/` | Builds the toolkit for the browser by swapping two Node-only modules (`node:fs` and the `ora` spinner) for stubs; the copy path never uses them |
| `patches/` | Changes to the toolkit (see [Toolkit patches](#toolkit-patches)) |
| `scripts/real-env-test.ts` | Runs the preview and copy against real environments (see [Testing](#testing)) |

## How it works

### Finding items

Search uses the Management API's filter endpoint, 50 items per page, plus one bulk request for the items' names and types. Values within one filter match any of them, and different filters must all match. A parent taxonomy term doesn't match items tagged only with its child terms, and "Not in <group>" matches items whose content type uses that group but that have none of its terms.

### Building the preview

- **Linked items** are followed breadth first, separately in each language (translations can link to different items), through linked-items and subpages elements, rich-text linked items and links to items, and the same inside rich-text components. Each level is loaded with bulk requests of up to 100 items. "All linked items" follows links until no new items are found.
- **Variants** are copied in every chosen language the item has a variant in. Missing variants are skipped and listed.
- **Missing references**: the toolkit fails the copy on a reference to an item or asset that no longer exists, unless `skipMissingReferences` is set. The preview checks the items it follows, the items linked from the last level, every asset the copied variants use (one request per asset; there is no bulk get), and the older published version of a variant whose latest version is a newer draft, because the toolkit copies both versions.
- **Blockers** stop the copy when:
  - a selected item no longer exists, or has a variant in none of the chosen languages
  - the target lacks a chosen language, or a content type, collection or workflow the items use (matched by codename, as the toolkit does). Moving content into another workflow could change who may edit and publish it, so a missing workflow is never worked around.
  - an item exists in the target with a different content type
  - an element (including one from a snippet) is missing in the target's type or is a different kind of element. Extra elements in the target are fine; element settings such as limits aren't compared.
  - a taxonomy term the items use is missing in the target, or its whole group is
  - a content type has a taxonomy element whose group no longer exists in the source (the toolkit looks the group up even when no terms are selected)
  - an archived item can't be archived in the target, because the target workflow's first step can't move to Archived (the toolkit archives through the first step). Not a blocker in "Copy as drafts" when the target's variant is published, because it isn't archived then.
- **Workflow steps the target lacks** (for example a step added after cloning) don't block: the copy moves those variants to the target workflow's step of the same kind, or its first step. Likewise, when the target's **workflow scopes** require a different workflow for an item's type and collection, the item goes to that workflow. The preview notes both.
- **Predictions**: for each variant, the preview predicts the outcome from the source's and the target's publishing state. This takes one extra request per variant on each side whose latest version isn't the published one.

### Publishing options

- **Match the source** is the toolkit's own behavior: items published in the source are published in the target right away, items published in the target but not in the source are unpublished, and the target's schedules are replaced with the source's.
- **Copy as drafts** rewrites the exported data before the import (`toDrafts` in `copy.ts`): it drops published versions that have a newer draft, moves published and scheduled versions to the workflow's first step, and removes schedules. Archived versions stay archived, except over a variant that is published in the target, which would be unpublished; those become a draft in the first step instead. Every item is marked `keepTargetPublished`, which the third patch reads to keep the target's published version. The toolkit still cancels any schedule on a target item before copying.

### Copying

`copyItems` runs the toolkit's `exportAsync` and then `importAsync` (the two halves of `migrateAsync`) with a custom logger that streams every log line into the page. Between them it applies "Copy as drafts", fits steps and workflows to the target, and puts assets whose folder is missing in the target into the root folder (the Management API rejects an asset whose folder doesn't exist; cloning an environment without content doesn't copy asset folders).

- **Cancelling**: the toolkit has no way to stop, so the logger throws. During the export that happens right away, before anything is written. During the import it waits until the toolkit is about to send the next item's first request, so no item is left half-copied.
- **Unread items**: the toolkit skips items it can't read from the source without reporting an error, so the app compares what was read with what was requested and lists the difference.
- **Results** link each copied variant to its editor in the target, using the documented `app.kontent.ai/goto/edit-item/...` edit link.

## Request rate

The Management API allows 10 requests per second and 400 per minute per environment, shared by everything using that environment. The tool stays within half of both (5 per second, 200 per minute):

- `src/lib/pacedHttp.ts` paces the app's own requests through a custom HTTP service for the Management SDK, with one pacer per environment, shared through `globalThis`.
- A patch to the toolkit's HTTP layer paces the toolkit's requests through the same pacer, so a preview followed straight away by a copy stays within the limits. Asset file downloads aren't paced; they don't go to the Management API.
- The SDK's and the toolkit's retries still apply, so a request that hits the limit because of other traffic is retried.

With real environments, a preview of 65 variants (50 items in 24 languages) took about 35 seconds and the copy about 3 minutes, with the busiest second at 5 requests and the busiest minute at 200.

## Toolkit patches

The toolkit is built for Node.js and doesn't document browser support, so the app depends on four changes to it (one patch file in `patches/`), applied after every `npm install` by [patch-package](https://github.com/ds300/patch-package). `npm install` fails if a patch no longer applies, so a build without them can't be deployed.

1. `core/utils/binary-data.utils.js`: in the browser, asset files arrive as an `ArrayBuffer`, which the toolkit's own data check rejects; the patch wraps it in a `Blob`.
2. `core/utils/management-client-utils.js`: the toolkit only searches the top level of the asset folder tree, so assets in nested folders lose their folder; the patch flattens the tree.
3. `import/importers/language-variant-importer.js`: the toolkit unpublishes a target item when the imported data has no published version; the patch skips that for items marked `keepTargetPublished` ("Copy as drafts").
4. `core/utils/http.utils.js`: request pacing (see [Request rate](#request-rate)).

`vite.config.ts` makes the patch contents part of Vite's development cache key, so a changed patch is never served from a stale cache.

### Upgrading the toolkit

Keep its version pinned. After upgrading:

- If the build fails with "not exported by \_\_vite-browser-external", the new version imports another Node-only module. Add an alias and a stub for it in `vite.config.ts`.
- If `npm install` fails with "patch failed", make the same edits in the new version's files under `node_modules/@kontent-ai/migration-toolkit/dist/`, run `npx patch-package @kontent-ai/migration-toolkit`, and delete the old patch file.
- Then copy at least one item with an asset into a test environment with both publishing options, because "Copy as drafts" depends on the third patch to keep published items published.

`@kontent-ai/core-sdk` must stay on the version the management SDK uses: the paced HTTP service is built on it, and npm shares one copy between them. Don't upgrade it on its own.

## Hosting

`dist/` is a static site. `netlify.toml` runs the lint checks and unit tests before building, so a failing test stops the deploy, and sets the security headers: a Content Security Policy that only allows the page's own scripts and connections to the Management API (`manage.kontent.ai`) and the default asset domains (`*.kc-usercontent.com`), plus `Referrer-Policy: no-referrer`.

Builds must run npm's install scripts (the default on Netlify, Vercel and Azure Static Web Apps). With `--ignore-scripts` the patches aren't applied and copies with assets fail.

**Open question:** if an environment uses a custom asset domain and the Management API returns asset URLs on it, the policy blocks downloading those assets. This hasn't been checked. If it happens, add the domain to `connect-src`.

## Testing

### Unit tests

`npm test` runs the unit tests (`src/**/*.test.ts`, Vitest). They cover the rules that decide what the copy does, using small made-up environments from `src/test/fixtures.ts` instead of real data: publishing predictions and step fallbacks, workflow scopes and archiving, the "Copy as drafts" rewrite, the blockers that depend on the publishing option, finding linked items, assets and taxonomy terms, the copy report, the search filter request and request pacing. They don't call the Management API.

GitHub Actions (`.github/workflows/ci.yml`) runs a clean install, the lint checks, the typecheck, the unit tests and the build on every push and pull request.

### Against real environments

`scripts/real-env-test.ts` runs the app's own preview and copy code with Node.js against real environments, then checks the target against the preview's predictions variant by variant (published version, schedule, workflow step). A "Copy as drafts" run fails if it sends any publishing request.

1. Create `.env.local` (git ignores it) with `SOURCE_ENVIRONMENT_ID`, `SOURCE_API_KEY`, `TARGET_ENVIRONMENT_ID` and `TARGET_API_KEY`. Don't prefix them with `VITE_`, which would put them into the browser bundle. Use keys limited to these environments, with a short expiry, and a **test environment as the target**.
2. Preview only (read-only): `npm run test:real -- plan <item codename> [more codenames]`
3. Copy and verify: `npm run test:real -- copy <item codename> --yes`. Without `--yes` it stops after the preview.

Options: `--languages=en-US,cs`, `--depth=N` or `--depth=all`, `--drafts`, `--skip-deleted`, `--cancel-after=N` (cancels after N imported variants) and `--verbose`. It doesn't cover browser-only behavior such as downloading and uploading asset files.

### Verified against real environments

Each of these matched the preview's predictions variant by variant:

- Both publishing options over items that are published with a newer draft in the target; "Copy as drafts" kept them published.
- A multilingual item whose linked items differ per language, with images in a folder the target lacks (uploaded to the root folder).
- A new item in four languages with different publishing states and a non-localizable element: the item was created once, and every variant and version kept its own value.
- A scheduled item in a different display time zone: "Match the source" reproduced the schedule exactly; "Copy as drafts" cancelled the target's schedule without publishing anything.
- A workflow step missing in the target, and a workflow the target's scopes require instead of the source's.
- Archived items: archived in the target when its workflow allows it, blocked when it doesn't, and copied as a draft next to the published version in "Copy as drafts".
- An item whose older published version links to a deleted item: detected by the preview, and copied with the skip option.
- Cancelling after the first imported variant: 1 copied, the rest cancelled, none failed.
- A large copy: 65 variants of 50 items in 24 languages.
- "All linked items", which stopped when no new items were left.
- The documented API key permissions, with keys limited to exactly them.
- Copying items with assets from the deployed site, with its security headers.
