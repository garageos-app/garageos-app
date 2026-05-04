import { describe, expect, it, vi } from 'vitest';

import {
  preValidateAttachmentsForDispute,
  type AttachmentValidatorTx,
} from '../../../src/lib/dispute-attachments.js';

describe('preValidateAttachmentsForDispute', () => {
  function buildTx(
    rows: Array<{
      id: string;
      ownerType: string;
      ownerId: string;
      uploadedByCustomerId: string | null;
      uploadedByUserId: string | null;
      customerId: string | null;
      tenantId: string | null;
      processed: boolean;
      disputeId: string | null;
    }>,
  ): AttachmentValidatorTx {
    return {
      attachment: {
        findMany: vi.fn().mockResolvedValue(rows),
      },
    };
  }

  it('returns void on empty input', async () => {
    const tx = buildTx([]);
    await expect(
      preValidateAttachmentsForDispute(tx, {
        attachmentIds: undefined,
        interventionId: 'i1',
        uploader: { customerId: 'c1' },
      }),
    ).resolves.toBeUndefined();
    expect(tx.attachment.findMany).not.toHaveBeenCalled();
  });

  it('returns void on empty array', async () => {
    const tx = buildTx([]);
    await expect(
      preValidateAttachmentsForDispute(tx, {
        attachmentIds: [],
        interventionId: 'i1',
        uploader: { customerId: 'c1' },
      }),
    ).resolves.toBeUndefined();
  });

  it('throws attachment_not_found when count mismatch', async () => {
    const tx = buildTx([]);
    await expect(
      preValidateAttachmentsForDispute(tx, {
        attachmentIds: ['a1'],
        interventionId: 'i1',
        uploader: { customerId: 'c1' },
      }),
    ).rejects.toMatchObject({
      name: 'intervention.dispute.attachment_not_found',
      statusCode: 422,
    });
  });

  it('throws attachment_not_processed when any row is unprocessed', async () => {
    const tx = buildTx([
      {
        id: 'a1',
        ownerType: 'intervention_dispute',
        ownerId: 'i1',
        uploadedByCustomerId: 'c1',
        uploadedByUserId: null,
        customerId: 'c1',
        tenantId: 't1',
        processed: false,
        disputeId: null,
      },
    ]);
    await expect(
      preValidateAttachmentsForDispute(tx, {
        attachmentIds: ['a1'],
        interventionId: 'i1',
        uploader: { customerId: 'c1' },
      }),
    ).rejects.toMatchObject({
      name: 'intervention.dispute.attachment_not_processed',
      statusCode: 422,
    });
  });

  it('throws attachment_already_claimed when disputeId is set', async () => {
    const tx = buildTx([
      {
        id: 'a1',
        ownerType: 'intervention_dispute',
        ownerId: 'i1',
        uploadedByCustomerId: 'c1',
        uploadedByUserId: null,
        customerId: 'c1',
        tenantId: 't1',
        processed: true,
        disputeId: 'd-existing',
      },
    ]);
    await expect(
      preValidateAttachmentsForDispute(tx, {
        attachmentIds: ['a1'],
        interventionId: 'i1',
        uploader: { customerId: 'c1' },
      }),
    ).rejects.toMatchObject({
      name: 'intervention.dispute.attachment_already_claimed',
      statusCode: 409,
    });
  });

  it('passes findMany filter with customer-uploader where clause', async () => {
    const tx = buildTx([
      {
        id: 'a1',
        ownerType: 'intervention_dispute',
        ownerId: 'i1',
        uploadedByCustomerId: 'c1',
        uploadedByUserId: null,
        customerId: 'c1',
        tenantId: 't1',
        processed: true,
        disputeId: null,
      },
    ]);
    await preValidateAttachmentsForDispute(tx, {
      attachmentIds: ['a1'],
      interventionId: 'i1',
      uploader: { customerId: 'c1' },
    });
    expect(tx.attachment.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['a1'] },
        ownerType: 'intervention_dispute',
        ownerId: 'i1',
        uploadedByCustomerId: 'c1',
      },
      select: expect.any(Object),
    });
  });

  it('passes findMany filter with officina-uploader where clause', async () => {
    const tx = buildTx([
      {
        id: 'a1',
        ownerType: 'intervention_dispute',
        ownerId: 'i1',
        uploadedByCustomerId: null,
        uploadedByUserId: 'u1',
        customerId: null,
        tenantId: 't1',
        processed: true,
        disputeId: null,
      },
    ]);
    await preValidateAttachmentsForDispute(tx, {
      attachmentIds: ['a1'],
      interventionId: 'i1',
      uploader: { userId: 'u1', tenantId: 't1' },
    });
    expect(tx.attachment.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['a1'] },
        ownerType: 'intervention_dispute',
        ownerId: 'i1',
        uploadedByUserId: 'u1',
        tenantId: 't1',
        customerId: null,
      },
      select: expect.any(Object),
    });
  });
});
