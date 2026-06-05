// Mirrors the GET /v1/me body (projectCustomerSelf, camelCase).
export type MeProfile = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  status: string;
  createdAt: string;
};

// PATCH /v1/me/profile payload (editable fields only).
export type UpdateMeProfileBody = {
  firstName: string;
  lastName: string;
  phone: string | null;
};
