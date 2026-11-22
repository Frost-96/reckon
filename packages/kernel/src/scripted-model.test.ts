import { expect, test } from "vitest";
import { createScriptedModel } from "./index.ts";

const request = { messages: [{ role: "user" as const, content: "hi" }], tools: [] };

test("the scripted model streams its reply in fragments that add up to the reply", async () => {
  const model = createScriptedModel([{ content: "您好，请问是哪一笔订单？" }]);
  const fragments: string[] = [];

  const response = await model.complete(request, { onTextDelta: (delta) => fragments.push(delta) });

  expect(response).toEqual({ content: "您好，请问是哪一笔订单？", toolCalls: [] });
  expect(fragments.length).toBeGreaterThan(1);
  expect(fragments.join("")).toBe("您好，请问是哪一笔订单？");
});

test("the scripted model fails a request its script has no response for", async () => {
  const model = createScriptedModel([{ content: "only one" }]);
  await model.complete(request);

  await expect(model.complete(request)).rejects.toThrow(/no response for request #2/);
});
