import { expect, test } from "vitest";
import { createScriptedModel } from "./index.ts";

const request = { messages: [{ role: "user" as const, content: "hi" }], tools: [] };

test("the scripted model streams its reply in fragments that add up to the reply", async () => {
  const model = createScriptedModel([{ content: "您好，请问是哪一笔订单？" }]);
  const fragments: string[] = [];

  const response = await model.complete(request, {
    onTextDelta: (delta) => {
      fragments.push(delta);
    },
  });

  expect(response).toEqual({ content: "您好，请问是哪一笔订单？", toolCalls: [] });
  expect(fragments.length).toBeGreaterThan(1);
  expect(fragments.join("")).toBe("您好，请问是哪一笔订单？");
});

test("the scripted model pushes the next fragment only once the previous one has been taken", async () => {
  const model = createScriptedModel([{ content: "您好，请问是哪一笔订单？" }]);
  const fragments: string[] = [];
  let take = () => {};

  const completing = model.complete(request, {
    onTextDelta: (delta) => {
      fragments.push(delta);
      return new Promise<void>((resolve) => {
        take = resolve;
      });
    },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  await settle();
  expect(fragments).toEqual(["您好，请"]);
  take();
  await settle();
  expect(fragments).toEqual(["您好，请", "问是哪一"]);
  take();
  await settle();
  take();
  expect(await completing).toEqual({ content: "您好，请问是哪一笔订单？", toolCalls: [] });
  expect(fragments).toEqual(["您好，请", "问是哪一", "笔订单？"]);
});

test("the scripted model fails a request its script has no response for", async () => {
  const model = createScriptedModel([{ content: "only one" }]);
  await model.complete(request);

  await expect(model.complete(request)).rejects.toThrow(/no response for request #2/);
});
