#!/bin/bash
# Deploy the dash.irisforu.com login/snapshot function, its HTTP API, and the CloudFront /api/* route. Idempotent.
# Needs the role from owner-create-role.sh (this server cannot create IAM roles).
set -euo pipefail
A=425434217148; R=ap-south-1; FN=iris-dash-api; HERE="$(cd "$(dirname "$0")" && pwd)"
DIST=${DIST:?set DIST to the CloudFront distribution id}
TMP=$(mktemp -d); (cd "$HERE/lambda" && zip -q -r "$TMP/fn.zip" index.mjs auth.mjs)
ENVV="Variables={OWNER_EMAIL=shravan0001jha@gmail.com,TABLE=iris-dash,DATA_BUCKET=iris-dash-data-$A,MAIL_FROM=noreply@irisforu.com,SES_REGION=$R}"
if aws lambda get-function --function-name $FN --region $R >/dev/null 2>&1; then
  aws lambda update-function-code --function-name $FN --region $R --zip-file fileb://$TMP/fn.zip --query LastUpdateStatus --output text
  aws lambda wait function-updated --function-name $FN --region $R
  aws lambda update-function-configuration --function-name $FN --region $R --environment "$ENVV" --query LastUpdateStatus --output text
else
  aws lambda create-function --function-name $FN --region $R --runtime nodejs20.x --architectures arm64 --handler index.handler \
    --role arn:aws:iam::$A:role/iris-dash-api --zip-file fileb://$TMP/fn.zip --timeout 10 --memory-size 256 --environment "$ENVV" --query FunctionArn --output text
  aws lambda wait function-active --function-name $FN --region $R
fi
API=$(aws apigatewayv2 get-apis --region $R --query "Items[?Name=='iris-dash'].ApiId" --output text)
if [ -z "$API" ] || [ "$API" = "None" ]; then
  API=$(aws apigatewayv2 create-api --region $R --name iris-dash --protocol-type HTTP --target arn:aws:lambda:$R:$A:function:$FN --query ApiId --output text)
  aws lambda add-permission --function-name $FN --region $R --statement-id apigw-iris-dash --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:$R:$A:$API/*/*" >/dev/null
  # Throttle: the owner is the only user.
  aws apigatewayv2 update-stage --region $R --api-id $API --stage-name '$default' --default-route-settings ThrottlingBurstLimit=20,ThrottlingRateLimit=5 >/dev/null
fi
APIHOST="$API.execute-api.$R.amazonaws.com"; echo "api $APIHOST"
# CloudFront: add the API origin and the /api/* behaviour (no cache, all viewer headers/cookies except Host).
aws cloudfront get-distribution-config --id $DIST > "$TMP/d.json"
ETAG=$(python3 -c "import json;print(json.load(open('$TMP/d.json'))['ETag'])")
python3 - "$TMP/d.json" "$APIHOST" > "$TMP/cfg.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))['DistributionConfig']; host = sys.argv[2]
items = [o for o in d['Origins']['Items'] if o['Id'] != 'api'] + [{
  'Id': 'api', 'DomainName': host, 'OriginPath': '', 'CustomHeaders': {'Quantity': 0},
  'CustomOriginConfig': {'HTTPPort': 80, 'HTTPSPort': 443, 'OriginProtocolPolicy': 'https-only', 'OriginSslProtocols': {'Quantity': 1, 'Items': ['TLSv1.2']}, 'OriginReadTimeout': 30, 'OriginKeepaliveTimeout': 5},
  'ConnectionAttempts': 3, 'ConnectionTimeout': 10, 'OriginShield': {'Enabled': False}, 'OriginAccessControlId': ''}]
d['Origins'] = {'Quantity': len(items), 'Items': items}
beh = [b for b in (d.get('CacheBehaviors') or {}).get('Items', []) if b['PathPattern'] != '/api/*'] + [{
  'PathPattern': '/api/*', 'TargetOriginId': 'api', 'ViewerProtocolPolicy': 'https-only', 'Compress': True,
  'CachePolicyId': '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',            # CachingDisabled
  'OriginRequestPolicyId': 'b689b0a8-53d0-40ab-baf2-68738e2966ac',    # AllViewerExceptHostHeader
  'ResponseHeadersPolicyId': '67f7725c-6f97-4210-82d7-5512b31e9d03',  # SecurityHeadersPolicy
  'AllowedMethods': {'Quantity': 7, 'Items': ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'], 'CachedMethods': {'Quantity': 2, 'Items': ['GET', 'HEAD']}},
  'SmoothStreaming': False, 'FieldLevelEncryptionId': '', 'LambdaFunctionAssociations': {'Quantity': 0}, 'FunctionAssociations': {'Quantity': 0}}]
d['CacheBehaviors'] = {'Quantity': len(beh), 'Items': beh}
print(json.dumps(d))
PY
aws cloudfront update-distribution --id $DIST --if-match "$ETAG" --distribution-config file://$TMP/cfg.json --query Distribution.Status --output text
rm -rf "$TMP"
