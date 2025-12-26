import * as core from '@actions/core'
import {
  SSMClient,
  SendCommandCommand,
  ListCommandInvocationsCommand
} from '@aws-sdk/client-ssm'
import {S3Client, GetObjectCommand} from '@aws-sdk/client-s3'
import process from 'node:process';

const ssm = new SSMClient()
const s3 = new S3Client()

const sleep = ms => new Promise(r => setTimeout(r, ms))

const streamToString = async stream =>
  await new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', c => chunks.push(c))
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks).toString()))
  })

async function fetchS3(bucket, key) {
  try {
    const res = await s3.send(new GetObjectCommand({Bucket: bucket, Key: key}))
    return await streamToString(res.Body)
  } catch {
    core.debug(`Unable to fetch from s3://${bucket}/${key}`)
    return null
  }
}

async function run() {
  const EC2_INSTANCE_ID = core.getInput('ec2_instance_id', {required: true})
  const RUN_AS_USER = core.getInput('run_as_user', {required: true})
  const COMMANDS = core.getInput('commands', {required: true})
  const LOG_BUCKET_NAME = core.getInput('log_bucket_name', {required: true})
  const S3_PREFIX = core.getInput('s3_prefix')
  const COMMENT = core.getInput('comment')
  const EXECUTION_TIMEOUT = String(core.getInput('execution_timeout'))
  const POLL_INTERVAL_MS = parseInt(core.getInput('poll_interval_ms'))

  const SCRIPT = `
set -e
sudo -u ${RUN_AS_USER} bash <<'INNER'
exec 2>&1
${COMMANDS}
INNER
`
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
  while (['Pending', 'InProgress', 'Delayed'].includes(STATUS)) {
    await sleep(POLL_INTERVAL_MS)
    const resp = await ssm.send(new ListCommandInvocationsCommand({
      CommandId: COMMAND_ID,
      Details: true
    }))
    STATUS = resp.CommandInvocations[0]?.Status ?? 'Unknown'
    core.info(`Command status: ${STATUS}`)
  }

  const base = `${S3_PREFIX}/${COMMAND_ID}/${EC2_INSTANCE_ID}/awsrunShellScript/0.awsrunShellScript`

  core.startGroup('Remote stdout')
  const stdout = await fetchS3(LOG_BUCKET_NAME, `${base}/stdout`)
  stdout ? core.info(stdout) : core.warning('No stdout found')
  core.endGroup()

  core.startGroup('Remote stderr')
  const stderr = await fetchS3(LOG_BUCKET_NAME, `${base}/stderr`)
  stderr && core.warning(stderr)
  core.endGroup()

  const exitResp = await ssm.send(new ListCommandInvocationsCommand({
    CommandId: COMMAND_ID,
    Details: true
  }))

  const EXIT_CODE =
    exitResp.CommandInvocations[0]?.CommandPlugins[0]?.ResponseCode ?? 255
  core.setOutput('command-exit-code', EXIT_CODE);

  core.info(`Exit code: ${EXIT_CODE}`)

  if (String(EXIT_CODE) !== '0') {
    core.error(`Remote command failed with exit code ${EXIT_CODE}`)
    process.exit(EXIT_CODE)
  }
}

run().catch(error => {
  core.setFailed(error)
})
