# Cert Learner

**Certification Learning** is a local-first, reusable certification-course extension for desktop VS Code-compatible hosts. It connects local Markdown lessons, native Jupyter notebooks, interactive practice quizzes, and explicit progress records without requiring a learning service or Copilot account.

| Identity | Value |
| --- | --- |
| Extension ID | `tjav.cert-learner` |
| Implementation version | **0.2.0** |
| GitHub repository | [tjav/cert-learner](https://github.com/tjav/cert-learner), **PRIVATE** |
| License | **UNLICENSED**, intentionally pending a license decision; not an open-source license grant |
| Host API requirement | VS Code **1.103.0 or later**, within the declared `^1.103.0` range |

**Status: v0.2.0 preview.** Adds confirmed GitHub course cloning, unit-level Lab/Quiz children, and interactive practice grading. Local validation: 242 tests passed (15 Windows permission-dependent skips), plus 11 real editor-host tests. All 245 questions across the 17 AI103 quizzes load, including 36 multi-answer questions. A live private-repository clone and destination-collision refusal were verified with the actual clone implementation and simulated editor dialogs. Browser checks exercised the actual quiz panel's correct/incorrect feedback, multi-select grading, results, and retry. Native notebook maintenance, tutor interactions, and general Agent handoffs still require user acceptance testing. See [CHANGELOG.md](CHANGELOG.md) for scope.

## What v0.2.0 does

- Adds courses from a **Local folder** or a confirmed **GitHub repository** clone, then shows a **Learning → Certification Courses** tree, ordered units/activities, completion counts, and a reusable lesson panel.
- Shows **Course overview** first, then units, then manifest-declared supplemental resource leaves. Overview/reference pages are read-only and **Not tracked**; they contribute zero activities to completion counts and do not change resume position.
- Provides **Previous activity**, **Next activity**, and **Learning: Resume Course**. Navigation saves position; it never marks an activity complete.
- Distinguishes self-reported **manual**, locally **verified**, and **imported (not locally verified)** completion. Counts are activities, not exam scores or proof of competence.
- Shows declared **Lab** and **Quiz** children under each unit, after its activities. Labs open in the native notebook editor; supported quizzes offer click grading and authored explanations. Neither resource is a tracked activity.
- Runs a declared local check only after workspace trust and explicit confirmation, with a visible task terminal and cancellation/timeout handling.
- Exports portable progress and imports portable, same-root internal, or legacy AI103 records with validation and a confirmation preview.
- Offers optional `@certlearning /explain` and `@certlearning /hint`, with user-approved lesson sharing and local/copy-prompt fallbacks.
- Adds **Portal walkthrough** and **Revert unit** alongside **Explain** / **Hint** in **Activity tools**. After an explicit modal confirmation, they prepare a draft for general Agent chat, not an automatic action or progress reset.

**Zero automatic course execution:** installing, adding a course, opening lessons/labs/quizzes, and navigating do not run checks, notebook cells, provisioning, or cleanup. The extension has no automatic **Run All** action.

## Requirements and installation

### Learners

- Use a **local desktop host** exposing the required VS Code APIs. This version targets local files, not browser-only/virtual workspaces; Remote SSH, WSL, containers, and Codespaces are outside the supported v0.2.0 workflow.
- A packaged VSIX uses the host's extension runtime: **Node.js and npm are not required merely to install, read, navigate, or track progress**.
- GitHub cloning additionally requires installed **Git**, network/repository access, and a trusted workspace. Local-folder registration and quiz grading do not require Git or Copilot.
- Course checks need their declared runtime installed separately. The bundled arithmetic check needs **Node.js**; Python/PowerShell checks need those runtimes. Open a local folder/workspace before running checks, including the sample check.
- Labs have independent prerequisites: a notebook provider such as [Jupyter](https://marketplace.visualstudio.com/items?itemName=ms-toolsai.jupyter), the appropriate kernel, and course dependencies. Python labs typically also use the [Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python). Cert Learner neither installs dependencies nor selects a kernel.
- Copilot/chat and access to a selected language model are optional, needed only for tutoring or submitting activity-tool drafts. General Agent mode and its browser/file tools are needed for the standalone guided workflows; the extension does not provide those tools. Reading and progress remain local without them.

### Install from a GitHub Release

Install the preview from the private repository's releases:

1. Sign in to GitHub with an account that has access to [tjav/cert-learner Releases](https://github.com/tjav/cert-learner/releases). **Recipients need private-repository access**; a release link does not make the package public.
2. Download the release's Cert Learner **VSIX** and **SHA256SUMS** checksum asset. Compare the VSIX's SHA-256 with the listed value before installing; a checksum detects changed bytes, not whether the code is trustworthy.
3. In the **actual desktop host you intend to use**, open **Extensions → … → Install from VSIX…**, select the downloaded package, and reload/restart extensions if prompted. The equivalent Command Palette action is **Extensions: Install from VSIX…**. Installing into a separate VS Code installation does not establish installation or compatibility in Discovery.
4. Confirm **Certification Learning**, ID `tjav.cert-learner`, appears in that host's installed extensions. Open **Learning**, or run **Learning: Try Sample Course**.

If no release is available to your account, request repository access or use the developer steps below. This project does not claim a Marketplace listing. **GitHub VSIX updates are manual:** download the next release and repeat installation in the same host. Export progress before changing host, workspace, or course location. No updater polls GitHub.

## Add a course and learn

1. Obtain and review a course pack locally. A [course.json manifest](examples/foundations/course.json#L1) immediately inside each local workspace root is discovered automatically; discovery is **not recursive**.
2. Run **Learning: Add Course**, choose **Local folder**, and select the **course folder containing the manifest**, not an individual file. Alternatively choose **GitHub repository** as described below. Explicit registrations are remembered for the current workspace. **Learning: Refresh Courses** reloads them; manifest changes also trigger refresh.
3. Expand the course in **Learning → Certification Courses**. Read **Course overview** if available, or expand a unit and select an activity. The activity panel shows its objectives and the unit's declared lesson; activities in one unit share its lesson/lab/quiz resources. Supplemental reference leaves follow the units and can be opened without selecting an activity.
4. Read, navigate, and use **Mark complete** when ready for a manual activity. A `completion: "check"` activity disables manual completion and requires a passing check. A later failed/blocked check does not erase an existing completion.
5. Choose the unit's **Lab** child or the activity panel's **Open lab** button for the same native notebook handoff. Choose **Select Kernel** and run only reviewed cells. **Run All can include billable operations or deletion cells**; the learner controls execution.
6. Choose the unit's **Quiz** child or the activity panel's **Open quiz** button for the same interactive practice panel. **Lab/Quiz are unit resources, not activities**: opening either does not change the current activity, resume position, completion, or activity counts. **Open source** in the quiz opens its authored file for reading.
7. Use **Learning: Resume Course** to return to a saved position. **Learning: Remove Course from List** retains files and progress; workspace-root courses reappear on refresh unless that workspace folder is removed.

### Add from GitHub

Choose **Learning: Add Course → GitHub repository**, or **Learning: Add Course from GitHub**. Enter only an HTTPS repository-root URL such as `https://github.com/owner/repo` (optional `.git` suffix). SSH URLs, `/tree/` or `/blob/` links, branch/subfolder URLs, credentials, and URL parameters are not accepted. Only the **default branch** is fetched, as a shallow, single-branch clone; this is not an update/sync feature.

Choose an existing local **parent folder**, review the exact destination in the confirmation, then choose **Clone course**. A new child named after the repository is created; **any existing destination is refused, even an empty folder**. The root course manifest must validate before the clone is registered. If the root manifest is missing or invalid, the clone is retained; use **Add Course → Local folder** to select a valid course subfolder if applicable. Failed or canceled operations retain any destination already created, possibly partial, **without registering it**; review it manually rather than expecting a retry to overwrite it.

For private repositories, sign in separately using Git/Git Credential Manager and configure a trusted credential helper beforehand. Cloning is noninteractive; **never paste a token or password into the URL/input**. It requires workspace trust and confirmation. Fetching skips checkout; the subsequent checkout uses isolated Git configuration to suppress filters. Hooks, submodules, course checks, notebook cells, requirements installation, and provisioning are not run. Only the ordered generic/URL-scoped credential helper, username and HTTP-path settings are preserved for authentication; helper values are never printed or saved in the course. Trusted preconfigured Git credential helpers may run: **this is not a whole-process sandbox**.

### Interactive practice quizzes

- **Single answer:** clicking a radio choice immediately submits it and displays **Correct** or **Incorrect**, the correct option, and the authored explanation. **Multiple answers:** select checkboxes, then **Check answer**, enabled only at the exact displayed choice count. Correctness requires set equality with all authored correct options; order does not matter.
- Each question awards **one point for a correct first valid submission**, otherwise zero. No partial credit, repeated-click points, or regrading on revisit. **Previous** reviews answers; **Next** advances after submission; **Finish quiz / Summary** shows results after all questions are answered. **Restart / Retry quiz** starts a new attempt, with confirmation when answers exist.
- Submitted answers, position, and score survive closing/reopening the quiz in the **same extension session**. They do not survive an extension/VS Code restart and are not included in progress exports or course completion. **Persistent quiz scores are intentionally not implemented yet.** Source edits invalidate the old attempt when the source is reread on opening or an action. A refreshed manifest change or removal of its course invalidates the open quiz and requires reopening, so questions and Open source never silently point at different revisions.
- Grading uses only the **source author's answer key and explanations**, not AI or freshly fetched documentation. Correctness here is not certification, an official exam result, or proof of competence. The full raw answer key is not sent in the initial client HTML; feedback is revealed for the submitted question. **Open source** still exposes self-study material, so this is not a secure exam system.
- Supported sources are structured JSON or the strict [AI103 Markdown grammar](#ai103-markdown-compatibility), not arbitrary Markdown quizzes. Unsupported/invalid content shows **Interactive quiz unavailable** and **Open source** when the file safely resolves. No answers are guessed.

### Included samples and AI103

- **Learning: Try Sample Course** registers [examples/foundations/course.json](examples/foundations/course.json): two activities and a six-question [structured quiz](examples/foundations/quiz.json). The first five adapt the original pencil arithmetic, manual-completion, limited-check-evidence, and no-auto-run questions; the sixth demonstrates **select exactly two** safety choices. The unchanged [examples/foundations/quiz.md](examples/foundations/quiz.md) remains a readable top-level reference, not the interactive unit quiz. Inspect [examples/foundations/check.cjs](examples/foundations/check.cjs) before running it. It checks $2 + 2$, not learner answers or competence, and writes only its runner-supplied result file; it needs no network or credentials.
- To demonstrate independent course progress, use **Learning: Add Course → Local folder** on the folder containing [examples/second-course/course.json](examples/second-course/course.json). Neither bundled sample declares a notebook; lab controls are therefore unavailable in these samples.
- The separate private [AI103 learning repository](https://github.com/tjav/ai103-learning) has **17 units** with existing IDs/objectives and additive `format`, `schemaVersion`, and `contentVersion` metadata. Its current manifest defaults activities to manual completion and declares no automated cloud checks. It is a course pack, not bundled extension content; consult its own prerequisites and cleanup guidance.
- **Windows ARM64 course limitation:** the AI103 evaluation SDK dependency set cannot be installed/run as-is on native Windows ARM64 because of its pinned dependencies. Consult the [course's evaluation dependency notes](https://github.com/tjav/ai103-learning/blob/main/requirements-eval.txt) for a supported environment. This is separate from the extension's runtime and does not establish ARM64 host validation.

### Overview, reference pages, and lesson rendering

An optional `CourseManifest.overview` names a course-root-relative Markdown file. If omitted, the loader uses the root README when it exists; if neither exists, there is no overview. An explicitly missing or unsafe overview is rejected, not silently replaced by the fallback. A broken or unsafe fallback is also rejected.

The tree orders **Course overview → authored units → top-level `resources`** in manifest order, deduplicating identical page paths. These supplemental resources are now browsable as reference leaves. The separate read-only `CoursePagePanel` shows **Reference · Not tracked** and **Open source**, which opens the underlying Markdown in the text editor. Opening a page or its source neither selects an activity nor changes completion or resume position. Overview/reference pages contribute **zero** to activity counts; even a teardown page only displays instructions and never executes cleanup.

Lesson, reference, and quiz panels use the sanitized Markdown renderer for headings, tables, lists, code, and disclosure blocks. **There is no KaTeX/math renderer**: formulas have only plain Markdown/code support. Images, local links, course scripts, and embedded media are not loaded; displayed code never runs automatically. Safe HTTPS links require confirmation before opening an external browser. Use **Open source** or the course files for local navigation unavailable in the rendered reference page.

Study-guide metadata and HTTPS `references` are **course-authored declarations, not live-fetched or freshly verified documentation**. They are distinct from local Markdown `resources` pages. Adding a course, reading a reference page, or using the tutor does not update or validate documentation currency.

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
| Quiz **Restart / Retry quiz** | Clears only that quiz's session-memory answers and score, with confirmation when answers exist. Does not reset course progress or learning position. |
| **Clear lab outputs** | Requires trust and a clean, unchanged notebook; refuses existing unsaved edits. After confirmation, creates an **undoable, unsaved output-only edit** that removes outputs/execution metadata while preserving code, Markdown, cell IDs, attachments, and non-execution metadata. Review before saving; Undo restores the edit. |
| Activity tools **Revert unit** | After trust, prompt validation, and modal confirmation, prepares a general Agent chat **draft only**. Clicking it does not restore files, clear outputs, or reset progress. Any later source discard requires a verified authored baseline, a backup including unsaved work, and separate explicit approval. |

Progress reset behavior is unchanged: it cancels outstanding checks for that course but does **not** change lessons, notebooks, quiz attempts, answers, outputs, or cloud resources. Quiz **Restart** is separate. Output clearing does **not** restore a pristine exercise. The extension has no built-in baseline restore, automatic source reversion, or cloud teardown feature; **Revert unit** is a draft handoff, not a restore engine. Use the extension's **Reset progress** separately if you also want to reset the selected unit's learning record.

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

### Portal walkthrough and Revert unit: general Agent drafts

Select an activity, then choose **Portal walkthrough** or **Revert unit** in **Activity tools**. The equivalent commands are **Learning: Portal Walkthrough** (`certLearner.portalWalkthrough`) and **Learning: Revert Unit** (`certLearner.revertUnit`); trusted-workspace activity context menus also expose them. Palette commands use the current activity.

Both require workspace trust and the corresponding existing course-local prompt at the fixed location `.github/prompts/portal-walkthrough.prompt.md` or `.github/prompts/revert-unit.prompt.md`. Missing or invalid prompts disable the corresponding panel button; commands revalidate availability and refuse invalid paths. This narrow hidden-path exception accepts only the two regular Markdown files (up to 128 KiB), with no symlinks or junctions in their paths. It does not enable arbitrary manifest prompt paths or hidden-file browsing.

The modal **Prepare draft** confirmation authorizes only filling chat input. The normal-language draft includes the **exact local course root, prompt path, manifest path, and lesson path**, plus course/unit/activity IDs, titles, authored display number, content version, objectives, and completion mode. It includes **no file bodies, environment values, or credentials**. Paths and metadata can still be sensitive: review them before sharing. Metadata is presented as untrusted data, not instructions.

**Select general Agent mode, review the draft, and submit it yourself.** The extension neither automatically submits nor equips the read-only `@certlearning` participant with browser/file tools. A normal-language request names the exact prompt file; global slash-command discovery is not required, including for courses outside the current workspace. If the Agent cannot access those paths, it must ask rather than substitute another course. After submission it is asked to read the specified prompt, manifest, and lesson, so that later Agent workflow has a different context/tool boundary from draft preparation. If chat cannot open, **Copy draft** offers the same text without submitting or executing it.

- **Portal walkthrough:** asks for read-only browser navigation by default and explicit approval before any resource change or billable action; secrets must not be entered into chat or exposed in browser captures.
- **Revert unit:** asks the Agent to compare source and unsaved editor/notebook work against a verified authored baseline, preserve a recoverable backup including unsaved work, explain the exact unit-scoped changes, and obtain explicit confirmation before discarding anything. Zero outputs do not prove untouched source, and arbitrary Git `HEAD` is not an authored baseline. If baseline or backup cannot be verified, stop source restoration rather than guess empty exercise cells. Cancel active checks before a separate Learning UI **Reset progress**; never edit hidden or legacy progress files or touch cloud resources.

Preparing either draft changes **no files or progress**, runs no code, and never marks an activity complete. Prompt guidance and later Agent approvals are not a filesystem or cloud sandbox.

## Privacy and security boundaries

- **No Cert Learner telemetry backend, account service, or progress-upload service is implemented.** The host, Python/Jupyter extensions, selected model provider, GitHub, and course-authored programs have their own privacy/network behavior.
- Resource resolution rejects traversal, absolute/hidden/credential-like paths, and escaping symlinks. Lessons are sanitized; the webview has a restrictive CSP, no network loading, and nonce-authorized UI code. These are defense-in-depth controls, **not a sandbox for checks or notebooks**.
- Restricted Mode permits reading, navigation, manual completion, opening resources, practice grading, and progress reset. GitHub cloning, checks, tutor sharing, activity-tool drafts, and output edits require a trusted workspace. Native notebook execution has its own host/provider controls.
- Keep credentials, environment files, private lesson comments, learner exports, terminal logs, and notebook outputs **out of distributed course packs and VSIX assets**. Do not bundle secrets or populated dotenv files. Review package contents and outputs before release; exclusion patterns in [.vscodeignore](.vscodeignore) are not a general secret scanner or notebook-output scrubber.
- Progress contains IDs, timestamps, completion source, attempt counts, and last status, not raw check messages/output. Those IDs/timestamps and manually exported files can still be sensitive. Review before sharing, and avoid putting secrets in course metadata.

## Course authoring

Use [schemas/course.schema.json](schemas/course.schema.json) and the [foundations](examples/foundations/course.json#L1) / [second-course](examples/second-course/course.json#L1) examples as the contract. Name the course-root manifest [course.json](examples/foundations/course.json#L1) so the editor schema and folder discovery apply. The loader also validates actual files and safe paths; JSON schema acceptance alone is insufficient.

| Scope | Fields and current behavior |
| --- | --- |
| Course, required | `format: "cert-learner"`, `schemaVersion: 1`, `contentVersion`, `courseId`, `title`, nonempty `units`. Content version is separate from extension version. |
| Course, optional | `overview` (root-relative Markdown path, otherwise root README fallback if present), `studyGuideUrl`, `studyGuideVersion`, `language`, `references: [{title, url}]`, `resources: [{title, path}]`. URLs must pass safe HTTPS validation; overview and supplemental resource pages must be Markdown. `language` is used for the activity panel's HTML language attribute, not kernel selection. |
| Unit | Required `unitId`, `displayNumber`, `title`, `resources`, nonempty `activities`; optional `domain` (string or null). Array order and authored display numbers are retained. |
| Unit resources | Required `lesson` (Markdown); optional `lab` (Jupyter notebook) and `quiz` (structured JSON or supported Markdown). All declared files must exist inside the course root. Lab/Quiz leaves do not add tracked activities. |
| Activity | Required `activityId`, `title`, `objectives` (string array, allowed to be empty). Optional `completion` is `manual` by default or `check`; the latter requires a `check` definition. A manual activity can also declare an optional check. |
| Check | Only `runtime`, `file`, optional `cwd`, optional `timeoutSeconds`. Runtime is `node`, `python`, or `pwsh`; no arbitrary arguments/command-line field. |

Overview and resource pages are presentation-only, not units or activities: they add **zero** to completion counts and do not store progress or change resume position. The optional overview is compatible with `format: "cert-learner"`, `schemaVersion: 1`; existing manifests need no new required fields. Merely exposing the existing main overview does **not** require a `contentVersion` bump. Review versioning separately for substantive learning-content changes.

Unit IDs must be unique within a course; activity IDs within their unit. IDs/versions are bounded nonblank strings, not necessarily numeric or semantic versions. The manifest is limited to 2 MiB, 1,000 units/activities per unit, and 10,000 activities overall. General course/unit/activity metadata such as `$comment` and `weight` is preserved; it does not implement weighting or scoring. Check objects reject additional fields.

Paths use **course-root-relative forward slashes**, not absolute paths. Check `file` and `cwd` are both root-relative; omitted `cwd` or `"."` means the course root. Check script extensions must match the runtime: Node `.js`/`.cjs`, Python `.py`, PowerShell `.ps1`. The schema permits integer timeouts of **1–3,600 seconds**, but the current runner **caps execution at 300 seconds**, defaulting to 60. Do not author checks that rely on a longer run.

### Structured quiz authoring

Use [schemas/quiz.schema.json](schemas/quiz.schema.json) and the complete [foundations quiz](examples/foundations/quiz.json). Point the unit's `resources.quiz` to its course-root-relative JSON path; top-level `resources` remain Markdown references. Minimal select-two example:

```json
{
	"schemaVersion": 1,
	"title": "Safe local practice",
	"questions": [
		{
			"id": "safe-check",
			"prompt": "Select two safe steps before running a course check.",
			"options": [
				{ "id": "A", "text": "Inspect the script." },
				{ "id": "B", "text": "Assume trust prevents all side effects." },
				{ "id": "C", "text": "Review the explicit run confirmation." }
			],
			"correctOptionIds": ["A", "C"],
			"explanation": "Inspect the script and review the confirmation. Workspace trust is not a sandbox."
		}
	]
}
```

All shown fields are required; extra properties are rejected. Use 1–200 questions, 2–8 options per question, unique question IDs and unique option IDs within each question. IDs are at most 128 characters, without surrounding whitespace or control characters. `correctOptionIds` is a nonempty, duplicate-free subset of that question's option IDs; its length determines the required selection count. A two-answer question needs **exactly both** answers, with no partial credit. Supply nonblank title, prompt, option text, and explanation. The schema defines field limits; source files must be regular UTF-8, at most 1 MiB, safely inside the course root. Text is sanitized Markdown data, never executable code.

### AI103 Markdown compatibility

The [adapter](src/core/quiz.ts) accepts only this grammar; it is not a general quiz importer:

- Start with an unindented `# Title`. Optional introductory prose may precede questions (and an optional `---` before the first question).
- Number questions consecutively from 1 using exact `**1.** Prompt` markers. Prompts may wrap. Supply 2–8 options in contiguous A–H order using `- A. Text`. Wrapped option lines must start with **exactly two spaces**, immediately after a nonblank option line; do not insert prose between options.
- End each question's options with one or two exact `---` separator lines. Blank lines between structural items are allowed. No extra headings, code fences, or alternative question/option marker styles before Answers.
- Use the exact heading `## Answers`. Keys must align consecutively, one per question: `**1 — A.** Explanation` or `**1 — A and C.** Explanation` (em dash, period inside bold). Up to three unique known labels joined by ` and ` are supported.
- A prompt saying **choose/select two/2** or **choose/select three/3** requires that many keyed answers; conflicting counts are rejected. Otherwise exactly one answer is required. Explanations must be a single nonempty paragraph of wrapped lines, without blank-line-separated continuation, lists, or fences. Optional one/two `---` separators may follow an explanation.
- A subsequent H2 such as `## Lab exercise solutions` ends parsing; that tail is not graded. Duplicate Answers sections or malformed/missing keys in the parsed section are rejected. The same structured field limits apply. Unsupported sources stay readable through **Open source** when safe, not guessed into questions.

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
- `npm test` compiles tests, type-checks, lints, builds the extension, and runs core, rendering/status, runner/check-result, course-page, activity-tool, quiz parsing/grading/panel, GitHub-clone, and portable UI-action suites. UI-action tests exercise compiled panels with the VS Code boundary mocked; no real host is launched. These are suite descriptions, not v0.2.0 passing-run claims.
- `npm run test:integration` compiles tests and launches a downloaded VS Code test host. Its current smoke tests cover command registration, two course packs, overview/reference ordering and activity-only counts, page selection validation, unchanged progress/resume state, opening without task execution, and public-state path omission. They do **not** constitute full notebook/tutor/check-lifecycle or general Agent/browser workflow validation. The configuration disables other extensions and workspace trust; it is not a Discovery/Jupyter compatibility test. Internet access and a graphical host environment are required; headless Linux uses `xvfb-run -a npm run test:integration`.
- `npm run vsix` invokes VSCE, whose prepublish hook type-checks, lints, and creates the production bundle. It creates a local VSIX; it **does not publish** to GitHub or Marketplace. License checking is deliberately skipped while the package remains `UNLICENSED`.

**Historical validation — initial v0.1.0 only:** 82 local tests passed, with three Windows file-symlink permission skips. Two host smoke tests passed in standard VS Code 1.136.1 and Discovery's VS Code 1.124.0 host (command registration and two-course/lesson opening without code execution). The v0.1.0 VSIX was installed and its identifier/version verified in the maintainer's Discovery profile. These are not v0.2.0 test, installation, or release results.

For debugging, open this repository in the intended desktop host, select **Run Extension**, and press **F5**. [.vscode/launch.json](.vscode/launch.json) runs the **build** prelaunch task from [.vscode/tasks.json](.vscode/tasks.json) (`npm run compile`) before opening an Extension Development Host. Inspect the sample there; this is separate from installing and validating the packaged VSIX.

After test compilation, `npm run validate-course -- examples/foundations/course.json` validates the sample through the same loader as the extension. Pass another local manifest path to validate a course pack; validation does not execute its checks. Workspace recommendations in [.vscode/extensions.json](.vscode/extensions.json) cover development tools and optional Python/Jupyter handoff, not automatic installation or mandatory learner dependencies.

### Source map

| Files | Responsibility |
| --- | --- |
| [src/extension.ts](src/extension.ts) | Activation, registry, commands, progress actions, native notebook handoff, check coordination, optional tutor. |
| [src/core/course.ts](src/core/course.ts), [src/core/validation.ts](src/core/validation.ts) | Manifest/schema validation, bounded input, safe resource resolution, root-bound identity. |
| [src/core/githubCourse.ts](src/core/githubCourse.ts), [src/githubCourse.ts](src/githubCourse.ts) | Strict GitHub URLs, confirmed new-folder clone, isolated checkout, and root-manifest validation. |
| [src/core/quiz.ts](src/core/quiz.ts), [schemas/quiz.schema.json](schemas/quiz.schema.json), [src/ui/quizPanel.ts](src/ui/quizPanel.ts), [src/ui/quizRender.ts](src/ui/quizRender.ts), [media/quiz.js](media/quiz.js), [media/quiz.css](media/quiz.css) | Source parsing, exact-set grading, session-memory attempts, and interactive quiz UI. |
| [src/core/pages.ts](src/core/pages.ts), [src/ui/coursePage.ts](src/ui/coursePage.ts) | Overview/reference projection and separate read-only page panel; no progress tracking. |
| [src/core/activityTools.ts](src/core/activityTools.ts) | Fixed local prompt availability, exact-path validation, and metadata-only general Agent drafts. |
| [src/core/progress.ts](src/core/progress.ts) | Local store, locking/backups, completion records, portable/internal/legacy imports and resets. |
| [src/runner.ts](src/runner.ts), [src/checkResult.ts](src/checkResult.ts) | Confirmed process tasks, timeout/cancellation, run-bound result validation. |
| [src/ui/tree.ts](src/ui/tree.ts), [src/ui/status.ts](src/ui/status.ts), [src/ui/panel.ts](src/ui/panel.ts), [src/ui/render.ts](src/ui/render.ts) | Course navigation/status, panel, Markdown sanitization. |
| [media/learning.js](media/learning.js), [media/learning.css](media/learning.css) | Panel interactions and host-themed styling. |
| [src/validateCourse.ts](src/validateCourse.ts), [schemas/course.schema.json](schemas/course.schema.json) | Headless course validation and editor schema. |
| [src/test/core.test.ts](src/test/core.test.ts), [src/test/render.test.ts](src/test/render.test.ts), [src/test/runner.test.ts](src/test/runner.test.ts), [src/test/pages.test.ts](src/test/pages.test.ts), [src/test/activityTools.test.ts](src/test/activityTools.test.ts), [src/test/uiActions.test.ts](src/test/uiActions.test.ts), [src/test/extension.test.ts](src/test/extension.test.ts) | Portable suites, mocked UI actions, and limited real-host smoke tests. |
| [package.json](package.json), [esbuild.js](esbuild.js), [.vscode-test.mjs](.vscode-test.mjs), [.vscodeignore](.vscodeignore) | Extension contributions/scripts, bundling, test-host configuration, packaging exclusions. |

### CI and private releases

[.github/workflows/ci.yml](.github/workflows/ci.yml) configures Node 24 on **Ubuntu, Windows, and macOS** for pushes and pull requests: `npm ci`, `npm test`, Linux Xvfb/native host integration tests, then VSIX packaging. It uses `contents: read` and publishes no artifacts or releases.

[.github/workflows/release.yml](.github/workflows/release.yml) responds to **`v*` tags** on Ubuntu. It requires the tag to equal `v` plus the package version (for this implementation, `v0.2.0`), repeats tests including Xvfb integration, packages the VSIX, calculates SHA-256 checksums, and uses the runner's GitHub CLI to create a release with those assets and generated notes. Both workflows pin checkout/setup-node to full commit SHAs. Only the release job has `contents: write`; its publishing step uses the built-in GitHub token, **not a PAT or Azure authentication**. Checkout does not persist credentials.

Repository creation, access grants, target-host validation, package-content review, and tag publication remain maintainer responsibilities. These workflows do not create a repository, change visibility, or grant recipients access. **No release run, published asset, or passing cross-platform result is implied by these files.**

## Not implemented / roadmap

There is no persistent quiz-score storage/export, secure-exam mode, KaTeX rendering, pristine-exercise restoration, content-version migration/acknowledgement, automatic documentation refresh/verification, cloud progress sync, or automatic GitHub course/VSIX updating. Host smoke tests are not full end-to-end notebook, task-lifecycle or tutor validation. Roadmap items are not promises or release dates.

## License

[package.json](package.json) deliberately declares **UNLICENSED** while the owner decides licensing. Private repository access and the ability to download a VSIX do not grant a public/open-source redistribution license. Course packs and third-party dependencies have separate terms. No public visibility change or license choice is made by this implementation.

The build includes license notices for bundled dependencies in the VSIX. Missing dependency license files fail the packaging build rather than silently dropping attribution.
