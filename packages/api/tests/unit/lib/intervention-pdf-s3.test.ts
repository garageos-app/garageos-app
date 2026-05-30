// packages/api/tests/unit/lib/intervention-pdf-s3.test.ts
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { generateInterventionPdfPresignedUrl } from '../../../src/lib/intervention-pdf-s3.js';
import { _resetS3ClientForTests } from '../../../src/lib/s3.js';
import type { InterventionPdfData } from '../../../src/lib/intervention-pdf-renderer.js';

const s3Mock = mockClient(S3Client);

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const INTERVENTION_ID = '99999999-9999-4999-8999-999999999999';

const DATA: InterventionPdfData = {
  tenant: {
    businessName: 'Officina X',
    addressLine: 'Via 1',
    city: 'Roma',
    vatNumber: '0000',
    phone: null,
  },
  customerName: 'Mario Rossi',
  vehicle: { plate: 'AB123CD', make: 'Fiat', model: 'Panda', garageCode: 'GA0001' },
  interventionDate: '2026-05-23',
  odometerKm: 60000,
  typeName: 'Tagliando',
  title: null,
  description: 'desc',
  partsReplaced: [],
  operatorName: 'Operatore',
  status: 'active',
  cancelledReason: null,
};

beforeAll(() => {
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  process.env.AWS_REGION ??= 'eu-south-1';
  process.env.S3_ATTACHMENTS_BUCKET ??= 'garageos-test-attachments';
});

beforeEach(() => {
  _resetS3ClientForTests();
  s3Mock.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('generateInterventionPdfPresignedUrl', () => {
  it('always renders + PutObject (no cache) and returns a presigned URL', async () => {
    s3Mock.on(PutObjectCommand).resolves({});

    const result = await generateInterventionPdfPresignedUrl({
      bucket: 'garageos-test-attachments',
      tenantId: TENANT_ID,
      interventionId: INTERVENTION_ID,
      data: DATA,
      logo: null,
    });

    expect(result.url).toContain('garageos-test-attachments');
    expect(result.url).toContain(`intervention-pdfs/${TENANT_ID}/${INTERVENTION_ID}.pdf`);
    expect(result.expiresAt).toBeInstanceOf(Date);

    const putCalls = s3Mock.commandCalls(PutObjectCommand);
    expect(putCalls).toHaveLength(1);
    const input = putCalls[0]!.args[0].input;
    expect(input.ContentType).toBe('application/pdf');
    // Mutable doc: must NOT be marked immutable like the tag.
    expect(input.CacheControl).toBeUndefined();
    expect(input.Key).toBe(`intervention-pdfs/${TENANT_ID}/${INTERVENTION_ID}.pdf`);
  });

  it('PutObject failure → throws intervention_pdf.s3_upload_failed', async () => {
    s3Mock.on(PutObjectCommand).rejects(new Error('S3 502 BadGateway'));

    await expect(
      generateInterventionPdfPresignedUrl({
        bucket: 'garageos-test-attachments',
        tenantId: TENANT_ID,
        interventionId: INTERVENTION_ID,
        data: DATA,
        logo: null,
      }),
    ).rejects.toMatchObject({ name: 'intervention_pdf.s3_upload_failed' });
  });
});
