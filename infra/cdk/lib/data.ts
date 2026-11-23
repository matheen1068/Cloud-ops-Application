import { RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, Billing, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import type { Stage } from './platform-stack';

/** One DynamoDB table for everything (key layout in services/api/src/lib/db.ts). */
export class Data extends Construct {
  readonly table: TableV2;

  constructor(scope: Construct, id: string, props: { stage: Stage }) {
    super(scope, id);
    const isProd = props.stage === 'prod';

    this.table = new TableV2(this, 'Table', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billing: Billing.onDemand(), // pay per request, $0 when idle
      timeToLiveAttribute: 'ttl', // for cached data later
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: isProd }, // backups cost extra; prod only
      deletionProtection: isProd,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
  }
}
