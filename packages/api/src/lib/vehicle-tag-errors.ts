// Error classes for the vehicle-tag routes. Extracted from the former
// vehicle-tag-s3.ts (deleted in the streaming refactor) so both
// vehicles-tag.ts and vehicles-tag-reprint.ts keep a stable import.

export class VehicleTagAuditInsertFailedError extends Error {
  override name = 'vehicle_tag.audit_insert_failed';
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
  }
}
