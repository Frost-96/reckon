import { defineWriteOperation, defineWriteTool, type ToolDeclaration } from "@reckon/kernel";
import { z } from "zod";
import { type BusinessService, pathOf } from "./business-service.ts";

const returnRequest = z.object({
  orderId: z.string().min(1).describe("订单号"),
  lineId: z.string().min(1).describe("要退的商品行"),
  quantity: z.int().positive().describe("退货数量"),
  reason: z.string().trim().min(1).describe("退货原因"),
  // Part of what the customer confirms, and carried by the write (ADR 0006).
  returnFeeCents: z.int().nonnegative().describe("顾客确认过的退货运费，单位为分"),
});
type ReturnRequest = z.output<typeof returnRequest>;

const createdAftersales = z.object({ id: z.string() });

// One write tool, two ordered write operations, one confirmation (ADR 0003).
export function submitReturnTool(business: BusinessService): ToolDeclaration {
  return defineWriteTool({
    kind: "write",
    name: "submit_return",
    description:
      "提交退货：先创建售后单，再生成寄回单。参数须先经 request_confirmation 由顾客确认，且与确认时完全一致。",
    parameters: returnRequest,
    identity: ({ orderId, lineId }) => ({ orderId, lineId }),
    operations: [
      defineWriteOperation({
        name: "create_aftersales",
        parameters: (request: ReturnRequest, { customerId }) => ({ customerId, ...request }),
        send: ({ parameters, operationId, deadline, signal }) =>
          business.post(
            "aftersales",
            { ...parameters, clientRef: operationId, deadline: deadline.toISOString() },
            { idempotencyKey: operationId, signal },
          ),
      }),
      defineWriteOperation({
        name: "create_return_shipment",
        // From the aftersales order the first operation created.
        parameters: (_request: ReturnRequest, { customerId, earlier }) => ({
          customerId,
          aftersalesId: createdAftersales.parse(earlier[0]).id,
        }),
        send: ({ parameters: { customerId, aftersalesId }, operationId, deadline, signal }) =>
          business.post(
            pathOf("aftersales", aftersalesId, "return-shipments"),
            { customerId, clientRef: operationId, deadline: deadline.toISOString() },
            { idempotencyKey: operationId, signal },
          ),
      }),
    ],
  });
}
