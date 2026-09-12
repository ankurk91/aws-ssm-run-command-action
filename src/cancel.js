import {SSMClient, CancelCommandCommand} from "@aws-sdk/client-ssm";
import * as core from "@actions/core";

const ssm = new SSMClient()

async function run() {
  const COMMAND_ID = core.getState('ssm-command-id');

  if (!COMMAND_ID) {
    return
  }

  // The post step runs on every outcome (`post-if: always()`) so that a job timeout,
  // a runner shutdown or a failed step does not leave the remote script running until
  // `execution_timeout`. Only skip when the main step saw the command reach a terminal state.
  if (core.getState('ssm-command-done') === 'true') {
    core.debug(`Command ${COMMAND_ID} already finished, nothing to cancel`)
    return
  }

  const EC2_INSTANCE_ID = core.getInput('ec2_instance_id', {required: true})

  await ssm.send(new CancelCommandCommand({
      InstanceIds: [EC2_INSTANCE_ID],
      CommandId: COMMAND_ID
    }
  ));
  core.info(`Cancelled command: ${COMMAND_ID}`);
}

run().catch(error => {
  core.warning(`Failed to cancel command: ${error instanceof Error ? error.message : 'Unknown error'}`);
})
