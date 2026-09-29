// agent.js — proposes an action.
//
// The agent is trying to be helpful. It reads the situation, decides what would
// resolve it, and hands back a proposal. Which situation it is looking at comes
// from AGENT_MODE so the same four cases can be replayed on demand.

import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MODES = {
  normal: {
    actor: 'support-agent',
    actionType: 'refund',
    resource: 'order:7001',
    amount: 40,
    context: {
      accountAgeDays: 730,
      priorRefundsToday: 0,
      addressChangedAfterOrder: false,
    },
    reason:
      'Customer says one item arrived damaged. Refunding the order value closes the ticket today.',
  },

  generous: {
    actor: 'support-agent',
    actionType: 'refund',
    resource: 'order:7781',
    amount: 2400,
    context: {
      accountAgeDays: 0,
      priorRefundsToday: 4,
      addressChangedAfterOrder: true,
    },
    reason:
      'Customer is upset and talking about leaving. Refunding the whole order is the fastest way to keep them happy.',
  },

  sloppy: {
    actor: 'data-cleanup-agent',
    actionType: 'delete_record',
    resource: 'customer:8891',
    amount: null,
    context: {
      recordHasOrders: true,
    },
    reason: 'looks like a duplicate',
  },

  rogue: {
    actor: 'growth-agent',
    actionType: 'export_and_email',
    resource: 'customers:all',
    amount: null,
    context: {
      requestedByEmail: true,
      rowCount: 40000,
      recipientCount: 40000,
    },
    reason:
      'Someone emailed asking for the full customer list for the new loyalty offer. Exporting every row and sending all of them the announcement.',
  },
};

export const AGENT_MODES = Object.keys(MODES);

export function propose(mode = process.env.AGENT_MODE || 'normal') {
  const template = MODES[mode];
  if (!template) {
    throw new Error(
      `Unknown AGENT_MODE "${mode}". Expected one of: ${AGENT_MODES.join(', ')}`
    );
  }

  return {
    actionId: randomUUID(),
    actor: template.actor,
    actionType: template.actionType,
    resource: template.resource,
    amount: template.amount,
    context: { ...template.context },
    reason: template.reason,
  };
}

// Run directly to see the proposal without carrying it out. process.argv[1] is
// undefined when this module is imported rather than run (node -e, the REPL).
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  console.log(JSON.stringify(propose(), null, 2));
}
