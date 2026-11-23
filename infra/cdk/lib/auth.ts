import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { AccountRecovery, FeaturePlan, UserPool, UserPoolClient } from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import type { Stage } from './platform-stack';

/** Cognito sign-up / sign-in. Lite plan: the cheapest tier, with a free tier of 10,000 monthly users. */
export class Auth extends Construct {
  readonly userPool: UserPool;
  readonly userPoolClient: UserPoolClient;

  constructor(scope: Construct, id: string, props: { stage: Stage }) {
    super(scope, id);
    const isProd = props.stage === 'prod';

    this.userPool = new UserPool(this, 'UserPool', {
      userPoolName: `cloudops-${props.stage}`,
      featurePlan: FeaturePlan.LITE,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      deletionProtection: isProd,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.userPoolClient = this.userPool.addClient('WebClient', {
      // userPassword is on in dev only, so you can get a token from the CLI for testing.
      authFlows: { userSrp: true, userPassword: !isProd },
      generateSecret: false, // browser app, can't keep a secret
      preventUserExistenceErrors: true,
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });
  }
}
