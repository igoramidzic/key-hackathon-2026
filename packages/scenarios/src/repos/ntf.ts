import type { RepoOverlay } from '../types';

/** keybank/NTF00/notification-service: email, SMS and push fan-out. */
export const NTF_REPO = 'keybank/NTF00/notification-service';

export const NTF_PATHS = {
  profileClient: 'src/clients/customerProfileClient.ts',
  dispatcher: 'src/services/notificationDispatcher.ts',
} as const;

const PROFILE_CLIENT = `const CIF_BASE_URL = process.env.CIF_BASE_URL ?? 'https://cif.internal.keybank.example';

export type Channel = 'EMAIL' | 'SMS' | 'PUSH';

export interface CustomerContact {
  customerId: string;
  firstName: string;
  primaryEmail?: string;
  mobilePhone?: string;
  contactPreferences: { email: boolean; sms: boolean; push: boolean; preferredChannel: Channel };
}

export async function getContact(customerId: string, token: string): Promise<CustomerContact> {
  const res = await fetch(\`\${CIF_BASE_URL}/v1/customers/\${encodeURIComponent(customerId)}/profile\`, {
    headers: { authorization: \`Bearer \${token}\` },
    signal: AbortSignal.timeout(2_000),
  });
  if (!res.ok) throw new Error(\`customer-profile-api responded \${res.status}\`);
  return (await res.json()) as CustomerContact;
}
`;

export const NTF_DISPATCHER = `import type { Logger } from 'pino';
import { type Channel, type CustomerContact, getContact } from '../clients/customerProfileClient';
import { send } from './channels';

export interface NotificationEvent {
  eventId: string;
  type: string;
  customerId: string;
  /** Some events (OTP, fraud alerts) must go to one channel regardless of preferences. */
  forcedChannel?: Channel;
  data: Record<string, string>;
}

export interface Recipient {
  customerId: string;
  channel: Channel;
  address: string;
  firstName: string;
}

export async function resolveRecipient(event: NotificationEvent, token: string): Promise<Recipient> {
  const contact = await getContact(event.customerId, token);
  const channel = event.forcedChannel ?? contact.contactPreferences.preferredChannel;
  return { customerId: event.customerId, channel, address: addressFor(contact, channel), firstName: contact.firstName };
}

function addressFor(contact: CustomerContact, channel: Channel): string {
  const address = channel === 'EMAIL' ? contact.primaryEmail : channel === 'SMS' ? contact.mobilePhone : contact.customerId;
  if (!address) throw new Error(\`no \${channel} address on file for \${contact.customerId}\`);
  return address;
}

/** Consumes one event from the notifications topic. Failures are logged and dropped (no retry). */
export async function dispatch(log: Logger, event: NotificationEvent, token: string): Promise<void> {
  try {
    const recipient = await resolveRecipient(event, token);
    await send(recipient, event);
  } catch (err) {
    log.error(
      { err, eventId: event.eventId, notificationType: event.type, customerId: event.customerId },
      'notification dropped: recipient resolution failed',
    );
  }
}
`;

export const ntfOverlay: RepoOverlay = {
  complete: false,
  files: {
    [NTF_PATHS.profileClient]: PROFILE_CLIENT,
    [NTF_PATHS.dispatcher]: NTF_DISPATCHER,
  },
};
