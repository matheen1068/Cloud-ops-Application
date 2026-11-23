import * as path from 'node:path';
import { Aws, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { CorsHttpMethod, HttpApi, HttpMethod, HttpStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { UserPool, UserPoolClient } from 'aws-cdk-lib/aws-cognito';
import type { TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
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
    };

    // TS: an arrow function stored in a const, reused for every Lambda.
    const fn = (name: string, file: string) => {
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
        timeout: Duration.seconds(29), // HTTP API waits at most 30s
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
    ];

    for (const route of routes) {
      httpApi.addRoutes({
        path: route.path,
        methods: route.methods,
        integration: new HttpLambdaIntegration(`${route.handler.node.id}Integration`, route.handler),
        authorizer,
      });
    }
  }
}
