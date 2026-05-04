import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

// S3 bucket per allegati intervention/dispute. Upload via presigned
// URL (PR successivo F-OFF-305) — il bucket NON è pubblicamente
// accessibile, ogni operazione passa da signed URL Lambda-side.
//
// Lifecycle:
// - transition-to-ia: oggetti dopo 90 giorni → Standard-IA (~40% saving
//   storage cost) per allegati storici raramente acceduti.
// - noncurrent versions expire dopo 30 giorni — la versioning protegge
//   da overwrite accidentali ma non dobbiamo accumulare storia infinita.
// - abort-incomplete-uploads dopo 7 giorni — multipart abbandonati
//   trattenuti consumano storage (rare ma capita su upload mobili
//   interrotti).
//
// CORS: solo origini browser-served (app.garageos.* + garageos.*).
// Mobile (RN/Expo) non rispetta CORS, quindi non serve elencarlo.
//
// removalPolicy RETAIN: perdere il bucket = perdere allegati di tutti
// gli workshop. Cleanup manuale solo via console se necessario.

export interface StorageConstructProps {
  readonly environment: string;
  readonly corsAllowedOrigins: readonly string[];
}

export class StorageConstruct extends Construct {
  public readonly attachmentsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageConstructProps) {
    super(scope, id);

    this.attachmentsBucket = new s3.Bucket(this, 'Attachments', {
      bucketName: `garageos-${props.environment}-attachments`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      lifecycleRules: [
        {
          id: 'transition-to-ia',
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
        {
          id: 'abort-incomplete-uploads',
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],
          allowedOrigins: [...props.corsAllowedOrigins],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
