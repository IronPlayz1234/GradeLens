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
- Expand a subject to see the scores, categories, weights, and last scan. A dash means there is insufficient evidence to calculate a grade for the selected term. **Provisional data** means coverage is incomplete, records need review, or manual weights are in use. **Stale cache** means the class term hasn’t been successfully scanned in at least 15 minutes or two refresh intervals, whichever is longer.
- **Settings** lets you override weights per class and set custom letter boundaries. Enter one `Name = number` per line. A letter scale needs a 0% boundary. Clear a field to return to the detected values or default letter scale.
- The estimator previews a future assessment as you type or move the slider. Select a category such as Semester Exam, then add a new assessment or replace an existing grade in the model. Save hypothetical assessments to combine several changes. **Reset** starts a fresh scenario with the default preview. **Restore actual grades** removes all hypothetical changes and the preview.
- A target score is conditional on the selected term, method, weights, scores, and add-or-replace choice. With Absolute Weights, a category percentage override represents its current graded task count, or one modeled task if it has no grades. Use task-level scores when the actual count matters.
- The default boundaries are A* ≥ 90, A ≥ 80, B ≥ 70, C ≥ 60, D ≥ 50, E ≥ 40, and U ≥ 0. Letter conversion uses full precision. ManageBac documents task and term grade scales separately, so the displayed letter and percentage are estimates. [ManageBac evaluation settings](https://help.managebac.com/hc/en-us/articles/360017950392-Configuring-Gradebook-Calculation-Options-Assessment-Models)

## Synchronization and privacy

The extension observes assessment changes in the open student page and scans when navigating or changing terms. When it can verify a student account from the visible profile menu, it also checks discovered class Tasks pages and link-backed Tasks & Deadlines pages with bounded, same-origin HTML requests. It picks up grades and grade edits exposed in those responses without opening individual assessment pages. The refresh interval defaults to five minutes and can be turned off in **Settings**. Automatic checks pause when ManageBac is hidden. **Last synced** is when the extension last successfully read assessment or configuration data, and each subject shows its own scan time.

Student grade records are stored in extension session storage under the school and verified student account. They clear when the browser session ends or the extension reloads. Preferences and optional account-scoped manual settings persist locally. When the account cannot be verified, extracted grades and overrides stay in the current document and refresh scans that document only. If the signed-in identity changes without a page reload, syncing pauses until you reload ManageBac. **Clear cached grades** removes the current account’s cached grades and manual overrides. The extension has no telemetry and makes no requests to non-ManageBac origins.

## Coverage and live verification

ManageBac can render the **Past** tab, term changes, and historical tasks after the initial HTML response. The extension observes the rendered page when you open it, while background checks can read only the authorized HTML returned for supported links. Sign-in redirects, client-rendered shells, unrecognized profile or term markers, and unavailable weights can limit coverage. Unknown-term scores are retained for review without an overall calculation. Older grade records survive partial scans. Removal requires an unfiltered class-term list with a verifiable total, matching term and no pagination or loading indicators. Polling can detect a published grade when the student page exposes it.

ManageBac describes the three workspace tabs and confirms that schools can choose whether to expose category averages to students. [Student task navigation](https://help.managebac.com/hc/en-us/articles/360018799612-Viewing-Task-deadlines-Submitting-Coursework), [Student grade visibility](https://help.managebac.com/hc/en-us/articles/360018801952-Tracking-your-Academic-Progress-Task-Grades-Report-Cards)

The project was tested with sanitized fixtures. In a signed-in school session, verify that the site exposes a recognizable profile identifier and academic term, that both sidebar links appear under Tasks & Deadlines, and that the compact cards sit above Latest Activity and the All Tasks charts. Check one class against its visible scores and weights, switch terms and charts, and confirm **Refresh now** reports what it could read.

## Files and tests

| Path | Contents |
| --- | --- |
| `manifest.json` | Manifest V3 permissions and entry points |
| `src/core/` | Grade algorithms, target solver, and cache reconciliation |
| `src/content/` | DOM extraction, synchronization, and native page integration |
| `src/ui/` | Dashboard, estimator, cards, theme detection, and design tokens |
| `src/storage.js` | Account-scoped session cache and refresh coordination |
| `tests/` | Calculation, HTML extraction, cache, and Chromium integration tests |

```sh
npm ci
npm test
npx playwright install chromium
npm run test:browser
```
