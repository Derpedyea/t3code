# Derped fork nightlies

The fork checks upstream's published nightly releases every 15 minutes. It merges the newest
nightly tag into a candidate based on fork `main`, preserving the provider settings and Devin
changes. Passing CI and desktop builds are required before the candidate advances `main` and
the release becomes public. Download the first fork nightly or select the Nightly update
channel in the desktop app. Unsigned macOS builds still require manual installation.

GitHub Actions uses a write-enabled deploy key scoped to `Derpedyea/t3code`, with its private
key stored in the `FORK_SYNC_SSH_KEY` Actions secret. This is necessary because the built-in
Actions token cannot push changes to workflow files. The built-in token dispatches and reads
CI runs; no personal GitHub token or paid model key is required.

If a merge, check, or build fails, a temporary runner invokes OpenCode with
`opencode/muse-spark-1.3-contributor-free`. Each run allows up to three repair attempts, each limited
to 30 minutes and 80 agent steps, followed by fresh CI on a branch tied to that commit. The agent receives neither the deploy key nor the
GitHub token. It cannot edit the sync workflow or running orchestrator. The last published
release remains available if the repair fails.

Failed nightlies retry automatically on subsequent schedules. Only a published release
counts as complete; a failed attempt or draft release does not stop later retries. CI startup
timeouts leave code alone and retry on the next schedule. To start a retry sooner, open
**Actions → Sync Upstream Nightly → Run workflow**. Enable **Retry** only to rebuild a nightly
that has already been published. Failure logs and each repair transcript are retained as
workflow artifacts for 14 days. To pause syncing, disable that workflow in Actions. To revoke
its write access, remove the nightly deploy key under repository **Settings → Deploy keys**.
