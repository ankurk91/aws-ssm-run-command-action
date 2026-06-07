# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

A GitHub Action that executes remote shell commands on an EC2 instance via AWS
SSM Run Command (`AWS-RunShellScript`), streaming the command output to an S3
bucket to avoid the ~24 KB step-log limit. Linux targets only. No SSH / port 22.

It is a Node.js action (`runs.using: node24`) bundled with `@vercel/ncc`.

## Layout

| Path                 | Purpose                                                                                                                                  |
|----------------------|------------------------------------------------------------------------------------------------------------------------------------------|
| `src/index.js`       | Main entrypoint. Sends the command, polls for completion, fetches logs from S3, sets the exit-code output.                               |
| `src/cancel.js`      | Post step. Runs only on workflow cancellation (`post-if: cancelled()`) and cancels the in-flight SSM command using the saved command ID. |
| `action.yaml`        | Action metadata: inputs, outputs, and the `main`/`post` bundle paths.                                                                    |
| `dist/`              | **Generated** by `ncc`. Never edit by hand. `dist/main/` and `dist/cancel/`.                                                             |
| `localstack.sh`      | Local/CI integration test driver against LocalStack.                                                                                     |
| `docker-compose.yml` | LocalStack service for local testing.                                                                                                    |
| `.env.example`       | Sample env vars (`INPUT_*`) for running `src/index.js` locally.                                                                          |

## Build & test

- Package manager is **pnpm** (see `packageManager` in `package.json`). Use `pnpm install --frozen-lockfile`.
- Node version is pinned in `.nvmrc` and `engines` (Node >= 24.11).
- **`npm run build`** — bundles both entrypoints via ncc into `dist/`. **Any change under `src/` requires a rebuild**,
  because `action.yaml` runs the `dist/` bundle, not `src/`. Commit the regenerated `dist/`.
- `npm start` — runs `src/index.js` locally with `--env-file=.env` (copy `.env.example` to `.env` first).
- There is no unit-test suite (`npm test` is a placeholder). Integration testing is done via LocalStack:
  - Locally: `docker compose up -d` then `bash ./localstack.sh`.
  - CI: `.github/workflows/localstack.yaml` (runs on push/PR to main).
  - `.github/workflows/ec2.yaml` is a manual (`workflow_dispatch`) test against a real EC2 instance.

## How the action works (key flow in `src/index.js`)

1. Reads inputs via `@actions/core`. `run_as_user` is validated against `^[A-Za-z0-9_-]+$` before use.
2. Builds a bash `SCRIPT` that runs the user `commands` as `run_as_user` inside a `sudo -u ... bash <<'INNER'` heredoc.
3. `SendCommand` with `OutputS3BucketName`/`OutputS3KeyPrefix` so the agent writes logs to S3. Saves the command ID via
   `core.saveState` (consumed by `cancel.js`).
4. Polls `GetCommandInvocation` every `poll_interval_ms` until status leaves `Pending`/`InProgress`/`Delayed`.
5. Fetches `stdout`/`stderr` objects from S3 and prints them in log groups.
6. Sets the `command-exit-code` output; calls `core.setFailed` on non-zero exit.

## Conventions & gotchas

- **ESM only** (`"type": "module"`). Use `import`, and prefer `node:`-prefixed builtins (e.g. `node:stream/consumers`).
- **2-space indent, LF, final newline, trim trailing whitespace** — enforced by `.editorconfig`. JS uses 1TBS brace
  style and spaces around operators.
- **SSM naming quirk**: the API `PluginName` is `aws:runShellScript` (with colon), but the S3 key path uses
  `awsrunShellScript` (no colon). Both forms are correct — don't "fix" one to match the other.
- AWS credentials/region come from the default SDK provider chain (set up via `aws-actions/configure-aws-credentials` in
  CI). `AWS_ENDPOINT_URL` is used to point at LocalStack.
- Keep `README.md` inputs/outputs tables and `action.yaml` in sync when changing inputs.

## Do not

- Edit anything in `dist/` directly — regenerate with `npm run build`.
