import type { Subscription, SubscriptionPlan, SubscriptionStatus } from "@prisma/client";

export interface BillingChangeResult {
  status: SubscriptionStatus;
  currentPeriodEnd: Date;
  /** External identifier a real provider would assign (Stripe customer/sub
   * ID, etc). The dev provider never sets this — there is no external
   * system to reference. */
  externalCustomerId: string | null;
}

/**
 * Billing-provider abstraction per docs/requirements.md §15: plan limits
 * and prices live in `SubscriptionPlan` rows, never hardcoded into the
 * recording/retention engine, and the *mechanism* of actually charging
 * someone is isolated behind this interface so a real provider (Stripe,
 * etc.) can be dropped in later without touching quota-enforcement code.
 *
 * No real payment provider is wired up — see docs/requirements.md's note
 * that payment provider availability varies by country and shouldn't be
 * assumed. `DevBillingProvider` below is the only implementation that
 * exists right now, and it is not a payment processor.
 */
export interface BillingProvider {
  readonly name: string;
  changePlan(input: { subscription: Subscription; newPlan: SubscriptionPlan }): Promise<BillingChangeResult>;
  cancel(input: { subscription: Subscription }): Promise<BillingChangeResult>;
}

const DEV_BILLING_PERIOD_DAYS = 30;

/**
 * Simulates a billing provider with no real payment involved — every call
 * "succeeds" immediately. This must never be presented as a real
 * transaction (docs/requirements.md §15): the UI labels every plan-change
 * action as using development billing, and `Subscription.billingProvider`
 * is persisted as `"dev"` so it's auditable which subscriptions never went
 * through real payment processing.
 */
export const devBillingProvider: BillingProvider = {
  name: "dev",

  async changePlan() {
    return {
      status: "ACTIVE",
      currentPeriodEnd: new Date(Date.now() + DEV_BILLING_PERIOD_DAYS * 24 * 60 * 60 * 1000),
      externalCustomerId: null,
    };
  },

  async cancel() {
    return {
      status: "CANCELED",
      currentPeriodEnd: new Date(),
      externalCustomerId: null,
    };
  },
};

export function getBillingProvider(): BillingProvider {
  return devBillingProvider;
}
