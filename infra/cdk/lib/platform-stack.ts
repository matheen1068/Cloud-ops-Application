import { CfnOutput, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Api } from './api';
import { Auth } from './auth';
import { CostGuardrails } from './cost';
import { Data } from './data';
import { Web } from './web';

export type Stage = 'dev' | 'prod';

export interface PlatformStackProps extends StackProps {
  stage: Stage;
  budgetEmail?: string;
  monthlyBudgetUsd: number;
  allowedOrigins: string[];
}

/**
 * The whole Cloud-Ops platform in one stack, so `cdk deploy` / `cdk destroy`
 * is a single command. Everything is pay-per-use: idle cost is ~$0.
 * Deploy order inside the stack: data, auth, web (bucket + CloudFront),
 * api (CORS allows the CloudFront URL), then the site upload with config.json.
 */
export class PlatformStack extends Stack {
  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);
    const { stage } = props;

    const data = new Data(this, 'Data', { stage });
    const auth = new Auth(this, 'Auth', { stage });
    const web = new Web(this, 'Web', { stage });
    const api = new Api(this, 'Api', {
      stage,
      table: data.table,
      userPool: auth.userPool,
      userPoolClient: auth.userPoolClient,
      // Local dev origins plus the CloudFront URL of the hosted app
      allowedOrigins: [...props.allowedOrigins, web.url],
    });

    // The hosted app reads its API and Cognito settings from config.json.
    web.deploySite({
      apiUrl: api.url,
      region: this.region,
      userPoolId: auth.userPool.userPoolId,
      userPoolClientId: auth.userPoolClient.userPoolClientId,
    });

    if (props.budgetEmail) {
      new CostGuardrails(this, 'Cost', {
        stage,
        email: props.budgetEmail,
        monthlyBudgetUsd: props.monthlyBudgetUsd,
      });
    }

    // Tags show up in Cost Explorer once activated as cost allocation tags.
    Tags.of(this).add('Project', 'cloud-ops');
    Tags.of(this).add('Stage', stage);

    new CfnOutput(this, 'WebUrl', { value: web.url });
    new CfnOutput(this, 'ApiUrl', { value: api.url });
    new CfnOutput(this, 'Region', { value: this.region });
    new CfnOutput(this, 'UserPoolId', { value: auth.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: auth.userPoolClient.userPoolClientId });
    new CfnOutput(this, 'PlatformAccountId', { value: this.account });
    new CfnOutput(this, 'PlatformRoleName', { value: api.platformRoleName });
    new CfnOutput(this, 'TableName', { value: data.table.tableName });
  }
}
