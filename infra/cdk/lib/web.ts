import * as fs from 'node:fs';
import * as path from 'node:path';
import { Annotations, Duration, RemovalPolicy } from 'aws-cdk-lib';
import {
  CachePolicy,
  Distribution,
  HttpVersion,
  PriceClass,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import type { Stage } from './platform-stack';

const DIST = path.join(__dirname, '..', '..', '..', 'apps', 'web', 'dist');

export interface SiteConfig {
  apiUrl: string;
  region: string;
  userPoolId: string;
  userPoolClientId: string;
}

/**
 * The web app: a private S3 bucket that only CloudFront can read (OAC).
 * CloudFront's always-free tier covers a dev dashboard many times over.
 */
export class Web extends Construct {
  readonly distribution: Distribution;
  readonly url: string;
  private readonly bucket: Bucket;

  constructor(scope: Construct, id: string, props: { stage: Stage }) {
    super(scope, id);
    const isProd = props.stage === 'prod';

    this.bucket = new Bucket(this, 'SiteBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd, // lets `cdk destroy` remove the bucket in dev
    });

    this.distribution = new Distribution(this, 'Distribution', {
      comment: `Cloud-Ops ${props.stage} web app`,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: ResponseHeadersPolicy.SECURITY_HEADERS,
        compress: true,
      },
      // Single-page app: unknown paths serve index.html and React takes over.
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
        ttl: Duration.seconds(0),
      })),
      priceClass: PriceClass.PRICE_CLASS_200, // includes India edge locations
      httpVersion: HttpVersion.HTTP2_AND_3,
    });

    this.url = `https://${this.distribution.distributionDomainName}`;
  }

  /**
   * Uploads apps/web/dist plus a config.json built from the stack's own values,
   * then clears the CloudFront cache. Skipped (with a warning) if the app isn't built.
   */
  deploySite(config: SiteConfig): void {
    if (!fs.existsSync(path.join(DIST, 'index.html'))) {
      Annotations.of(this).addWarning(
        'apps/web/dist not found: the web app was not uploaded. Run `npm run build -w @cloud-ops/web` first, or use `npm run deploy` from the repo root.',
      );
      return;
    }

    new BucketDeployment(this, 'DeploySite', {
      sources: [Source.asset(DIST), Source.jsonData('config.json', config)],
      destinationBucket: this.bucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
      prune: true,
      memoryLimit: 256,
      logGroup: new LogGroup(this, 'DeploySiteLogs', {
        retention: RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
  }
}
