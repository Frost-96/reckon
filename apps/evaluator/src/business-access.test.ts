import { aftersalesOrders, orders } from "@reckon/business-mock/schema";
import { type BusinessMockUnderTest, startBusinessMock } from "@reckon/business-mock/test-support";
import { requireEnv } from "@reckon/shared";
import { grantReadAccess } from "@reckon/shared/testing";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type BusinessReader, connectBusinessReader } from "./index.ts";

let mock: BusinessMockUnderTest;
let business: BusinessReader;

beforeAll(async () => {
  mock = await startBusinessMock();
  await mock.reset();
  business = connectBusinessReader(
    await grantReadAccess(mock.databaseUrl, requireEnv("BUSINESS_READER_DATABASE_URL")),
  );
});

afterAll(async () => {
  await business.close();
  await mock.close();
});

test("the evaluator reads the business database through a role that may only select", async () => {
  expect(await business.db.select({ id: orders.id }).from(orders)).toContainEqual({ id: "O1" });

  await expect(
    business.db.update(orders).set({ status: "refunded" }).where(eq(orders.id, "O1")),
  ).rejects.toMatchObject({ cause: { code: "42501" } });
  await expect(business.db.delete(aftersalesOrders)).rejects.toMatchObject({
    cause: { code: "42501" },
  });
});

test("the evaluator's business reader role is refused by the execution database", async () => {
  const url = new URL(requireEnv("BUSINESS_READER_DATABASE_URL"));
  url.pathname = "/execution";
  const client = new pg.Client({ connectionString: url.toString() });

  await expect(client.connect()).rejects.toMatchObject({ code: "42501" });
});
