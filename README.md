# ManageBac Grade Calculator

A private Chrome extension for students at `uia.managebac.com`. It adds **Overall Grades** and **Grade Estimator** below **My Workspace → Tasks & Deadlines**. Class Overview gets a compact grade card, and Class Tasks gets a second card inside **All Tasks**, above the native charts.

## Install locally

1. In Chrome or a Chromium-based browser, open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the project folder that contains `manifest.json`.
4. Open or reload a signed-in student page on `https://uia.managebac.com`.
5. Open **Overall Grades** and choose the academic term and calculation method. The method applies across all four grade views.
6. Open **Class Tasks** or **Tasks & Deadlines → Past** if grades or weights are missing. Scroll or use the site’s controls to load additional historical tasks. Click **Refresh now** under **Overall Grades** or **Grade Estimator** to check available pages again.

The project folder is the unpacked extension. It runs without a build, npm install, or development server. After changing files, click the reload arrow on the extension in `chrome://extensions`, then reload the ManageBac tab.

## Grades and what-if scenarios

- **Percentage Weights** averages individual task percentages per category. **Points-Based Averaging** pools points per category. **Absolute Weights** applies the category weight to each task. A category contributes only when it has a usable score and positive weight. A valid zero counts.
- Enrolled subjects use the same scanner and the categories and weights shown for that class and term. The calculator uses earned and maximum assignment points. Letter-only grades, individual rubric criteria, and missing or malformed point values do not produce percentages. **No grade available** means there is insufficient evidence to calculate a grade. A genuine zero with a usable maximum displays as **0.00%**.
- Expand a subject to see the scores, categories, weights, and last scan. An information icon explains whether the task list could be verified or a score or category needs attention. **Last sync out of date** means the class term hasn’t been successfully scanned in at least 15 minutes or two refresh intervals, whichever is longer.
- **Settings** lets you override weights per class and set custom letter boundaries. Enter one `Name = number` per line. A letter scale needs a 0% boundary. Clear a field to return to the detected values or default letter scale.
- The estimator previews a future assessment as you type or move the slider. Select a category such as Semester Exam, then add a new assessment or replace an existing grade in the model. Save hypothetical assessments to combine several changes. **Reset** starts a fresh scenario with the default preview. **Clear predictions** removes all hypothetical changes and the preview.
- A target score is conditional on the selected term, method, weights, scores, and add-or-replace choice. With Absolute Weights, a category percentage override represents its current graded task count, or one modeled task if it has no grades. Use task-level scores when the actual count matters.
- The default boundaries are A* ≥ 90, A ≥ 80, B ≥ 70, C ≥ 60, D ≥ 50, E ≥ 40, and U ≥ 0. Letter conversion uses full precision. ManageBac documents task and term grade scales separately, so the displayed letter and percentage are estimates. [ManageBac evaluation settings](https://help.managebac.com/hc/en-us/articles/360017950392-Configuring-Gradebook-Calculation-Options-Assessment-Models)

## Synchronization and privacy

Overall Grades shows a loader with actual discovery and collection milestones when no estimate is ready. As classes can be discovered during synchronization, the progress bar stays indeterminate. Returning students can use cached grade cards while the dashboard shows **Updating grades…**. An unsuccessful attempt with no usable estimates offers **Retry**.

Open **Overall Grades** or **Grade Estimator** to start cross-class synchronization. The extension reads enrolled class links and published term controls from student-visible navigation and linked class listings. It makes at most three concurrent HTML requests, delays request starts, and shares a per-account refresh lease across tabs. Unchanged responses are identified by ETag or by a local content fingerprint before reparsing. Native Class Tasks pages still update from rendered scores as you use them.

If a Tasks page or roster redirects, returns an HTML shell, or exposes rows while scripts are still loading points or weights, synchronization can try a bounded same-origin rendered read in an invisible frame. The account, class, term, and score evidence still have to match before grades are accepted. After frame load, it watches DOM changes for up to 4.5 seconds. Inside this frame it may open a single clearly labeled term menu to read its selected ID. The active tab and its term selection stay under the student’s control. When a task list displays a letter and links to an assignment result, each refresh can check up to four such results, starting with the least recently checked. This lets a corrected numerical score arrive even if the class list HTML stays the same. The extension cancels obsolete automatic work on navigation and while a tab is hidden. ManageBac may block framing or render a different set of data when unattended. The dashboard reports these failures and retains the last verified result.

The extension service worker stores verified grades in private IndexedDB, separated by school, student account, class, term, and assessment. Grade records survive browser restarts and extension reloads. Partial reads can add records and supply missing details. A rendered class row with verified class, term, assessment, category and numerical points can correct that assessment even on a partial list. Deleting absent records requires an authoritative complete list. Empty unattended reads preserve previously collected grades. Stale responses cannot roll back newer observations. **Clear cached grades** removes the current account’s stored grades and manual overrides. If the account cannot be verified, data stays in the current document. No telemetry or private endpoint requests are used.

When the student pages expose only the generic self-profile link, the extension checks the signed-in ManageBac profile. It uses a verified account ID or a local fingerprint of the account email displayed on that profile. The extension keeps the raw email out of the grade cache and diagnostics. It rechecks the profile before committing grade batches that rely on this fallback.

**Current class terms** resolves each subject from its own verified term. An explicit term selection filters by its actual ID. Subject details show the number of usable grades, the last successful read, the source (rendered student page, background HTML, or cache), completeness and freshness, and any sync failure.

## Troubleshoot sync

Open the affected class’s **Tasks** tab and wait for **All Tasks** to render. Open **Overall Grades** or **Grade Estimator** from that tab, click **Refresh now**, then expand **Sync details**. It shows counts for candidate rows, recognized assessment links, usable point scores, missing or invalid scores, and category weights. It also shows whether the selected term, native chart, and session cache were recognized. The diagnostic summary contains no names, assessment titles, scores, URLs, or account identifiers.

A visible semester label alone cannot identify a term. The extension looks for an ID in the selected option, the selected menu item’s metadata or native link, or the class Tasks URL. A letter-only chart likewise does not provide earned and maximum points. If the student cache fails, the extension keeps the grades it can read in the current document and retries on refresh.

## Coverage and live verification

ManageBac can render the **Past** tab, term changes, and historical tasks after the initial HTML response. The extension observes the rendered page when you open it, while background checks can read only the authorized HTML returned for supported links. Sign-in redirects, client-rendered shells, unrecognized profile or term markers, and unavailable weights can limit coverage. The corresponding subject is marked partial if neither background nor bounded rendered reads expose verifiable results. Unknown-term scores are retained for review without an overall calculation. Older grade records survive partial scans. Removal requires an unfiltered class-term list with a verifiable total, matching term and no pagination or loading indicators. Polling can detect a published grade when the student page exposes it.

ManageBac describes the three workspace tabs and confirms that schools can choose whether to expose category averages to students. [Student task navigation](https://help.managebac.com/hc/en-us/articles/360018799612-Viewing-Task-deadlines-Submitting-Coursework), [Student grade visibility](https://help.managebac.com/hc/en-us/articles/360018801952-Tracking-your-Academic-Progress-Task-Grades-Report-Cards)

The project was tested with sanitized fixtures. In a signed-in school session, verify that the site exposes a recognizable profile identifier and academic term, that both sidebar links appear under Tasks & Deadlines, and that the compact cards appear within class content and above the All Tasks charts. Start from the student home page and open Overall Grades before visiting any class. Expand each subject and compare its last successful sync, term, count and source with the current session. A cached percentage alone does not verify that automatic retrieval succeeded. Check one class against its visible scores and weights, switch terms and charts, and confirm **Refresh now** reports what it could read.

## Files and tests

| Path | Contents |
| --- | --- |
| `manifest.json` | Manifest V3 permissions and entry points |
| `src/core/` | Grade algorithms, target solver, and cache reconciliation |
| `src/content/` | DOM extraction, synchronization, and native page integration |
| `src/ui/` | Dashboard, estimator, cards, theme detection, and design tokens |
| `src/storage.js`, `src/repository.js` | Refresh coordination and transactional, account-scoped grade storage |
| `tests/` | Calculation, HTML extraction, cache, and Chromium integration tests |

```sh
npm ci
npm test
npx playwright install chromium
npm run test:browser
```

The browser suite defaults to Playwright’s Chrome for Testing build. For a secondary Opera GX check on macOS, launch the same fixtures with a temporary profile using `MBGC_BROWSER_PATH='/Applications/Opera GX.app/Contents/MacOS/Opera' npm run test:browser`.
