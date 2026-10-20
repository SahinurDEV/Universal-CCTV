import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Example plan tiers — not fixed product/pricing commitments (same caveat
 * as the retention-day examples in docs/requirements.md). Stored in the DB,
 * not hardcoded into the recording engine, per docs/requirements.md §15 —
 * the recording/retention/camera code never references a price or a plan
 * key directly, only `SubscriptionPlan` rows via the tenant's active
 * `Subscription`. Prices are illustrative placeholders; see
 * docs/retention-and-storage.md §8's cost worked example before treating
 * any of these as real pricing.
 */
const PLANS = [
  {
    key: "free",
    name: "Free Trial",
    cameraLimit: 2,
    storageQuotaGb: 5,
    maxRetentionDays: 7,
    priceCentsMonthly: 0,
  },
  {
    key: "starter",
    name: "Starter",
    cameraLimit: 10,
    storageQuotaGb: 50,
    maxRetentionDays: 30,
    priceCentsMonthly: 2900,
  },
  {
    key: "pro",
    name: "Pro",
    cameraLimit: 50,
    storageQuotaGb: 500,
    maxRetentionDays: 90,
    priceCentsMonthly: 9900,
  },
];

async function main() {
  for (const plan of PLANS) {
    await prisma.subscriptionPlan.upsert({
      where: { key: plan.key },
      create: plan,
      update: plan,
    });
  }
  console.log(`Seeded ${PLANS.length} subscription plans.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
