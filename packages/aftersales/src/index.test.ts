import { expect, test } from "vitest";
import { createAftersalesPackage } from "./index.ts";

// Recheck reruns volatile reads only, so this is what lets it see a changed fee (ADR 0006).
test("every aftersales read tool is volatile, the aftersales rules included", () => {
  const { tools } = createAftersalesPackage({ businessServiceUrl: "http://business.invalid" });
  const volatilities = Object.fromEntries(
    tools.flatMap((tool) => (tool.kind === "read" ? [[tool.name, tool.volatility]] : [])),
  );

  expect(volatilities).toEqual({
    query_order: "volatile",
    query_aftersales_rules: "volatile",
    query_aftersales: "volatile",
  });
});
