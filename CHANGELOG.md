# Changelog

Implementation changes for **Certification Learning** (`tjav.cert-learner`). Version headings do not imply that a GitHub Release has been published.

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

- Partial v0.1, targeting local desktop VS Code APIs **1.103+**. Local validation: 82 passing tests and three permission-dependent skips; two smoke tests passed in both standard VS Code 1.136.1 and Discovery's VS Code 1.124.0 host. Workflows alone are not evidence of passing runs.
- No scored quizzes, KaTeX/math rendering, pristine-exercise restore, cloud sync, telemetry backend, or automatic GitHub VSIX updates.
- Stale content versions stay flagged through navigation, completion, import, and reset. No content-version migration/acknowledgement workflow exists yet.
- Course references are declared links, **not fetched or freshly verified**. The extension tutor has no tools; the AI103 course's separate `/explain` prompt may use documentation tools in the general agent workflow.
- Path validation, sanitization, CSP, and workspace trust are not a sandbox. Course checks/notebooks may access credentials, use networks, delete resources, or incur charges. Review raw lesson comments before tutor sharing and exclude secrets/environment files/notebook outputs from distribution.
- Native notebook/tutor/check-lifecycle end-to-end coverage is not established by the limited host smoke suite. Course runtime/dependency prerequisites, including AI103 evaluation dependencies on Windows ARM64, remain separate from extension requirements.
- GitHub target [tjav/cert-learner](https://github.com/tjav/cert-learner) is **PRIVATE**, with creation/publication handled separately. Recipients need access; no visibility change is included.
- Version **0.1.0**, license **UNLICENSED** intentionally pending an owner decision. No Marketplace publication or actual release operation is recorded here.