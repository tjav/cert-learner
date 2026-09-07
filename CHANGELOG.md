# Changelog

Implementation changes for **Certification Learning** (`tjav.cert-learner`). Version headings do not imply that a GitHub Release has been published.

## 0.2.0 — local preview implementation

### Added

- **Learning: Add Course** now offers **Local folder** or **GitHub repository**, with a direct **Learning: Add Course from GitHub** command. GitHub input is an HTTPS repository-root URL with optional `.git`, not SSH, tree/blob, branch, credential-bearing, or parameterized URLs. Clones fetch only the default branch, shallowly.
- Trusted-workspace cloning with a parent-folder picker and exact-destination confirmation. A new repository-named child is created exclusively; existing destinations, even empty folders, are never overwritten. A valid root course manifest is required for registration. Failed/canceled clones retain any created destination, possibly partial, unregistered; a missing/invalid root manifest leaves the clone available for **Add Course → Local folder** on a valid subfolder.
- **Lab** and **Quiz** leaves under units, after activities, using the same functionality as the existing **Open lab / Open quiz** activity-panel buttons. Resource opening does not change activity selection, resume position, completion, or activity counts; notebooks open without execution.
- Interactive practice from version-1 structured JSON or the strict AI103 Markdown adapter. Single-choice radio clicks immediately show correct/incorrect feedback; multi-select uses checkboxes and **Check answer** at the exact required count. Grading uses exact set equality, authored correct options and explanations, one point per correct first submission, no partial credit, and no duplicate scoring.
- Quiz Previous/Next, results Summary, and Restart/Retry. Attempts survive panel close/reopen within the extension session, but not extension/VS Code restarts. They are excluded from course progress and exports; persistent quiz scores are intentionally not implemented. Source revisions invalidate previous attempts.
- Six-question [foundations structured sample](examples/foundations/quiz.json): five adaptations of the existing free-response questions plus a select-two safety question. Only the unit quiz declaration changes; the original [Markdown quiz](examples/foundations/quiz.md) stays unchanged as a root reference. Authoring docs link the existing quiz schema and specify the supported Markdown grammar.
- GitHub-clone and quiz parser/grader/panel test suites. This entry records implementation scope, **not a passing v0.2.0 test run**, live private-clone/browser acceptance, installation, packaging, or release evidence. Earlier validation remains historical.

### Safety and boundaries

- Private clones use previously configured trusted Git credential helpers noninteractively; sign in separately and never paste tokens into course input. No hooks, submodules, course checks, cells, dependency installs, or provisioning are run. Checkout uses isolated Git configuration to suppress filters. Trusted authentication helpers may run: this is not a whole-process sandbox.
- Unsupported/invalid quizzes show **Interactive quiz unavailable** and **Open source** when safely resolvable, without guessed answers. Feedback comes from authored source, not AI or current documentation; scores are practice results, not official exam results or certification evidence.
- The initial client HTML omits the full raw answer key; submitted-question feedback is revealed separately. Self-study source remains available, so this is not secure exam delivery.
- Existing unit/course progress reset behavior is unchanged. Quiz **Restart** clears only that in-memory attempt and does not reset learning progress or position. Adding/opening/navigating never automatically runs course code.

## 0.1.1 — local preview implementation

### Added

- Optional `CourseManifest.overview`, a safe course-root-relative Markdown path, with root README fallback only when the field is omitted and the file exists. An invalid explicit overview or unsafe/broken fallback is rejected. Existing manifests remain compatible with `format: "cert-learner"` and `schemaVersion: 1`.
- Tree ordering of overview first, authored units next, and manifest `resources` as reference leaves last, with duplicate page paths removed. Overview/reference pages contribute zero activities to counts and never change completion, activity selection, or resume position. Presentation-only exposure of the main overview does not require a `contentVersion` bump.
- Separate read-only `CoursePagePanel` using the sanitized Markdown renderer, **Reference · Not tracked**, and **Open source**. Images and local links are not loaded, HTTPS links require confirmation, and code/cleanup instructions never execute automatically.
- **Portal walkthrough** and **Revert unit** beside **Explain** / **Hint** in activity tools, plus `certLearner.portalWalkthrough` / `certLearner.revertUnit` commands and trusted-workspace activity context menus.
- Trust-gated availability for the two fixed existing course-local prompts under `.github/prompts/`; missing/invalid prompts disable the corresponding panel button and commands revalidate paths. No arbitrary prompt locations, symlinks, or junctions are accepted.
- Explicit **Prepare draft** modal before filling general Agent chat with a normal-language draft containing exact course root/prompt/manifest/lesson paths and course/unit/activity metadata, but no file bodies, environment values, or credentials. The learner selects general Agent mode, reviews, and submits; **Copy draft** is the fallback. This does not depend on global slash-command discovery.
- Course-page, activity-tool, and portable UI-action tests, plus expanded host smoke coverage for pages and state preservation. Check the current suites and actual run results; no current passing count or end-to-end Agent/browser validation is claimed here.

### Safety and boundaries

- Draft preparation runs no code, changes no files or progress, and never completes an activity. `@certlearning` remains the existing read-only, tool-free tutor; browser/file tools belong to the separately submitted general Agent workflow.
- Portal drafts request read-only navigation and separate explicit approval before changes or billable actions. Revert drafts require source and unsaved-work inspection, a verified authored baseline, a backup including unsaved work, and explicit confirmation before local discard; stop if baseline or backup cannot be verified.
- **Revert unit** is not built-in source restoration. Cancel active checks before using the extension's **Reset progress** separately; never edit hidden or legacy progress files or touch cloud resources. Output-only clearing remains a confirmed, undoable, unsaved native notebook edit, not an inferred source reset.
- This section describes v0.1.1 source changes, not publication, installation, or a successful release run. The initial validation numbers below belong only to v0.1.0.

## 0.1.0 — local preview

### Added

- Local-first, reusable course loading with schema metadata, safe resource resolution, workspace-root discovery, explicit folder registration, and two bundled sample packs.
- Learning tree and lesson panel with ordered navigation, objectives, resume position, current-activity counts, and distinct manual, locally verified, and imported completion states.
- Sanitized Markdown lessons with confirmation-gated HTTPS links; native Jupyter notebook and Markdown quiz handoff without automatic code execution.
- Explicit local Node/Python/PowerShell check tasks with trust/consent gates, local-code and cost warnings, user/machine runtime settings, cancellation/timeouts, and run-ID-bound result validation.
- Workspace-specific progress outside course repositories, canonical-root isolation, bounded validation, locking, atomic writes, and previous-good-state backups.
- Portable progress export/import for relocation, compatible same-root internal imports, and legacy AI103 v1 import with exact ID mapping. Imports preserve existing completion and never promote imported claims to locally verified results.
- Confirmed unit/course progress reset, with outstanding-check invalidation and no source-file or cloud-resource changes.
- Confirmed, undoable, **unsaved** notebook output clearing that preserves source content and non-execution metadata; existing dirty notebooks are refused.
- Optional `@certlearning /explain` and `/hint` using the selected model only after approval to share bounded lesson context; local/copy-prompt fallbacks when unavailable.
- Support for the separate 17-unit AI103 course's additive manifest metadata; AI103 completion remains manual, not an exam score or automated cloud assessment.
- Core/rendering/check-result tests and limited VS Code host smoke tests; configured Node 24 Ubuntu/Windows/macOS CI and a tag/version-gated private GitHub VSIX/checksum release workflow using SHA-pinned actions.
- Bundled third-party license notices derived from esbuild's actual dependency inputs.
- Cancellation checks at the progress commit boundary prevent a canceled check from saving a new verified completion before primary replacement.
- Packaged VSIX installed and its identifier/version verified in the maintainer's Discovery profile.

### Boundaries and pending work

- Partial v0.1, targeting local desktop VS Code APIs **1.103+**. **Historical initial v0.1.0 validation:** 82 passing tests and three permission-dependent skips; two smoke tests passed in both standard VS Code 1.136.1 and Discovery's VS Code 1.124.0 host. These are not v0.2.0 results; workflows alone are not evidence of passing runs.
- At v0.1.0: no scored quizzes, KaTeX/math rendering, pristine-exercise restore, cloud sync, telemetry backend, or automatic GitHub VSIX updates. Interactive practice grading is added in v0.2.0 above.
- Stale content versions stay flagged through navigation, completion, import, and reset. No content-version migration/acknowledgement workflow exists yet.
- Course references are declared links, **not fetched or freshly verified**. The extension tutor has no tools; the AI103 course's separate `/explain` prompt may use documentation tools in the general agent workflow.
- Path validation, sanitization, CSP, and workspace trust are not a sandbox. Course checks/notebooks may access credentials, use networks, delete resources, or incur charges. Review raw lesson comments before tutor sharing and exclude secrets/environment files/notebook outputs from distribution.
- Native notebook/tutor/check-lifecycle end-to-end coverage is not established by the limited host smoke suite. Course runtime/dependency prerequisites, including AI103 evaluation dependencies on Windows ARM64, remain separate from extension requirements.
- GitHub target [tjav/cert-learner](https://github.com/tjav/cert-learner) is **PRIVATE**, with creation/publication handled separately. Recipients need access; no visibility change is included.
- Version **0.1.0**, license **UNLICENSED** intentionally pending an owner decision. No Marketplace publication or actual release operation is recorded here.