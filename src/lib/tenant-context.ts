import { AsyncLocalStorage } from 'node:async_hooks';

interface TenantScope {
  tenantId: string;
}

const tenantStore = new AsyncLocalStorage<TenantScope>();

export function runWithTenantScope<T>(tenantId: string, callback: () => Promise<T>): Promise<T> {
  return tenantStore.run({ tenantId }, callback);
}

export function getTenantScope(): TenantScope | undefined {
  return tenantStore.getStore();
}
