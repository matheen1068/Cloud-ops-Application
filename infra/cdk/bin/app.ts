#!/usr/bin/env node
// Entry point: `npx cdk deploy` runs this file.
//
// Optional context flags:
//   -c stage=dev|prod            (default dev)
//   -c budgetEmail=you@mail.com  (turns on the monthly cost alert; or env CLOUDOPS_BUDGET_EMAIL)
//   -c monthlyBudgetUsd=10
//   -c allowedOrigins=http://localhost:3000,https://app.example.com
//   -c notificationSender=alerts@yourdomain.com  (SES-verified; or env CLOUDOPS_SENDER_EMAIL)
//   -c operatorEmails=you@example.com            (platform operators; or env CLOUDOPS_OPERATOR_EMAILS)
//   -c domainName=app.example.com -c hostedZoneId=Z0123  (custom domain; or env CLOUDOPS_DOMAIN_NAME / CLOUDOPS_HOSTED_ZONE_ID)
import { App } from 'aws-cdk-lib';
import { PlatformStack, type Stage } from '../lib/platform-stack';

const app = new App();

const stage = (app.node.tryGetContext('stage') ?? 'dev') as Stage;
if (stage !== 'dev' && stage !== 'prod') throw new Error(`stage must be dev or prod, got ${stage}`);

const origins = String(app.node.tryGetContext('allowedOrigins') ?? 'http://localhost:3000');

new PlatformStack(app, `CloudOps-${stage}`, {
  // Account and region come from your AWS CLI profile.
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  stage,
  // Set CLOUDOPS_BUDGET_EMAIL once in your shell so a deploy without -c can't drop the alert.
  budgetEmail: app.node.tryGetContext('budgetEmail') ?? process.env.CLOUDOPS_BUDGET_EMAIL,
  monthlyBudgetUsd: Number(app.node.tryGetContext('monthlyBudgetUsd') ?? 10),
  allowedOrigins: origins.split(',').map((o) => o.trim()).filter(Boolean),
  senderEmail: app.node.tryGetContext('notificationSender') ?? process.env.CLOUDOPS_SENDER_EMAIL,
  operatorEmails: app.node.tryGetContext('operatorEmails') ?? process.env.CLOUDOPS_OPERATOR_EMAILS,
  domain: customDomain(),
});

/** Both values or neither: a domain without its Route 53 zone can't get a certificate. */
function customDomain(): { name: string; hostedZoneId: string } | undefined {
  const name: string | undefined = app.node.tryGetContext('domainName') ?? process.env.CLOUDOPS_DOMAIN_NAME;
  const hostedZoneId: string | undefined = app.node.tryGetContext('hostedZoneId') ?? process.env.CLOUDOPS_HOSTED_ZONE_ID;
  if (!name && !hostedZoneId) return undefined;
  if (!name || !hostedZoneId) throw new Error('Set both domainName and hostedZoneId (or CLOUDOPS_DOMAIN_NAME and CLOUDOPS_HOSTED_ZONE_ID).');
  return { name: name.trim().toLowerCase(), hostedZoneId: hostedZoneId.trim().replace(/^\/hostedzone\//, '') };
}
