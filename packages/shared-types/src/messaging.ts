import { z } from 'zod';

/**
 * Staff <-> customer messaging module contract -- a simple async inbox
 * (no real-time), scoped to loyalty-enrolled customers (see
 * conversations.ts's schema comment for why). Split from loyalty.ts because
 * this is a distinct module (staff-created threads under /messaging, not
 * loyalty program data), even though it's currently only reachable from the
 * loyalty accounts list.
 */

export const sendMessageSchema = z.object({
  body: z.string().trim().min(1).max(5000),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const createConversationSchema = z.object({
  customerId: z.uuid(),
});
export type CreateConversationInput = z.infer<typeof createConversationSchema>;

export const messageSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  senderType: z.enum(['staff', 'customer']),
  senderId: z.uuid(),
  body: z.string(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
export type MessageDto = z.infer<typeof messageSchema>;

export const conversationSchema = z.object({
  id: z.uuid(),
  customerId: z.uuid(),
  businessId: z.uuid(),
  lastMessageAt: z.string(),
  lastMessagePreview: z.string().nullable(),
  status: z.enum(['open', 'closed']),
});
export type ConversationDto = z.infer<typeof conversationSchema>;

/** Staff list view -- joined with the customer's identity, same
 * "extend with joined identity" shape as loyaltyAccountWithCustomerSchema. */
export const conversationWithCustomerSchema = conversationSchema.extend({
  customer: z.object({
    id: z.uuid(),
    phone: z.string(),
    fullName: z.string().nullable(),
  }),
  unreadCount: z.number().int(),
});
export type ConversationWithCustomerDto = z.infer<typeof conversationWithCustomerSchema>;

/** Customer list view -- joined with the business's identity. */
export const conversationWithBusinessSchema = conversationSchema.extend({
  business: z.object({
    id: z.uuid(),
    name: z.string(),
  }),
  unreadCount: z.number().int(),
});
export type ConversationWithBusinessDto = z.infer<typeof conversationWithBusinessSchema>;
