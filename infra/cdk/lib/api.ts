import * as path from 'node:path';
import { Aws, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { CorsHttpMethod, HttpApi, HttpMethod, HttpStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { UserPool, UserPoolClient } from 'aws-cdk-lib/aws-cognito';
import type { TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { CfnSchedule, CfnScheduleGroup } from 'aws-cdk-lib/aws-scheduler';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import type { Stage } from './platform-stack';

/** Must match the RoleName used by onboarding/ (CloudFormation and Terraform). */
const ACCESS_ROLE_NAME = 'CloudOpsAccessRole';
const API_SRC = path.join(__dirname, '..', '..', '..', 'services', 'api', 'src');

interface ApiProps {
  stage: Stage;
  table: TableV2;
  userPool: UserPool;
  userPoolClient: UserPoolClient;
  allowedOrigins: string[];
  /** Verified SES sender for email notifications. Email is off when missing. */
  senderEmail?: string;
}

/** HTTP API + Lambdas. HTTP API is the cheaper API Gateway flavour, and it validates Cognito JWTs for free. */
export class Api extends Construct {
  readonly url: string;
  readonly platformRoleName: string;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);
    const { stage } = props;

    // The role every API Lambda runs as. Customer accounts trust this role by name,
    // so prod uses the default name from the onboarding templates.
    this.platformRoleName = stage === 'prod' ? 'CloudOpsPlatformRole' : `CloudOpsPlatformRole-${stage}`;
    const platformRole = new Role(this, 'PlatformRole', {
      roleName: this.platformRoleName,
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: 'Cloud-Ops API Lambdas. Assumes CloudOpsAccessRole in customer accounts.',
    });
    platformRole.addToPolicy(
      new PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:${Aws.PARTITION}:iam::*:role/${ACCESS_ROLE_NAME}`],
      }),
    );
    props.table.grantReadWriteData(platformRole);

    // ---- Scheduling: EventBridge Scheduler fires the runner Lambda ----
    // Names are fixed and ARNs built as strings, so the roles, the runner and the
    // policies never reference each other in a loop.
    const scheduleGroup = new CfnScheduleGroup(this, 'ScheduleGroup', { name: `cloudops-${stage}` });
    const runnerName = `cloudops-${stage}-runner`;
    const runnerArn = `arn:${Aws.PARTITION}:lambda:${Aws.REGION}:${Aws.ACCOUNT_ID}:function:${runnerName}`;
    const schedulerRoleName = `CloudOpsSchedulerRole-${stage}`;
    const schedulerRoleArn = `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:role/${schedulerRoleName}`;

    const schedulerRole = new Role(this, 'SchedulerRole', {
      roleName: schedulerRoleName,
      assumedBy: new ServicePrincipal('scheduler.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID } },
      }),
      description: 'Lets EventBridge Scheduler invoke the Cloud-Ops runner Lambda.',
    });
    schedulerRole.addToPolicy(new PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [runnerArn] }));

    platformRole.addToPolicy(
      new PolicyStatement({
        actions: ['scheduler:CreateSchedule', 'scheduler:DeleteSchedule', 'scheduler:GetSchedule'],
        resources: [`arn:${Aws.PARTITION}:scheduler:${Aws.REGION}:${Aws.ACCOUNT_ID}:schedule/cloudops-${stage}/*`],
      }),
    );
    platformRole.addToPolicy(
      new PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [schedulerRoleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } },
      }),
    );

    const httpApi = new HttpApi(this, 'HttpApi', {
      apiName: `cloudops-${stage}`,
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: props.allowedOrigins,
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.PUT, CorsHttpMethod.DELETE],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: Duration.hours(1),
      },
    });

    // Throttling caps the bill if something (or someone) hammers the API.
    const apiStage = new HttpStage(this, 'DefaultStage', {
      httpApi,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: 20, burstLimit: 40 },
    });
    this.url = apiStage.url;

    const authorizer = new HttpUserPoolAuthorizer('Cognito', props.userPool, {
      userPoolClients: [props.userPoolClient],
    });

    const environment = {
      TABLE_NAME: props.table.tableName,
      PLATFORM_ACCOUNT_ID: Aws.ACCOUNT_ID,
      PLATFORM_ROLE_NAME: this.platformRoleName,
      ACCESS_ROLE_NAME,
      SCHEDULE_GROUP: scheduleGroup.name!,
      SCHEDULER_ROLE_ARN: schedulerRoleArn,
      RUNNER_ARN: runnerArn,
      ...(props.senderEmail ? { SENDER_EMAIL: props.senderEmail } : {}),
    };

    // Email notifications through SES, only from the one verified sender address.
    if (props.senderEmail) {
      platformRole.addToPolicy(
        new PolicyStatement({
          actions: ['ses:SendEmail'],
          resources: [`arn:${Aws.PARTITION}:ses:${Aws.REGION}:${Aws.ACCOUNT_ID}:identity/*`],
          conditions: { StringEquals: { 'ses:FromAddress': props.senderEmail } },
        }),
      );
    }

    // TS: an arrow function stored in a const, reused for every Lambda.
    const fn = (name: string, file: string, extra: { functionName?: string; timeout?: Duration } = {}) => {
      const logGroup = new LogGroup(this, `${name}Logs`, {
        retention: RetentionDays.ONE_WEEK, // logs are the classic slow cost leak
        removalPolicy: RemovalPolicy.DESTROY,
      });
      // The shared role is custom, so CDK doesn't add log permissions for us.
      logGroup.grantWrite(platformRole);

      return new NodejsFunction(this, name, {
        entry: path.join(API_SRC, 'handlers', file),
        handler: 'handler',
        runtime: Runtime.NODEJS_22_X,
        architecture: Architecture.ARM_64, // Graviton: cheaper per ms than x86
        memorySize: 256,
        functionName: extra.functionName,
        timeout: extra.timeout ?? Duration.seconds(29), // HTTP API waits at most 30s
        role: platformRole,
        environment,
        logGroup,
        bundling: { minify: true, sourceMap: true, target: 'node22' },
      });
    };

    const routes: { path: string; methods: HttpMethod[]; handler: NodejsFunction }[] = [
      { path: '/me', methods: [HttpMethod.GET], handler: fn('MeFn', 'me.ts') },
      { path: '/accounts', methods: [HttpMethod.GET, HttpMethod.POST], handler: fn('AccountsFn', 'accounts.ts') },
      { path: '/asgs', methods: [HttpMethod.GET], handler: fn('AsgsFn', 'asgs.ts') },
      { path: '/asgs/capacity', methods: [HttpMethod.PUT], handler: fn('CapacityFn', 'capacity.ts') },
      { path: '/asgs/readiness', methods: [HttpMethod.POST], handler: fn('ReadinessFn', 'readiness.ts') },
      { path: '/audit', methods: [HttpMethod.GET], handler: fn('AuditFn', 'audit.ts') },
    ];
    const settingsFn = fn('SettingsFn', 'settings.ts');
    const insightsFn = fn('InsightsFn', 'insights.ts');
    routes.push(
      { path: '/settings', methods: [HttpMethod.GET, HttpMethod.PUT], handler: settingsFn },
      { path: '/settings/test', methods: [HttpMethod.POST], handler: settingsFn },
      { path: '/insights', methods: [HttpMethod.GET], handler: insightsFn },
      { path: '/insights/run', methods: [HttpMethod.POST], handler: insightsFn },
    );

    const eventsFn = fn('EventsFn', 'events.ts');
    const schedulesFn = fn('SchedulesFn', 'schedules.ts');
    eventsFn.node.addDependency(scheduleGroup);
    schedulesFn.node.addDependency(scheduleGroup);
    routes.push(
      { path: '/scale-events', methods: [HttpMethod.GET, HttpMethod.POST], handler: eventsFn },
      { path: '/scale-events/{eventId}/cancel', methods: [HttpMethod.POST], handler: eventsFn },
      { path: '/scale-events/{eventId}/investigate', methods: [HttpMethod.POST], handler: eventsFn },
      { path: '/schedules', methods: [HttpMethod.GET, HttpMethod.POST], handler: schedulesFn },
      { path: '/schedules/{scheduleId}', methods: [HttpMethod.DELETE], handler: schedulesFn },
    );

    // Not behind the API: only EventBridge Scheduler invokes it (via schedulerRole).
    const runner = fn('RunnerFn', 'runner.ts', { functionName: runnerName, timeout: Duration.minutes(5) });
    runner.node.addDependency(scheduleGroup);

    // Insights sweep for every workspace: forgotten scale-ups and idle ASGs.
    const sweep = new CfnSchedule(this, 'InsightsSweep', {
      name: `cloudops-${stage}-insights-sweep`,
      groupName: scheduleGroup.name,
      scheduleExpression: 'rate(6 hours)',
      flexibleTimeWindow: { mode: 'FLEXIBLE', maximumWindowInMinutes: 30 },
      target: { arn: runnerArn, roleArn: schedulerRole.roleArn, input: JSON.stringify({ kind: 'sweep' }) },
    });
    sweep.node.addDependency(scheduleGroup, runner);

    for (const route of routes) {
      httpApi.addRoutes({
        path: route.path,
        methods: route.methods,
        integration: new HttpLambdaIntegration(`${route.handler.node.id}${route.path.replace(/[^A-Za-z]/g, '')}`, route.handler),
        authorizer,
      });
    }
  }
}
