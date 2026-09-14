import * as core from '@actions/core'
import {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand
} from '@aws-sdk/client-ssm'
import {S3Client, GetObjectCommand} from '@aws-sdk/client-s3'
import { text } from 'node:stream/consumers';
import process  from 'node:process';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

const ssm = new SSMClient()
// LocalStack only resolves path-style S3 URLs; virtual-hosted-style requests
// (bucket.localhost) fail with NoSuchBucket. Enable path-style only when a
// custom endpoint is set so real AWS keeps using the default addressing.
const s3 = new S3Client({
  forcePathStyle: Boolean(process.env.AWS_ENDPOINT_URL)
})

const sleep = ms => new Promise(r => setTimeout(r, ms))

// The runner parses this process's stdout for `::workflow-command::` directives, so any
// line the remote host prints would otherwise be executed as a runner directive
// (`::add-mask::`, `::error::`, `::save-state::`, ...). `::stop-commands::<token>` makes
// the runner treat everything up to the matching token as literal text. The token is a
// fresh UUID per call so remote output cannot close the fence it is wrapped in.
//
// Our own workflow commands are inert inside the fence too, which is why the group and
// any annotation are issued outside it and only the untrusted body goes within.
function printUntrusted(title, body) {
  const token = randomUUID()

  core.startGroup(title)
  core.info(`::stop-commands::${token}`)
  try {
    core.info(body)
  } finally {
    core.info(`::${token}::`)
    core.endGroup()
  }
}

async function streamToString(stream) {
  return await text(stream);
}

async function fetchS3(bucket, key) {
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key
    }))
    return await streamToString(res.Body)
  } catch (error) {
    const statusCode = error?.$metadata?.httpStatusCode
    if (error?.name === 'AccessDenied' || statusCode === 403) {
      throw new Error(`Access denied reading s3://${bucket}/${key}. Check the EC2 instance and pipeline IAM permissions on the log bucket.`)
    }
    // NoSuchKey / missing object is expected (e.g. no stderr produced)
    core.debug(`Unable to fetch from s3://${bucket}/${key}: ${error?.name ?? error}`)
    return null
  }
}

// `commands` is encoded, not interpolated: the payload cannot close the heredoc and escape the
// target user's shell into the outer (root) SSM shell. No pipe either, so `set -e` still catches
// a `base64` failure instead of feeding the child an empty script and reporting a green deploy.
function buildRemoteScript(runAsUser, commands) {
  // `exec 2>&1` merges stderr into stdout so interleaved output keeps its chronological order.
  const encoded = Buffer
    .from(`exec 2>&1\n${commands}\n`, 'utf8')
    .toString('base64')
    .replace(/.{76}/g, '$&\n')

  // `-` is absent from the base64 alphabet, which is what makes the delimiter uncloseable.
  if (!/^[A-Za-z0-9+/=\n]+$/.test(encoded)) {
    throw new Error('Encoded payload left the base64 alphabet, the heredoc delimiter is no longer safe.')
  }

  // The temp file is 0600 root-owned and reaches the child as an inherited fd, so the script
  // is never readable by other users, nor visible in `ps` the way `bash -c` would be.
  return `set -e
SSM_SCRIPT="$(mktemp "\${TMPDIR:-/tmp}/ssm-XXXXXXXX.sh" 2>/dev/null || mktemp)"
trap 'rm -f "$SSM_SCRIPT"' EXIT
base64 -d > "$SSM_SCRIPT" <<'END-OF-SSM-PAYLOAD'
${encoded}
END-OF-SSM-PAYLOAD
sudo -u '${runAsUser}' bash -s < "$SSM_SCRIPT"
`
}

async function run() {
  const EC2_INSTANCE_ID = core.getInput('ec2_instance_id', {required: true})
  const RUN_AS_USER = core.getInput('run_as_user', {required: true})

  if (!/^[A-Za-z0-9_-]+$/.test(RUN_AS_USER)) {
    throw new Error(`Invalid run_as_user "${RUN_AS_USER}". Only letters, digits, underscores and hyphens are allowed.`)
  }

  const COMMANDS = core.getInput('commands', {required: true})
  const LOG_BUCKET_NAME = core.getInput('log_bucket_name', {required: true})
  const S3_PREFIX = core.getInput('s3_prefix') || 'deployments'
  const COMMENT = core.getInput('comment')
  const EXECUTION_TIMEOUT = core.getInput('execution_timeout') || '3600'
  const POLL_INTERVAL_MS = parseInt(core.getInput('poll_interval_ms'), 10) || 2000

  const SCRIPT = buildRemoteScript(RUN_AS_USER, COMMANDS)

  core.info('Sending command to remote server...')
  const sendResp = await ssm.send(new SendCommandCommand({
    InstanceIds: [EC2_INSTANCE_ID],
    TimeoutSeconds: 300, // SSM will wait up to these seconds for the agent to pick up the command
    Comment: COMMENT,
    DocumentName: 'AWS-RunShellScript',
    Parameters: {
      commands: [SCRIPT],
      executionTimeout: [EXECUTION_TIMEOUT]
    },
    OutputS3BucketName: LOG_BUCKET_NAME,
    OutputS3KeyPrefix: S3_PREFIX
  }))

  const COMMAND_ID = sendResp.Command.CommandId
  core.saveState('ssm-command-id', COMMAND_ID);
  core.info(`Command ID: ${COMMAND_ID}`)
  core.info('Waiting for command to finish...')

  let STATUS = 'Pending'
  let STATUS_DETAILS = ''
  // Null until the script itself runs to completion. Undeliverable, TimedOut, Terminated
  // and Cancelled all leave it null, so it must not be flattened into a number too early.
  let RESPONSE_CODE = null
  while (['Pending', 'InProgress', 'Delayed'].includes(STATUS)) {
    await sleep(POLL_INTERVAL_MS)
    const resp = await ssm.send(new GetCommandInvocationCommand({
      CommandId: COMMAND_ID,
      InstanceId: EC2_INSTANCE_ID,
      PluginName: 'aws:runShellScript'
    }))
    STATUS = resp.Status ?? 'Unknown'
    STATUS_DETAILS = resp.StatusDetails ?? ''
    RESPONSE_CODE = resp.ResponseCode ?? null
    core.info(`Command status: ${STATUS}`)
  }

  // 255 stays the sentinel for the output so the contract does not change.
  const EXIT_CODE = RESPONSE_CODE ?? 255

  // The command reached a terminal state, so the post step has nothing to cancel.
  // Set before the S3 fetches: a failure reading logs must not cancel a finished command.
  core.saveState('ssm-command-done', 'true')

  const base = `${S3_PREFIX}/${COMMAND_ID}/${EC2_INSTANCE_ID}/awsrunShellScript/0.awsrunShellScript`

  const stdout = await fetchS3(LOG_BUCKET_NAME, `${base}/stdout`)
  stdout ? printUntrusted('Remote stdout', stdout) : core.warning('No stdout found')

  const stderr = await fetchS3(LOG_BUCKET_NAME, `${base}/stderr`)
  if (stderr) {
    // The annotation has to stay outside the fence to be rendered as one, so it carries a
    // fixed message and the remote text goes to the log group instead.
    core.warning('Remote command wrote to stderr, see the "Remote stderr" log group')
    printUntrusted('Remote stderr', stderr)
  }

  core.setOutput('command-exit-code', EXIT_CODE);
  core.setOutput('command-status', STATUS);
  core.info(`Status: ${STATUS}${STATUS_DETAILS && STATUS_DETAILS !== STATUS ? ` (${STATUS_DETAILS})` : ''}`)
  core.info(`Exit code: ${EXIT_CODE}`)

  // Status is the authoritative field: a null ResponseCode reports as 255, which is
  // indistinguishable from a script that genuinely exited 255.
  if (STATUS !== 'Success') {
    // Only quote an exit code the script actually produced, otherwise the sentinel
    // reads as a real script failure and sends debugging down the wrong path.
    const code = RESPONSE_CODE === null ? '' : ` (exit code ${RESPONSE_CODE})`
    const detail = STATUS_DETAILS && STATUS_DETAILS !== STATUS ? `: ${STATUS_DETAILS}` : ''
    core.setFailed(`Remote command ${STATUS}${code}${detail}`)
  }
}

run().catch(error => {
  core.setFailed(error)
})
