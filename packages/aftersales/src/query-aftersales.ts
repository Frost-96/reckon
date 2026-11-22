import { defineReadTool, type ToolDeclaration } from "@reckon/kernel";
import { z } from "zod";
import { type BusinessService, pathOf } from "./business-service.ts";

// Volatile: records progress, and others may open applications on the same line. Each record
// carries the client_ref it was written with, so a task can tell its own writes (ADR 0005).
export function queryAftersalesTool(business: BusinessService): ToolDeclaration {
  return defineReadTool({
    kind: "read",
    name: "query_aftersales",
    description:
      "查询顾客的售后单与进度：每张售后单的商品行、数量、状态、退货运费、寄回单，以及写入时的客户端参考号（clientRef）。给出订单号时只查该订单。",
    parameters: z.object({
      orderId: z.string().min(1).optional().describe("订单号；留空查询顾客的全部售后单"),
    }),
    volatility: "volatile",
    async run({ orderId }, { customerId, signal }) {
      const path = pathOf("customers", customerId, "aftersales");
      const query = orderId === undefined ? "" : `?${new URLSearchParams({ orderId })}`;
      const listed = await business.get(`${path}${query}`, signal);
      return listed.ok ? { ok: true, value: { aftersales: listed.value } } : listed;
    },
  });
}
