import type { Tenant } from '@prisma/client';

export interface AuthContext {
  tenant: Pick<Tenant, 'id' | 'name' | 'webhookUrl' | 'webhookSecret'>;
  authType: 'api_key' | 'bearer_token';
}
