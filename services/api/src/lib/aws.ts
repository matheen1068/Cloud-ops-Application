import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { HttpError } from './http.js';

const sts = new STSClient({});

/** Temporary credentials for one customer account. Any AWS SDK client accepts this shape. */
export interface TempCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: Date;
}

export const ROLE_ARN_PATTERN = /^arn:aws[a-z-]*:iam::(\d{12}):role\/[\w+=,.@\-/]{1,512}$/;
export const REGION_PATTERN = /^[a-z]{2}(-gov|-iso[a-z]*)?-[a-z]+-\d$/;

export function accountIdFromRoleArn(roleArn: string): string | null {
  return ROLE_ARN_PATTERN.exec(roleArn)?.[1] ?? null;
}

/**
 * Assumes CloudOpsAccessRole in a customer account.
 * The external ID belongs to the tenant, so one tenant can never use another tenant's role.
 */
export async function assumeAccessRole(
  roleArn: string,
  externalId: string,
  tenantId: string,
): Promise<TempCredentials> {
  try {
    const res = await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        ExternalId: externalId,
        RoleSessionName: `cloudops-${tenantId.slice(0, 8)}`,
        DurationSeconds: 900, // shortest allowed; we only need it for this request
      }),
    );
    const c = res.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
      throw new Error('STS returned no credentials');
    }
    return {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration,
    };
  } catch (err) {
    if ((err as Error).name === 'AccessDenied') {
      throw new HttpError(
        400,
        `Could not assume ${roleArn}. Check that the role exists and that the template used the platform account ID, platform role name and external ID shown in Cloud-Ops.`,
      );
    }
    throw err;
  }
}

/** Confirms which account a set of credentials really belongs to. */
export async function accountIdOf(credentials: TempCredentials): Promise<string | undefined> {
  const client = new STSClient({ credentials });
  const res = await client.send(new GetCallerIdentityCommand({}));
  return res.Account;
}
