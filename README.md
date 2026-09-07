# Cert Learner

**Certification Learning** is a local-first, reusable certification-course extension for desktop VS Code-compatible hosts. It connects local Markdown lessons, native Jupyter notebooks, and explicit progress records without requiring a learning service or Copilot account.

| Identity | Value |
| --- | --- |
| Extension ID | `tjav.cert-learner` |
| Implementation version | **0.1.0** |
| GitHub repository | [tjav/cert-learner](https://github.com/tjav/cert-learner), **PRIVATE** |
| License | **UNLICENSED**, intentionally pending a license decision; not an open-source license grant |
| Host API requirement | VS Code **1.103.0 or later**, within the declared `^1.103.0` range |

**Status: v0.1 local preview.** Local learning, progress, and check/tutor plumbing are implemented. Local validation: **82 tests passed**, with three file-symlink tests skipped because of Windows permissions. Two host smoke tests passed in both standard VS Code 1.136.1 and Discovery's VS Code 1.124.0 host: command registration and loading two courses/opening a lesson without executing code. The VSIX was installed and its version verified in the maintainer's Discovery profile. Native notebook maintenance and real tutor interactions still require user acceptance testing. A CI configuration alone is not evidence of a passing run. See [CHANGELOG.md](CHANGELOG.md) for scope.

## What v0.1 does

- Registers multiple local course manifests and shows a **Learning → Certification Courses** tree, ordered units/activities, completion counts, and a reusable lesson panel.
- Provides **Previous activity**, **Next activity**, and **Learning: Resume Course**. Navigation saves position; it never marks an activity complete.
- Distinguishes self-reported **manual**, locally **verified**, and **imported (not locally verified)** completion. Counts are activities, not exam scores or proof of competence.
- Opens declared labs in the host's native notebook editor and quizzes as Markdown text. There is **no scored quiz engine**.
- Runs a declared local check only after workspace trust and explicit confirmation, with a visible task terminal and cancellation/timeout handling.
- Exports portable progress and imports portable, same-root internal, or legacy AI103 records with validation and a confirmation preview.
- Offers optional `@certlearning /explain` and `@certlearning /hint`, with user-approved lesson sharing and local/copy-prompt fallbacks.

**Zero automatic course execution:** installing, adding a course, opening lessons/labs, and navigating do not run checks, notebook cells, provisioning, or cleanup. The extension has no automatic **Run All** action.

## Requirements and installation

### Learners

- Use a **local desktop host** exposing the required VS Code APIs. This version targets local files, not browser-only/virtual workspaces; Remote SSH, WSL, containers, and Codespaces are outside the supported v0.1 workflow.
- A packaged VSIX uses the host's extension runtime: **Node.js and npm are not required merely to install, read, navigate, or track progress**.
- Course checks need their declared runtime installed separately. The bundled arithmetic check needs **Node.js**; Python/PowerShell checks need those runtimes. Open a local folder/workspace before running checks, including the sample check.
- Labs have independent prerequisites: a notebook provider such as [Jupyter](https://marketplace.visualstudio.com/items?itemName=ms-toolsai.jupyter), the appropriate kernel, and course dependencies. Python labs typically also use the [Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python). Cert Learner neither installs dependencies nor selects a kernel.
- Copilot/chat and access to a selected language model are optional and needed only for tutoring. Reading and progress remain local without them.

### Install from a GitHub Release

Install the preview from the private repository's releases:

1. Sign in to GitHub with an account that has access to [tjav/cert-learner Releases](https://github.com/tjav/cert-learner/releases). **Recipients need private-repository access**; a release link does not make the package public.
2. Download the release's Cert Learner **VSIX** and **SHA256SUMS** checksum asset. Compare the VSIX's SHA-256 with the listed value before installing; a checksum detects changed bytes, not whether the code is trustworthy.
3. In the **actual desktop host you intend to use**, open **Extensions → … → Install from VSIX…**, select the downloaded package, and reload/restart extensions if prompted. The equivalent Command Palette action is **Extensions: Install from VSIX…**. Installing into a separate VS Code installation does not establish installation or compatibility in Discovery.
4. Confirm **Certification Learning**, ID `tjav.cert-learner`, appears in that host's installed extensions. Open **Learning**, or run **Learning: Try Sample Course**.

If no release is available to your account, request repository access or use the developer steps below. This project does not claim a Marketplace listing. **GitHub VSIX updates are manual:** download the next release and repeat installation in the same host. Export progress before changing host, workspace, or course location. No updater polls GitHub.

## Learn with a local course

1. Obtain and review a course pack locally. A [course.json manifest](examples/foundations/course.json#L1) immediately inside each local workspace root is discovered automatically; discovery is **not recursive**.
2. For another location, run **Learning: Add Course** and select the **course folder containing the manifest**, not an individual file. Explicit registrations are remembered for the current workspace. **Learning: Refresh Courses** reloads them; manifest changes also trigger refresh.
3. Expand the course and unit in **Learning → Certification Courses**, then select an activity. The panel shows that activity's objectives and the unit's declared lesson. Activities in one unit share its lesson/lab/quiz resources.
4. Read, navigate, and use **Mark complete** when ready for a manual activity. A `completion: "check"` activity disables manual completion and requires a passing check. A later failed/blocked check does not erase an existing completion.
5. **Open lab** hands off to the native notebook editor. Choose **Select Kernel** and run only cells you have reviewed. **Run All can include billable operations or deletion cells**; the learner, not this extension, controls execution.
6. **Open quiz** opens the declared Markdown file in the text editor. It does not collect answers, grade them, or auto-complete an activity.
7. Use **Learning: Resume Course** to return to a saved position. **Learning: Remove Course from List** retains files and progress; workspace-root courses reappear on refresh unless that workspace folder is removed.

### Included samples and AI103

- **Learning: Try Sample Course** registers [examples/foundations/course.json](examples/foundations/course.json): a manual activity, [examples/foundations/quiz.md](examples/foundations/quiz.md), and an optional local Node check. Inspect [examples/foundations/check.cjs](examples/foundations/check.cjs) before running it. It checks **2 + 2**, not learner answers or exam competence, and writes only its runner-supplied result file. No network or credentials are needed by this sample script.
- To demonstrate independent course progress, use **Learning: Add Course** on the folder containing [examples/second-course/course.json](examples/second-course/course.json). Neither bundled sample declares a notebook; lab controls are therefore unavailable in these samples.
- The separate private [AI103 learning repository](https://github.com/tjav/ai103-learning) has **17 units** with existing IDs/objectives and additive `format`, `schemaVersion`, and `contentVersion` metadata. Its current manifest defaults activities to manual completion and declares no automated cloud checks. It is a course pack, not bundled extension content; consult its own prerequisites and cleanup guidance.
- **Windows ARM64 course limitation:** the AI103 evaluation SDK dependency set cannot be installed/run as-is on native Windows ARM64 because of its pinned dependencies. Consult the [course's evaluation dependency notes](https://github.com/tjav/ai103-learning/blob/main/requirements-eval.txt) for a supported environment. This is separate from the extension's runtime and does not establish ARM64 host validation.

### Lesson rendering and references

The panel renders sanitized Markdown, including headings, tables, lists, code, and disclosure blocks. **There is no KaTeX/math renderer**: formulas have only plain Markdown/code support. Images, local links, scripts, and embedded media are not loaded. Safe HTTPS lesson links require confirmation before opening an external browser.

Study-guide metadata and references are **course-authored declarations, not live-fetched or freshly verified documentation**. Adding a course or using its tutor does not update or validate the currency of those pages. Supplemental top-level resources are validated, but there is no dedicated supplemental-resource browser in v0.1; open them through the course files.

## Progress, relocation, and reset

Automatic progress lives outside course/source repositories in the host-provided **`context.storageUri`** (workspace-specific extension storage). With no open workspace, the implementation falls back to a local subdirectory of **`context.globalStorageUri`**. Registration paths live in `workspaceState`. Progress is not a cloud account, repository file, or cross-workspace synchronization service.

- Local identity combines the **canonical course root and logical `courseId`**. Two copies at different real roots have separate records even if their logical ID is the same; Windows root casing is normalized. A different host/profile/workspace can also have different storage.
- **Relocation:** use **Learning: Export Progress** before moving, then register the matching course at the new location and use **Learning: Import Progress**. Portable exports use the logical `courseId`, not the root-bound ID, and omit local paths, lesson bodies, check output, and credentials. The save dialog initially suggests the course root: choose a private location outside the repository if the export should not be committed.
- Portable imports require matching logical course ID, current `contentVersion`, and known unit/activity IDs; the version must also match existing local progress. Old internal payloads remain root-bound. Legacy AI103 `version: 1` imports support exact doubled-unit keys and single-unit aliases, completion timestamps, and the optional position/`startedAt` envelope. There is no automatic legacy-file sync.
- Import previews and merges records, preserves existing completions, and takes the larger attempt count. Newly imported claims are **not locally verified**. Imported position is adopted only for fresh local state (revision zero, no completion records); it does not overwrite existing navigation.
- When a manifest's `contentVersion` changes, **stale progress remains flagged**. Historical IDs are retained, but counts include only currently declared activities. Navigation, checks, import, and reset do **not** advance the stored version or revalidate past work. Portable exports retain that historical version and cannot bypass version matching. **There is no content migration/acknowledgement workflow yet**; preserve exports and seek matching course content or maintainer guidance.

| Maintenance action | Actual effect |
| --- | --- |
| Panel **Reset progress** | After confirmation, clears the current **unit's** records and resets position to its first activity. |
| **Learning: Reset Course Progress** | After course selection and confirmation, clears **all that course's** records and resets its position. |
| **Clear lab outputs** | Requires trust and a clean, unchanged notebook; refuses existing unsaved edits. After confirmation, creates an **undoable, unsaved output-only edit** that removes outputs/execution metadata while preserving code, Markdown, cell IDs, attachments, and non-execution metadata. Review before saving; Undo restores the edit. |

Progress reset cancels outstanding checks for that course. It does **not** change lessons, notebooks, answers, outputs, or cloud resources. Output clearing does **not** restore a pristine exercise. There is no baseline restore, automatic source reversion, or cloud teardown feature.

The store uses bounded validation, exclusive locks, revision checks, atomic replacement, and a previous-good-state backup. Corrupt/unsupported state, missing-primary-with-backup, or an existing lock blocks writes rather than silently resetting progress. Check **Output → Cert Learner**; preserve affected data and seek maintainer-guided recovery. Backup recovery is manual. Never remove a stale lock until no writer remains. These protections are not encryption or an absolute guarantee against other local processes.

## Explicit local checks

**Checks run arbitrary course-authored code, not sandboxed code.** They can read/write local files, inherit credentials/environment, contact networks or cloud services, delete resources, and **incur charges**. Workspace trust, path validation, and a confirmation dialog are not isolation. Inspect the script and any dependencies before choosing **Run check**. Script output is visible in its task terminal; do not print secrets.

The runner uses a VS Code process task, not a manifest-supplied shell command. It validates paths, runtime settings, a unique run ID, and a bounded JSON result. Completion requires an exit code of zero plus a valid result whose overall status and all checks are `passed`. Invalid/missing/replayed results, unavailable execution, or timeout block success. Cancellation/reset invalidates pending completion; task termination is best effort, not rollback of filesystem or cloud side effects.

Configure these settings in **User/machine settings only**; workspace, folder, and language overrides are rejected:

| Setting | Default | Meaning |
| --- | --- | --- |
| `certLearner.runtimes.node` | `node` | Executable for Node checks. |
| `certLearner.runtimes.python` | `python` | Executable for Python checks; choose the intended environment explicitly. Not tied to the notebook kernel picker. |
| `certLearner.runtimes.pwsh` | `pwsh` | Executable for PowerShell checks. |

Each value is one unquoted executable name or absolute executable path, with **no arguments**, shell wrappers, or task-variable expressions. Runtime installation remains the learner's responsibility.

## Optional tutor and sharing boundary

Select an activity, then choose **Explain** or **Hint**. When supported, this fills the chat input with `@certlearning /explain` or `@certlearning /hint`; it does **not** secretly submit a request. Submit it yourself and approve **Share lesson** to contact the selected model. Every request requires trust and sharing consent.

The request contains current course/unit/activity titles and objectives, course-declared HTTPS references (including the study guide), and **up to 18,000 characters of the declared lesson**. The lesson must be a regular UTF-8 Markdown file no larger than 1 MiB. A request keeps the selected activity snapshot even if you navigate elsewhere.

**Review the raw lesson before sharing. Markdown/HTML comments can contain sensitive information even when invisible in the rendered panel.** Content limits and path checks are not secret detection or redaction. Only share material you are authorized to send to your selected model provider.

The tutor does not read other files, quiz files, lab outputs, chat history, or attached context; no tools are provided and no fallback model is invoked. It cannot run checks, alter progress, fetch references, or verify current documentation. Its output is rendered as inert text, generated URLs are omitted, and the host lists only **course references, not freshly verified**. Hints are requested to be short and non-solution; model correctness is not guaranteed.

If chat is unavailable, the UI can offer **Copy prompt** with titles/objectives only, without lesson text or a model call. If model access or sharing fails, continue locally. The AI103 course's existing standalone **`/explain` workspace prompt is separate**: it can use documentation tools in the general agent workflow. Its capabilities and context boundary must not be attributed to this extension's tool-free `@certlearning /explain` participant.

## Privacy and security boundaries

- **No Cert Learner telemetry backend, account service, or progress-upload service is implemented.** The host, Python/Jupyter extensions, selected model provider, GitHub, and course-authored programs have their own privacy/network behavior.
- Resource resolution rejects traversal, absolute/hidden/credential-like paths, and escaping symlinks. Lessons are sanitized; the webview has a restrictive CSP, no network loading, and nonce-authorized UI code. These are defense-in-depth controls, **not a sandbox for checks or notebooks**.
- Restricted Mode permits reading, navigation, manual completion, opening resources, and progress reset. Checks, tutor sharing, and output edits require a trusted workspace. Native notebook execution has its own host/provider controls.
- Keep credentials, environment files, private lesson comments, learner exports, terminal logs, and notebook outputs **out of distributed course packs and VSIX assets**. Do not bundle secrets or populated dotenv files. Review package contents and outputs before release; exclusion patterns in [.vscodeignore](.vscodeignore) are not a general secret scanner or notebook-output scrubber.
- Progress contains IDs, timestamps, completion source, attempt counts, and last status, not raw check messages/output. Those IDs/timestamps and manually exported files can still be sensitive. Review before sharing, and avoid putting secrets in course metadata.

## Course authoring

Use [schemas/course.schema.json](schemas/course.schema.json) and the [foundations](examples/foundations/course.json#L1) / [second-course](examples/second-course/course.json#L1) examples as the contract. Name the course-root manifest [course.json](examples/foundations/course.json#L1) so the editor schema and folder discovery apply. The loader also validates actual files and safe paths; JSON schema acceptance alone is insufficient.

| Scope | Fields and current behavior |
| --- | --- |
| Course, required | `format: "cert-learner"`, `schemaVersion: 1`, `contentVersion`, `courseId`, `title`, nonempty `units`. Content version is separate from extension version. |
| Course, optional | `studyGuideUrl`, `studyGuideVersion`, `language`, `references: [{title, url}]`, `resources: [{title, path}]`. URLs must pass safe HTTPS validation; supplemental resources must be Markdown. `language` is used for the panel's HTML language attribute, not kernel selection. |
| Unit | Required `unitId`, `displayNumber`, `title`, `resources`, nonempty `activities`; optional `domain` (string or null). Array order and authored display numbers are retained. |
| Unit resources | Required `lesson` (Markdown); optional `lab` (Jupyter notebook) and `quiz` (Markdown). All declared files must exist inside the course root. |
| Activity | Required `activityId`, `title`, `objectives` (string array, allowed to be empty). Optional `completion` is `manual` by default or `check`; the latter requires a `check` definition. A manual activity can also declare an optional check. |
| Check | Only `runtime`, `file`, optional `cwd`, optional `timeoutSeconds`. Runtime is `node`, `python`, or `pwsh`; no arbitrary arguments/command-line field. |

Unit IDs must be unique within a course; activity IDs within their unit. IDs/versions are bounded nonblank strings, not necessarily numeric or semantic versions. The manifest is limited to 2 MiB, 1,000 units/activities per unit, and 10,000 activities overall. General course/unit/activity metadata such as `$comment` and `weight` is preserved; it does not implement weighting or scoring. Check objects reject additional fields.

Paths use **course-root-relative forward slashes**, not absolute paths. Check `file` and `cwd` are both root-relative; omitted `cwd` or `"."` means the course root. Check script extensions must match the runtime: Node `.js`/`.cjs`, Python `.py`, PowerShell `.ps1`. The schema permits integer timeouts of **1–3,600 seconds**, but the current runner **caps execution at 300 seconds**, defaulting to 60. Do not author checks that rely on a longer run.

### Check arguments and result contract

The working Node example is [examples/foundations/check.cjs](examples/foundations/check.cjs), with its declaration in [examples/foundations/course.json](examples/foundations/course.json). It parses `--result` and `--run-id`, evaluates its local assertion, writes the runner-provided result exactly once, and exits nonzero on error. The runner supplies this process argument layout (placeholders, not commands to run manually):

- Node/Python: `-- <absolute-script> --result <temporary-result-path> --run-id <unique-run-id>`.
- PowerShell: `-NoLogo -NoProfile -NonInteractive -File <absolute-script> --result <temporary-result-path> --run-id <unique-run-id>`.

Write UTF-8 JSON to the supplied result path, echoing the **exact supplied run ID**, not a constant. The sample's result shape is:

```json
{
	"schemaVersion": 1,
	"runId": "<the supplied --run-id value>",
	"status": "passed",
	"checks": [
		{ "id": "addition", "status": "passed", "message": "2 + 2 equals 4" }
	]
}
```

Statuses are `passed`, `failed`, or `blocked`. The `checks` array must have 1–1,000 unique-ID entries, each with `id` and `status`; `message` is optional text. Extra fields are rejected, and results are limited to **64 KiB**. Overall `passed` requires every entry to pass. Merely printing JSON or exiting zero without a valid result is not enough. Temporary results are best-effort cleaned up; only summary status/attempts/completion are persisted, not messages.

## Development and validation

Developers need **Node.js 24**, npm, and a compatible local desktop host. From this repository's root, the intended setup/test/package sequence is:

```text
npm ci
npm test
npm run test:integration
npm run vsix
```

- `npm ci` installs the lockfile dependencies; it is a developer/CI step, not a learner requirement.
- `npm test` compiles tests, type-checks, lints, builds the extension, and runs the core, rendering/status, and check-result validation suites without a VS Code runtime.
- `npm run test:integration` compiles tests and launches a downloaded VS Code test host. Its current smoke tests cover command registration, two course packs, opening without task execution, and public-state path omission. They do **not** constitute full notebook/tutor/check-lifecycle validation. The configuration disables other extensions and workspace trust; it is not a Discovery/Jupyter compatibility test. Internet access and a graphical host environment are required; headless Linux uses `xvfb-run -a npm run test:integration`.
- `npm run vsix` invokes VSCE, whose prepublish hook type-checks, lints, and creates the production bundle. It creates a local VSIX; it **does not publish** to GitHub or Marketplace. License checking is deliberately skipped while the package remains `UNLICENSED`.

For debugging, open this repository in the intended desktop host, select **Run Extension**, and press **F5**. [.vscode/launch.json](.vscode/launch.json) runs the **build** prelaunch task from [.vscode/tasks.json](.vscode/tasks.json) (`npm run compile`) before opening an Extension Development Host. Inspect the sample there; this is separate from installing and validating the packaged VSIX.

After test compilation, `npm run validate-course -- examples/foundations/course.json` validates the sample through the same loader as the extension. Pass another local manifest path to validate a course pack; validation does not execute its checks. Workspace recommendations in [.vscode/extensions.json](.vscode/extensions.json) cover development tools and optional Python/Jupyter handoff, not automatic installation or mandatory learner dependencies.

### Source map

| Files | Responsibility |
| --- | --- |
| [src/extension.ts](src/extension.ts) | Activation, registry, commands, progress actions, native notebook handoff, check coordination, optional tutor. |
| [src/core/course.ts](src/core/course.ts), [src/core/validation.ts](src/core/validation.ts) | Manifest/schema validation, bounded input, safe resource resolution, root-bound identity. |
| [src/core/progress.ts](src/core/progress.ts) | Local store, locking/backups, completion records, portable/internal/legacy imports and resets. |
| [src/runner.ts](src/runner.ts), [src/checkResult.ts](src/checkResult.ts) | Confirmed process tasks, timeout/cancellation, run-bound result validation. |
| [src/ui/tree.ts](src/ui/tree.ts), [src/ui/status.ts](src/ui/status.ts), [src/ui/panel.ts](src/ui/panel.ts), [src/ui/render.ts](src/ui/render.ts) | Course navigation/status, panel, Markdown sanitization. |
| [media/learning.js](media/learning.js), [media/learning.css](media/learning.css) | Panel interactions and host-themed styling. |
| [src/validateCourse.ts](src/validateCourse.ts), [schemas/course.schema.json](schemas/course.schema.json) | Headless course validation and editor schema. |
| [src/test/core.test.ts](src/test/core.test.ts), [src/test/render.test.ts](src/test/render.test.ts), [src/test/runner.test.ts](src/test/runner.test.ts), [src/test/extension.test.ts](src/test/extension.test.ts) | Pure suites and limited host smoke tests. |
| [package.json](package.json), [esbuild.js](esbuild.js), [.vscode-test.mjs](.vscode-test.mjs), [.vscodeignore](.vscodeignore) | Extension contributions/scripts, bundling, test-host configuration, packaging exclusions. |

### CI and private releases

[.github/workflows/ci.yml](.github/workflows/ci.yml) configures Node 24 on **Ubuntu, Windows, and macOS** for pushes and pull requests: `npm ci`, `npm test`, Linux Xvfb/native host integration tests, then VSIX packaging. It uses `contents: read` and publishes no artifacts or releases.

[.github/workflows/release.yml](.github/workflows/release.yml) responds to **`v*` tags** on Ubuntu. It requires the tag to equal `v` plus the package version (for this implementation, `v0.1.0`), repeats tests including Xvfb integration, packages the VSIX, calculates SHA-256 checksums, and uses the runner's GitHub CLI to create a release with those assets and generated notes. Both workflows pin checkout/setup-node to full commit SHAs. Only the release job has `contents: write`; its publishing step uses the built-in GitHub token, **not a PAT or Azure authentication**. Checkout does not persist credentials.

Repository creation, access grants, target-host validation, package-content review, and tag publication remain maintainer responsibilities. These workflows do not create a repository, change visibility, or grant recipients access. **No release run, published asset, or passing cross-platform result is implied by these files.**

## Not implemented / roadmap

The working local flow is only part of the intended product. There are currently no scored quizzes, KaTeX rendering, pristine-exercise restoration, content-version migration/acknowledgement, automatic documentation refresh/verification, cloud progress sync, or automatic GitHub VSIX updates. Host smoke tests are not full end-to-end notebook, task-lifecycle or tutor validation. Roadmap items are not promises or release dates.

## License

[package.json](package.json) deliberately declares **UNLICENSED** while the owner decides licensing. Private repository access and the ability to download a VSIX do not grant a public/open-source redistribution license. Course packs and third-party dependencies have separate terms. No public visibility change or license choice is made by this implementation.

The build includes license notices for bundled dependencies in the VSIX. Missing dependency license files fail the packaging build rather than silently dropping attribution.
