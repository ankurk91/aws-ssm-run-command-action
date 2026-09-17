import * as core from '@actions/core'
import {S3Client, GetObjectCommand} from '@aws-sdk/client-s3'
import {text} from 'node:stream/consumers'
import {Buffer} from 'node:buffer'
import {randomUUID} from 'node:crypto'
import process from 'node:process'

// Virtual-hosted-style requests (bucket.localhost) do not resolve against a local emulator, so
// path-style is enabled only when a custom endpoint is set. Real AWS keeps default addressing.
const s3 = new S3Client({
  forcePathStyle: Boolean(process.env.AWS_ENDPOINT_URL)
})

export const sleep = ms => new Promise(r => setTimeout(r, ms))

// The runner executes `::workflow-command::` lines it finds on stdout, so remote output has to be
// fenced with `::stop-commands::<token>`. The token is a fresh UUID per call, otherwise the
// output could close its own fence. Our own commands are inert inside the fence too, which is why
// groups and annotations are issued outside it and only the untrusted body goes within.
export function printUntrusted(title, body) {
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

export async function fetchS3(bucket, key) {
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key
    }))
    return await text(res.Body)
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

// `commands` is encoded, not interpolated: a payload line cannot close the heredoc and escape
// `sudo -u` into the outer (root) SSM shell. No pipe either, so `set -e` still catches a `base64`
// failure instead of feeding the child an empty script and reporting a green deploy.
export function buildRemoteScript(runAsUser, commands) {
  // `exec 2>&1` merges stderr into stdout so interleaved output keeps its chronological order.
  const encoded = Buffer
    .from(`exec 2>&1\n${commands}\n`, 'utf8')
    .toString('base64')
    .replace(/.{76}/g, '$&\n')

  // `-` is absent from the base64 alphabet, which is what makes the delimiter uncloseable.
  if (!/^[A-Za-z0-9+/=\n]+$/.test(encoded)) {
    throw new Error('Encoded payload left the base64 alphabet, the heredoc delimiter is no longer safe.')
  }

  // The temp file is 0600 root-owned and reaches the child as an inherited fd, so it is never
  // readable by other users, nor visible in `ps` the way `bash -c` would be.
  return `set -e
SSM_SCRIPT="$(mktemp "\${TMPDIR:-/tmp}/ssm-XXXXXXXX.sh" 2>/dev/null || mktemp)"
trap 'rm -f "$SSM_SCRIPT"' EXIT
base64 -d > "$SSM_SCRIPT" <<'END-OF-SSM-PAYLOAD'
${encoded}
END-OF-SSM-PAYLOAD
sudo -u '${runAsUser}' bash -s < "$SSM_SCRIPT"
`
}
