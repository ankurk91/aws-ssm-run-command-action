#!/usr/bin/env bash
set -euo pipefail

# Drives the action against moto and asserts its output contract and the shape of the script it
# sends. moto answers SendCommand with a canned Success/0 and never runs anything, so execution
# identity stays covered by .github/workflows/ec2.yaml against a real instance.

export AWS_PAGER=""
export AWS_ACCESS_KEY_ID=test_id
export AWS_SECRET_ACCESS_KEY=test_key
export AWS_DEFAULT_REGION=ap-south-1
export AWS_REGION=ap-south-1
export AWS_ENDPOINT_URL=${AWS_ENDPOINT_URL:-http://localhost:4566}
S3_BUCKET_NAME=ssm-deployment-logs

RUN_AS_USER=ssmtest

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT
FAILURES=0

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

# core.setOutput writes `name<<delimiter`, the value, then the delimiter again.
output_value() {
  awk -v key="$1" 'index($0, key "<<") == 1 { getline; print; exit }' "$GITHUB_OUTPUT"
}

# Runs the action, never aborting the suite on a non-zero exit: the failure paths are assertions
# too. Leaves the exit status in ACTION_STATUS and the log in $WORK_DIR/action.log.
run_action() {
  export GITHUB_OUTPUT="$WORK_DIR/outputs"
  : > "$GITHUB_OUTPUT"
  set +e
  env "$@" node ./src/index.js > "$WORK_DIR/action.log" 2>&1
  ACTION_STATUS=$?
  set -e
}

echo "Ensuring S3 bucket..."
aws s3api head-bucket --bucket "$S3_BUCKET_NAME" 2>/dev/null \
  || aws s3 mb "s3://$S3_BUCKET_NAME" --output text

echo "Creating EC2..."
INSTANCE_ID=$(
  aws ec2 run-instances \
    --image-id ami-12345678 \
    --instance-type t3.micro \
    --query 'Instances[0].InstanceId' \
    --output text
)
echo "EC2 ID: $INSTANCE_ID"

export INPUT_EC2_INSTANCE_ID="$INSTANCE_ID"
export INPUT_LOG_BUCKET_NAME="$S3_BUCKET_NAME"
export INPUT_RUN_AS_USER="$RUN_AS_USER"
export INPUT_POLL_INTERVAL_MS=200

# Built to break out: standalone lines matching the old and the current delimiter, a nested
# heredoc, quoting that must survive verbatim, and a non-zero exit to propagate. `id -un` is
# evaluated on the remote side, so every line reports which shell actually ran it.
read -r -d '' COMMANDS <<'PAYLOAD_EOF' || true
echo "identity-first: $(id -un)"
INNER
END-OF-SSM-PAYLOAD
cat <<'INNER'
nested-heredoc-body
INNER
echo "quoting: 'single' \"double\" `hostname` \backslash plaintext-marker"
echo "to-stderr" >&2
echo "identity-last: $(id -un)"
exit 7
PAYLOAD_EOF
export INPUT_COMMANDS="$COMMANDS"

echo
echo "Running the action..."
run_action

echo
echo "Action contract"
if [ "$ACTION_STATUS" -eq 0 ]; then
  pass "action exits 0 against moto"
else
  fail "action exited $ACTION_STATUS"
  cat "$WORK_DIR/action.log"
fi

if [ "$(output_value command-status)" = "Success" ]; then
  pass "command-status output is Success"
else
  fail "command-status output is '$(output_value command-status)', expected Success"
fi

if [ "$(output_value command-exit-code)" = "0" ]; then
  pass "command-exit-code output is 0"
else
  fail "command-exit-code output is '$(output_value command-exit-code)', expected 0"
fi

echo
echo "Script sent to SSM"
COMMAND_ID=$(sed -n 's/^Command ID: //p' "$WORK_DIR/action.log" | head -1)
if [ -z "$COMMAND_ID" ]; then
  fail "no command was sent, so nothing below can be checked"
  exit 1
fi

aws ssm list-commands --command-id "$COMMAND_ID" \
  --query 'Commands[0].Parameters.commands[0]' --output text > "$WORK_DIR/sent.sh"

if [ -s "$WORK_DIR/sent.sh" ]; then
  pass "script retrieved from moto ($COMMAND_ID)"
else
  fail "could not retrieve the sent script"
fi

if grep -q 'plaintext-marker' "$WORK_DIR/sent.sh"; then
  fail "raw command text was interpolated into the script"
else
  pass "commands appear only as an encoded payload"
fi

# The heredoc opener and its terminator, and nothing else: a payload line cannot add a third.
if [ "$(grep -c 'END-OF-SSM-PAYLOAD' "$WORK_DIR/sent.sh")" -eq 2 ]; then
  pass "delimiter appears exactly twice"
else
  fail "delimiter appears $(grep -c 'END-OF-SSM-PAYLOAD' "$WORK_DIR/sent.sh") times, payload can close it"
fi

sed -n "/<<'END-OF-SSM-PAYLOAD'/,/^END-OF-SSM-PAYLOAD$/p" "$WORK_DIR/sent.sh" \
  | sed '1d;$d' > "$WORK_DIR/payload.b64"

if [ -z "$(tr -d 'A-Za-z0-9+/=\n' < "$WORK_DIR/payload.b64")" ]; then
  pass "payload stays inside the base64 alphabet"
else
  fail "payload contains characters outside the base64 alphabet"
fi

printf 'exec 2>&1\n%s\n' "$COMMANDS" > "$WORK_DIR/expected"
base64 -d < "$WORK_DIR/payload.b64" > "$WORK_DIR/decoded"
if diff -q "$WORK_DIR/expected" "$WORK_DIR/decoded" > /dev/null; then
  pass "payload decodes to the commands verbatim, with stderr merged"
else
  fail "decoded payload differs from the commands"
  diff "$WORK_DIR/expected" "$WORK_DIR/decoded" | head -20
fi

echo
echo "Input validation"
run_action INPUT_RUN_AS_USER='deploy; rm -rf /'
if [ "$ACTION_STATUS" -ne 0 ] && grep -q 'Invalid run_as_user' "$WORK_DIR/action.log"; then
  pass "an invalid run_as_user is rejected"
else
  fail "an invalid run_as_user was accepted"
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "All checks passed."
else
  echo "$FAILURES check(s) failed."
  exit 1
fi
