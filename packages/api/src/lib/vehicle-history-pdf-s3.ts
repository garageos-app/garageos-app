import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { getS3Client } from './s3.js';
import {
  renderVehicleHistoryPdf,
  type VehicleHistoryPdfData,
} from './vehicle-history-pdf-renderer.js';

// F-CLI-501 — vehicle-history PDF persist + presign. The document is MUTABLE
// (history changes as new interventions are logged), so there is NO HeadObject
// cache check: every request re-renders and overwrites the object, then
// presigns a GET. Key is per-vehicle so overwrites stay bounded to one object
// per vehicle. No tenant logo (multi-officina, GarageOS-branded header).

const PRESIGN_TTL_SECONDS = 3600;

export interface GenerateInput {
  bucket: string;
  vehicleId: string;
  data: VehicleHistoryPdfData;
}

export interface GenerateResult {
  url: string;
  expiresAt: Date;
}

function pdfKey(vehicleId: string): string {
  return `vehicle-history-pdfs/${vehicleId}.pdf`;
}

export class VehicleHistoryPdfRenderFailedError extends Error {
  override name = 'vehicle_history_pdf.render_failed';
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export class VehicleHistoryPdfS3UploadFailedError extends Error {
  override name = 'vehicle_history_pdf.s3_upload_failed';
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export async function generateVehicleHistoryPdfPresignedUrl(
  input: GenerateInput,
): Promise<GenerateResult> {
  const client = getS3Client();
  const key = pdfKey(input.vehicleId);

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await renderVehicleHistoryPdf(input.data);
  } catch (err) {
    throw new VehicleHistoryPdfRenderFailedError('renderVehicleHistoryPdf failed', err);
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
    throw new VehicleHistoryPdfS3UploadFailedError('PutObject failed', err);
  }

  const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: input.bucket, Key: key }), {
    expiresIn: PRESIGN_TTL_SECONDS,
  });
  const expiresAt = new Date(Date.now() + PRESIGN_TTL_SECONDS * 1000);

  return { url, expiresAt };
}
