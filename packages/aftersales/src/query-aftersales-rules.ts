import { defineReadTool, type ToolDeclaration } from "@reckon/kernel";
import { z } from "zod";
import { type BusinessService, pathOf } from "./business-service.ts";

// Volatile (ADR 0006): the return fee can change during a task, and the fee is confirmed.
export function queryAftersalesRulesTool(business: BusinessService): ToolDeclaration {
  return defineReadTool({
    kind: "read",
    name: "query_aftersales_rules",
    description:
      "查询订单的售后规则：售后期限（天数与截止时刻）、当前是否仍在售后期限内，以及退货运费（单位为分）。可退数量与订单状态见 query_order。",
    parameters: z.object({
      orderId: z.string().min(1).describe("订单号"),
    }),
    volatility: "volatile",
    run: ({ orderId }, { customerId, signal }) =>
      business.get(pathOf("customers", customerId, "orders", orderId, "aftersales-rules"), signal),
  });
}
