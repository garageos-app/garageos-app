import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { getS3Client } from './s3.js';
import {
  renderInterventionPdf,
  type InterventionPdfData,
  type LogoImage,
} from './intervention-pdf-renderer.js';

// F-OFF-309 — intervention PDF persist + presign.
// UNLIKE the tag (vehicle-tag-s3.ts), this PDF is MUTABLE (BR-062 wiki window;
// parts/description can change). So there is NO HeadObject cache check: every
// request re-renders and overwrites the object, then presigns a GET. Key is
// per-intervention so overwrites stay bounded to one object per intervention.

const PRESIGN_TTL_SECONDS = 3600;

export interface GenerateInput {
  bucket: string;
  tenantId: string;
  interventionId: string;
  data: InterventionPdfData;
  logo?: LogoImage | null;
}

export interface GenerateResult {
  url: string;
  expiresAt: Date;
}

function pdfKey(tenantId: string, interventionId: string): string {
  return `intervention-pdfs/${tenantId}/${interventionId}.pdf`;
}

export class InterventionPdfRenderFailedError extends Error {
  override name = 'intervention_pdf.render_failed';
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export class InterventionPdfS3UploadFailedError extends Error {
  override name = 'intervention_pdf.s3_upload_failed';
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export async function generateInterventionPdfPresignedUrl(
  input: GenerateInput,
): Promise<GenerateResult> {
  const client = getS3Client();
  const key = pdfKey(input.tenantId, input.interventionId);

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await renderInterventionPdf(input.data, input.logo ?? null);
  } catch (err) {
    throw new InterventionPdfRenderFailedError('renderInterventionPdf failed', err);
  }

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: key,
        Body: pdfBuffer,
        ContentType: 'application/pdf',
        // No CacheControl: the document is mutable and re-generated each request.
      }),
    );
  } catch (err) {
    throw new InterventionPdfS3UploadFailedError('PutObject failed', err);
  }

  const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: input.bucket, Key: key }), {
    expiresIn: PRESIGN_TTL_SECONDS,
  });
  const expiresAt = new Date(Date.now() + PRESIGN_TTL_SECONDS * 1000);

  return { url, expiresAt };
}
