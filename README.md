# AWS SSM Run Command Action

A GitHub Action to execute remote shell commands on EC2 instances via SSM.

### Features

* Stores command output in an S3 bucket to avoid the ~24 KB log limit
* Works with public or private EC2 instances.
* No need to open or whitelist port 22. :rocket:

### Caveats

* Supports Linux instances only for now
* No realtime streaming of command output

### Prepare your AWS environment

* Create a new, private S3 bucket (example name: `project-name-ssm-deployment-logs`).
  - Tip: Add a lifecycle policy to prune old logs.
* Target EC2 instances must have the SSM Agent installed.
* Target EC2 instances must have an IAM role with these permissions:
  - Managed policy: `AmazonSSMManagedInstanceCore` (`AmazonEC2RoleforSSM` is deprecated).
  - Read/write permissions on the S3 log bucket (custom policy), for example:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:GetBucketLocation"
      ],
      "Resource": [
        "arn:aws:s3:::project-name-ssm-deployment-logs",
        "arn:aws:s3:::project-name-ssm-deployment-logs/*"
      ]
    }
  ]
}
```

### Usage

```yaml
on:
  push:
    branches:
      - main

jobs:
  Deployment:
    runs-on: ubuntu-latest

    steps:
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v5
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ vars.AWS_REGION }}

      - name: Run commands on EC2
        uses: ankurk91/aws-ssm-run-command-action@v1
        with:
          ec2_instance_id: ${{ vars.EC2_INSTANCE_ID }}
          run_as_user: ubuntu
          log_bucket: ${{ vars.LOG_BUCKET_NAME }}
          commands: |
            set -e
            pwd
            cd /home/ubuntu
            ls -al
            echo "Hello from EC2"

```

### Inputs

| Name                | Required | Default            | Description                                                |
|---------------------|----------|--------------------|------------------------------------------------------------|
| `ec2_instance_id`   | Yes      | `null`             | EC2 Instance ID                                            |
| `run_as_user`       | Yes      | `null`             | A valid Linux user name on remote EC2                      |
| `log_bucket_name`   | Yes      | `null`             | S3 Bucket name to store command output logs                |
| `commands`          | Yes      | `null`             | Multiline commands to run on server                        |
| `comment`           | No       | `GitHub actions`   | User-specified information about the command               |
| `s3_prefix`         | No       | `deployments`      | S3 bucket prefix                                           |
| `execution_timeout` | No       | `3600` (1 hour)    | Script is forcibly terminated after this number of seconds |
| `poll_interval_ms`  | No       | `2000` (2 seconds) | Milliseconds to poll command results                       |

### Outputs

| Name                | Description              |
|---------------------|--------------------------|
| `command-exit-code` | Remote command exit code |

### Credentials and Region

This action relies on the default behavior of the
[AWS SDK for Javascript](https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/setting-credentials-node.html)
to determine AWS credentials and region.
Use the [aws-actions/configure-aws-credentials](https://github.com/aws-actions/configure-aws-credentials) action to
configure the GitHub Actions environment with environment variables containing AWS credentials and your desired region.

### Action Permissions

This action requires the following set of permissions inside pipeline:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ssm:SendCommand"
      ],
      "Resource": [
        "arn:aws:ec2:*:*:instance/*",
        "arn:aws:ssm:*:*:document/AWS-RunShellScript"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "ssm:ListCommandInvocations",
        "ssm:GetCommandInvocation"
      ],
      "Resource": "*"
    }
  ]
}
```

### Reference links

* [AWS SSM Errors](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/ssm/command/SendCommandCommand/#Throws)
* [What is SSM Run Command](https://docs.aws.amazon.com/systems-manager/latest/userguide/run-command.html)
* [SSM Agent installation](https://docs.aws.amazon.com/systems-manager/latest/userguide/manually-install-ssm-agent-linux.html)

### License

This repo is licensed under MIT [License](LICENSE.txt).
