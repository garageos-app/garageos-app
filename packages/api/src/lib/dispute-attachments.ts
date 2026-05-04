import { businessError } from './business-error.js';

// Pre-validate + claim helpers per gli attachment legati a una dispute.
// Usato da entrambi i route handler dispute create (customer-side) e
// dispute response (officina-side). Il claim atomico (UPDATE dispute_id)
// avviene nelle route stesse — l'helper qui pre-valida soltanto.
//
// Spec: docs/superpowers/specs/2026-05-04-dispute-attachments-wiring-design.md §6.3-6.4

export interface AttachmentValidatorTx {
  attachment: {
    findMany: (args: {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
    }) => Promise<
      Array<{
        id: string;
        processed: boolean;
        disputeId: string | null;
      }>
    >;
  };
}

export type DisputeAttachmentUploader =
  | { customerId: string }
  | { userId: string; tenantId: string };

export interface PreValidateInput {
  attachmentIds: string[] | undefined;
  interventionId: string;
  uploader: DisputeAttachmentUploader;
}

const ATTACHMENT_SELECT = {
  id: true,
  processed: true,
  disputeId: true,
} as const;

export async function preValidateAttachmentsForDispute(
  tx: AttachmentValidatorTx,
  input: PreValidateInput,
): Promise<void> {
  const ids = input.attachmentIds;
  if (!ids || ids.length === 0) return;

  const uploaderFilter =
    'customerId' in input.uploader
      ? { uploadedByCustomerId: input.uploader.customerId }
      : {
          uploadedByUserId: input.uploader.userId,
          tenantId: input.uploader.tenantId,
          customerId: null,
        };

  const rows = await tx.attachment.findMany({
    where: {
      id: { in: ids },
      ownerType: 'intervention_dispute',
      ownerId: input.interventionId,
      ...uploaderFilter,
    },
    select: ATTACHMENT_SELECT,
  });

  if (rows.length !== ids.length) {
    throw businessError(
      'intervention.dispute.attachment_not_found',
      422,
      'Uno o più allegati indicati non sono validi o non sono stati caricati da te.',
    );
  }

  for (const row of rows) {
    if (!row.processed) {
      throw businessError(
        'intervention.dispute.attachment_not_processed',
        422,
        'Devi confermare il caricamento di tutti gli allegati prima di crearli.',
      );
    }
    if (row.disputeId !== null) {
      throw businessError(
        'intervention.dispute.attachment_already_claimed',
        409,
        "Uno o più allegati sono già stati associati a un'altra contestazione.",
      );
    }
  }
}
