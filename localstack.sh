#!/usr/bin/env bash
set -euo pipefail

echo 'Starting...'

export AWS_PAGER=""
export AWS_ACCESS_KEY_ID=test_id
export AWS_SECRET_ACCESS_KEY=test_key
export AWS_DEFAULT_REGION=ap-south-1
export AWS_REGION=ap-south-1
export AWS_ENDPOINT_URL=http://localhost:4566
S3_BUCKET_NAME=ssm-deployment-logs

echo "Ensuring S3 bucket..."
aws s3api head-bucket \
  --bucket "$S3_BUCKET_NAME" \
  --endpoint-url "$AWS_ENDPOINT_URL" 2>/dev/null \
|| aws s3 mb "s3://$S3_BUCKET_NAME" --endpoint-url "$AWS_ENDPOINT_URL"

echo "Creating EC2..."

INSTANCE_ID=$(
  aws ec2 run-instances \
    --image-id ami-12345678 \
    --instance-type t3.micro \
    --endpoint-url "$AWS_ENDPOINT_URL" \
    --query 'Instances[0].InstanceId' \
    --output text
)
echo "EC2 ID: $INSTANCE_ID"

echo "Preparing env....."

export INPUT_EC2_INSTANCE_ID=$INSTANCE_ID
export INPUT_RUN_AS_USER="ubuntu"
export INPUT_COMMANDS="pwd"
export INPUT_LOG_BUCKET_NAME="$S3_BUCKET_NAME"

echo "Executing the action..."
node ./src/index.js

echo "Finish testing with localstack!"
