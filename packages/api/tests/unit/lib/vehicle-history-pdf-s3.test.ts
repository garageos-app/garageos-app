// packages/api/tests/unit/lib/vehicle-history-pdf-s3.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();
vi.mock('../../../src/lib/s3.js', () => ({
  getS3Client: () => ({ send: sendMock }),
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://signed.example/vehicle-history-pdfs/x.pdf?sig=1'),
}));

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  generateVehicleHistoryPdfPresignedUrl,
  VehicleHistoryPdfS3UploadFailedError,
} from '../../../src/lib/vehicle-history-pdf-s3.js';
import type { VehicleHistoryPdfData } from '../../../src/lib/vehicle-history-pdf-renderer.js';

const DATA: VehicleHistoryPdfData = {
  vehicle: {
    plate: 'AB123CD',
    make: 'Fiat',
    model: 'Panda',
    version: null,
    garageCode: 'GO-973-JJHM',
    vin: 'ZFA31200000123456',
    year: 2019,
    fuelType: 'Diesel',
  },
  generatedAt: '2026-06-09',
  interventions: [],
};
const VEHICLE_ID = '55555555-5555-4555-8555-555555555555';

describe('generateVehicleHistoryPdfPresignedUrl', () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    vi.mocked(getSignedUrl).mockClear();
  });

  it('renders, puts to the per-vehicle key, and returns a presigned url + expiry', async () => {
    const res = await generateVehicleHistoryPdfPresignedUrl({
      bucket: 'test-bucket',
      vehicleId: VEHICLE_ID,
      data: DATA,
    });
    expect(sendMock).toHaveBeenCalledOnce();
    const putArg = sendMock.mock.calls[0]![0];
    expect(putArg.input.Key).toBe(`vehicle-history-pdfs/${VEHICLE_ID}.pdf`);
    expect(putArg.input.ContentType).toBe('application/pdf');
    expect(res.url).toContain('vehicle-history-pdfs');
    expect(res.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('wraps a PutObject failure in VehicleHistoryPdfS3UploadFailedError', async () => {
    sendMock.mockRejectedValueOnce(new Error('boom'));
    await expect(
      generateVehicleHistoryPdfPresignedUrl({ bucket: 'b', vehicleId: VEHICLE_ID, data: DATA }),
    ).rejects.toBeInstanceOf(VehicleHistoryPdfS3UploadFailedError);
  });
});
