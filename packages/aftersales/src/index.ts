import type { BusinessPackage } from "@reckon/kernel";
import { createBusinessService } from "./business-service.ts";
import { systemPrompt } from "./prompt.ts";
import { queryAftersalesTool } from "./query-aftersales.ts";
import { queryAftersalesRulesTool } from "./query-aftersales-rules.ts";
import { queryOrderTool } from "./query-order.ts";
import { submitReturnTool } from "./submit-return.ts";

export interface AftersalesOptions {
  // Base URL of the business service, e.g. http://business-mock:3000.
  businessServiceUrl: string;
}

export function createAftersalesPackage(options: AftersalesOptions): BusinessPackage {
  const business = createBusinessService(options.businessServiceUrl);
  return {
    systemPrompt,
    tools: [
      queryOrderTool(business),
      queryAftersalesRulesTool(business),
      queryAftersalesTool(business),
      submitReturnTool(business),
    ],
  };
}
