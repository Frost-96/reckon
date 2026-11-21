import { requireEnv } from "@reckon/shared";
import pg from "pg";
import { expect, test } from "vitest";

function executorConnectionTo(database: string): pg.Client {
  const url = new URL(requireEnv("EXECUTION_DATABASE_URL"));
  url.pathname = `/${database}`;
  return new pg.Client({ connectionString: url.toString() });
}

test("executor role can query the execution database", async () => {
  const client = executorConnectionTo("execution");
  await client.connect();
  try {
    const result = await client.query<{ current_user: string }>("select current_user");
    expect(result.rows[0]?.current_user).toBe("execution");
  } finally {
    await client.end();
  }
});

test("executor role is refused by the business database", async () => {
  const client = executorConnectionTo("business");
  await expect(client.connect()).rejects.toMatchObject({ code: "42501" });
});
