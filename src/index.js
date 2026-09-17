import * as core from '@actions/core'
import {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand
} from '@aws-sdk/client-ssm'
import {sleep, printUntrusted, fetchS3, buildRemoteScript} from './utils.js'

const ssm = new SSMClient()

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
    TimeoutSeconds: 300, // how long SSM waits for the agent to pick the command up
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
  // Null until the script runs to completion, so it must not be flattened into a number early.
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

  const EXIT_CODE = RESPONSE_CODE ?? 255

  // Set before the S3 fetches: a failure reading logs must not cancel a finished command.
  core.saveState('ssm-command-done', 'true')

  const base = `${S3_PREFIX}/${COMMAND_ID}/${EC2_INSTANCE_ID}/awsrunShellScript/0.awsrunShellScript`

  const stdout = await fetchS3(LOG_BUCKET_NAME, `${base}/stdout`)
  if (stdout) {
    printUntrusted('Remote stdout', stdout)
  } else {
    core.warning('No stdout found')
  }

  const stderr = await fetchS3(LOG_BUCKET_NAME, `${base}/stderr`)
  if (stderr) {
    // An annotation only renders outside the fence, so it carries a fixed message and the
    // remote text goes to the log group instead.
    core.warning('Remote command wrote to stderr, see the "Remote stderr" log group')
    printUntrusted('Remote stderr', stderr)
  }

  core.setOutput('command-exit-code', EXIT_CODE);
  core.setOutput('command-status', STATUS);
  core.info(`Status: ${STATUS}${STATUS_DETAILS && STATUS_DETAILS !== STATUS ? ` (${STATUS_DETAILS})` : ''}`)
  core.info(`Exit code: ${EXIT_CODE}`)

  // Status is authoritative: a null ResponseCode reports as the 255 sentinel, which is
  // indistinguishable from a script that genuinely exited 255 — so only quote a real one.
  if (STATUS !== 'Success') {
    const code = RESPONSE_CODE === null ? '' : ` (exit code ${RESPONSE_CODE})`
    const detail = STATUS_DETAILS && STATUS_DETAILS !== STATUS ? `: ${STATUS_DETAILS}` : ''
    core.setFailed(`Remote command ${STATUS}${code}${detail}`)
  }
}

run().catch(error => {
  core.setFailed(error)
})
