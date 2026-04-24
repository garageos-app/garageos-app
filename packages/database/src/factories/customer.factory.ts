import { randomUUID } from 'node:crypto';

import { Factory } from 'fishery';

import { prisma } from '../client.js';
import type { Prisma } from '../../prisma/generated/prisma/client/client.js';

// Default is a B2C shadow account (BR-224): no cognitoSub, not app-installed.
// Use `businessCustomer` for a fully-populated B2B record.

export const CustomerFactory = Factory.define<Prisma.CustomerUncheckedCreateInput>(
  ({ sequence, onCreate }) => {
    onCreate(async (data) => {
      await prisma.customer.create({ data });
      return data;
    });

    return {
      id: randomUUID(),
      cognitoSub: null,
      email: `customer-${sequence}@test.local`,
      firstName: 'Luigi',
      lastName: 'Bianchi',
      phone: null,
      taxCode: null,
      isBusiness: false,
      businessName: null,
      vatNumber: null,
      addressLine: null,
      city: null,
      province: null,
      postalCode: null,
      appInstalled: false,
      notificationPreferences: {},
      status: 'active',
    };
  },
);

// BR-223 — B2C business customer: `business_name` and `vat_number` must be set.
export const businessCustomer = CustomerFactory.params({
  isBusiness: true,
  businessName: 'Autotrasporti Bianchi S.r.l.',
  vatNumber: '12345678901',
});

// App-installed customer (BR-224 "active" state) — has a cognito sub.
export const activeCustomer = CustomerFactory.params({
  cognitoSub: `cognito-customer-${Date.now()}`,
  appInstalled: true,
});
