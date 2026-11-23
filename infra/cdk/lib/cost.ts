import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import { Construct } from 'constructs';
import type { Stage } from './platform-stack';

/**
 * Monthly cost alert for the whole AWS account (not just this stack), so test
 * EC2 instances are covered too. Budgets without actions are free.
 */
export class CostGuardrails extends Construct {
  constructor(scope: Construct, id: string, props: { stage: Stage; email: string; monthlyBudgetUsd: number }) {
    super(scope, id);

    const alert = (type: 'ACTUAL' | 'FORECASTED', threshold: number) => ({
      notification: {
        notificationType: type,
        comparisonOperator: 'GREATER_THAN',
        threshold,
        thresholdType: 'PERCENTAGE',
      },
      subscribers: [{ subscriptionType: 'EMAIL', address: props.email }],
    });

    new CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `cloudops-${props.stage}-account-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: props.monthlyBudgetUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        alert('ACTUAL', 50),
        alert('ACTUAL', 80),
        alert('FORECASTED', 100),
      ],
    });
  }
}
