export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON Schema format
  execute: (args: any) => Promise<any>;
}

// Mock Tools
export const findStripeCustomer: Tool = {
  name: "find_stripe_customer",
  description: "Search for a customer by email to get their ID and MRR.",
  parameters: {
    type: "object",
    properties: {
      email: { type: "string" }
    },
    required: ["email"]
  },
  execute: async ({ email }) => {
    console.log(`[Mock] Searching Stripe for ${email}`);
    if (email.includes("fail")) throw new Error("Customer not found");
    return { customerId: "cus_123", mrr: 5000 };
  }
};

export const sendSlackMessage: Tool = {
  name: "send_slack_message",
  description: "Send a message to a Slack channel.",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string" },
      message: { type: "string" }
    },
    required: ["channel", "message"]
  },
  execute: async ({ channel, message }) => {
    console.log(`[Mock] Sending Slack message to ${channel}: ${message}`);
    return { success: true, timestamp: new Date().toISOString() };
  }
};

export const sendEmail: Tool = {
  name: "send_email",
  description: "Send an email to a recipient.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string" },
      subject: { type: "string" },
      body: { type: "string" }
    },
    required: ["to", "subject", "body"]
  },
  execute: async ({ to, subject, body }) => {
    console.log(`[Mock] Sending email to ${to}: ${subject}`);
    return { success: true, messageId: "msg_123" };
  }
};

export const createCrmNote: Tool = {
  name: 'create_crm_note',
  description: 'Create a note on a customer record in the CRM using their Stripe customer ID.',
  parameters: {
    type: 'object',
    properties: {
      customerId: { type: 'string', description: 'Stripe customer ID (e.g. cus_123)' },
      note: { type: 'string', description: 'Note content to attach to the customer record' },
    },
    required: ['customerId', 'note'],
  },
  execute: async ({ customerId, note }) => {
    console.log(`[Mock] Creating CRM note for ${customerId}: "${note}"`);
    return { success: true, noteId: 'note_456', customerId };
  },
};

export const toolLibrary: Record<string, Tool> = {
  find_stripe_customer: findStripeCustomer,
  send_slack_message: sendSlackMessage,
  send_email: sendEmail,
  create_crm_note: createCrmNote,
};