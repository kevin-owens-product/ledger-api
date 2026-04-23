import crypto from 'node:crypto';

export function signWebhookPayload(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}
