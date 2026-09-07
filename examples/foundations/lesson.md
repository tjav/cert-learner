# Foundations: manual progress and a local check

**Time:** about 5 minutes. **Cloud cost:** none. No account, network connection,
notebook, or package installation is needed. Node.js is needed only if you choose
to run the optional local check.

This is a **harmless learning-workflow demonstration**, not an actual exam
assessment, a cloud validator, or evidence of certification readiness.

## Activity 1: read and reason

Imagine two boxes. Each box holds two pencils. Count the pencils in the first box
(one, two), then continue through the second box (three, four). Adding the groups
gives **2 + 2 = 4**. No code execution is needed to reason about this.

### Exercise

1. Explain in one sentence why the two boxes contain four pencils altogether.
2. Suppose one pencil is removed. How many remain, and why?
3. Predict whether a script that only checks `2 + 2` could tell whether you
   understood that explanation.

You can answer on paper or aloud. Use **Open quiz** for recall questions and an
answer key. When ready, select the introductory activity and choose **Mark
complete**. This records your own report of learning; it does not verify it.

## Activity 2: inspect a local check

Open [check.cjs](check.cjs) in the editor before deciding whether to run it. The
script computes `2 + 2`, compares the result with `4`, and writes a small JSON
result to the **new result file supplied by the runner**. It echoes the supplied
run ID so the runner can associate that result with this attempt. It does not
read your answers, access credentials, call a network service, or change course
files. Its only file write is the requested result; an existing file is not
overwritten.

If a compatible Cert Learner build is installed, select the second activity and
choose **Run check** only after reviewing the script and confirmation. Checks
require a trusted workspace and explicit approval; they are not sandboxed.
You may decline and leave this activity incomplete. Manual completion is not
available for this check-based activity.

A pass demonstrates only that the local arithmetic check ran and returned a
passing result in the expected format. **It cannot assess your understanding or
any exam objective.** There are no cloud validators in this sample.

## Safe navigation and progress

**Zero auto-run:** adding this course, opening a lesson, changing activities, or
resetting progress must not run the script. **Previous** and **Next** navigate;
they do not complete activities. Use Learning UI **Reset progress** and review
the scope before confirming if you want to repeat an activity. Never edit hidden
extension storage. In courses with notebooks, choose your own kernel and review
individual cells; never blindly **Run All**, especially when cleanup cells exist.

To explore multiple courses, add the manifest in the sibling second-course
folder through **Learning: Add Course**, then select each course in **Learning**.
It uses different course and unit IDs and has its own introduction and progress.