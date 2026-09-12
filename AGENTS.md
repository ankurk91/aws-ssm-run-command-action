# AGENTS.md

Non-obvious notes only. Usage, inputs, outputs and IAM are in `README.md`; behaviour is in `src/`.

## Layout

| Path                                | What it is                                                 |
|-------------------------------------|------------------------------------------------------------|
| `src/index.js`                      | Main entrypoint (`runs.main`)                              |
| `src/cancel.js`                     | Post step (`runs.post`), cancels the in-flight SSM command |
| `action.yaml`                       | Action metadata: inputs, outputs, bundle paths             |
| `dist/main/`, `dist/cancel/`        | ncc bundles — generated, never hand-edit                   |
| `localstack.sh`                     | Integration test driver                                    |
| `docker-compose.yml`                | LocalStack service for local testing                       |
| `.env.example`                      | Sample `INPUT_*` vars for running `src/index.js` locally   |
| `.github/workflows/localstack.yaml` | CI, on push/PR                                             |
| `.github/workflows/ec2.yaml`        | Manual (`workflow_dispatch`) test against a real EC2       |

## Rules

- `action.yaml` runs `dist/`, not `src/`. Rebuild with `pnpm run build` after any `src/` change,
  and commit `dist/` as its own `build` commit.
- Route remote output through `printUntrusted()` — never `core.info` / `core.warning` /
  `core.setFailed`. Issue groups and annotations outside the fence, not inside it.
- `cancel.js` warns, never `setFailed` — it runs on `always()`.
- Branch on `Status`, not the exit code. `ResponseCode` is null for Undeliverable / TimedOut /
  Terminated / Cancelled and collapses into the 255 sentinel.
- `PluginName` is `aws:runShellScript` (colon), the S3 key path is `awsrunShellScript` (no colon).
  Both are correct — don't "fix" either to match.
- Keep the `README.md` tables in sync with `action.yaml`.

## Notes

- Local run: copy `.env.example` to `.env`, then `npm start`. LocalStack: `docker compose up -d`
  then `bash ./localstack.sh`.
