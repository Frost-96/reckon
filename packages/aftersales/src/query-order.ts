import { defineReadTool, type ToolDeclaration } from "@reckon/kernel";
import { z } from "zod";
import { type BusinessService, pathOf } from "./business-service.ts";

// Volatile: refunds and other aftersales applications change status and returnable quantity.
export function queryOrderTool(business: BusinessService): ToolDeclaration {
  return defineReadTool({
    kind: "read",
    name: "query_order",
    description:
      "查询顾客的订单：给出订单号时返回该订单，含每个商品行的可退数量；不给订单号时列出顾客的全部订单。",
    parameters: z.object({
      orderId: z.string().min(1).optional().describe("订单号；不确定时留空，列出全部订单"),
    }),
    volatility: "volatile",
    async run({ orderId }, { customerId, signal }) {
      if (orderId !== undefined) {
        return business.get(pathOf("customers", customerId, "orders", orderId), signal);
      }
      const listed = await business.get(pathOf("customers", customerId, "orders"), signal);
      return listed.ok ? { ok: true, value: { orders: listed.value } } : listed;
    },
  });
}
