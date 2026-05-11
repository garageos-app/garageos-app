import type { CustomerDetail as CustomerDetailDto, CustomerDetailUpdate } from '@/queries/types';

export type { CustomerDetailDto };

export type FormValues = {
  firstName: string;
  lastName: string;
  isBusiness: boolean;
  phone: string;
  taxCode: string;
  businessName: string;
  vatNumber: string;
  addressLine: string;
  city: string;
  province: string;
  postalCode: string;
  tenantNotes: string;
};

// Diff helper: builds a PATCH body containing only the fields that changed
// relative to the DTO. Empty-string form values map to null for nullable backend
// columns. When isBusiness toggles true→false, the caller is expected to also
// clear businessName/vatNumber form state (see CustomerDetail watch effect — voce 11);
// this function then emits `businessName: null` + `vatNumber: null` correctly via
// setNullable.
export function formToPatch(values: FormValues, dto: CustomerDetailDto): CustomerDetailUpdate {
  const patch: CustomerDetailUpdate = {};

  if (values.firstName !== dto.firstName) patch.firstName = values.firstName;
  if (values.lastName !== dto.lastName) patch.lastName = values.lastName;
  if (values.isBusiness !== dto.isBusiness) patch.isBusiness = values.isBusiness;

  const setNullable = (
    key:
      | 'phone'
      | 'taxCode'
      | 'businessName'
      | 'vatNumber'
      | 'addressLine'
      | 'city'
      | 'province'
      | 'postalCode',
    currentValue: string | null,
  ) => {
    const next = values[key] === '' ? null : values[key];
    if (next !== currentValue) patch[key] = next;
  };
  setNullable('phone', dto.phone);
  setNullable('taxCode', dto.taxCode);
  setNullable('businessName', dto.businessName);
  setNullable('vatNumber', dto.vatNumber);
  setNullable('addressLine', dto.addressLine);
  setNullable('city', dto.city);
  setNullable('province', dto.province);
  setNullable('postalCode', dto.postalCode);

  // tenantNotes lives on the CTR block in DTO but is a top-level patch field.
  const nextNotes = values.tenantNotes === '' ? null : values.tenantNotes;
  if (nextNotes !== dto.tenantRelation.tenantNotes) {
    patch.tenantNotes = nextNotes;
  }

  return patch;
}
