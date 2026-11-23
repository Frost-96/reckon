import { canonicalHash } from "@reckon/shared";
import type { z } from "zod";
import type { scenarioSchema } from "./scenario.ts";

// A scenario as written to its data file.
export type ScenarioFile = z.input<typeof scenarioSchema>;
type BusinessData = ScenarioFile["business"];
type Order = BusinessData["orders"][number];
type Line = Order["lines"][number];
type SeededAftersales = NonNullable<BusinessData["aftersales"]>[number];
type ScriptedResponse = ScenarioFile["model"]["turns"][number][number];
type BusinessAssertion = ScenarioFile["expected"]["business"][number];

export interface ScenarioVariant {
  name: string;
  build(name: string): ScenarioFile;
}

export interface ScenarioTemplate {
  name: string;
  variants: readonly ScenarioVariant[];
}

// Deterministic draws from a scenario's name: regenerating always gives the same dataset, and
// two scenarios of one variant differ in their facts.
interface Draws {
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
}

function drawsFrom(seed: string): Draws {
  let count = 0;
  const next = () => Number.parseInt(canonicalHash([seed, count++]).slice(0, 12), 16);
  return {
    int: (min, max) => min + (next() % (max - min + 1)),
    pick: (items) => at(items, next() % items.length),
  };
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`No item at ${index}`);
  }
  return item;
}

// No name contains another, so a customer choosing by product name is never ambiguous.
const products = [
  "电水壶",
  "马克杯",
  "台灯",
  "蓝牙耳机",
  "保温杯",
  "帆布包",
  "机械键盘",
  "无线鼠标",
  "羽绒枕",
  "毛巾套装",
  "陶瓷碗",
  "电动牙刷",
  "加湿器",
  "折叠伞",
  "收纳箱",
  "运动手环",
  "吹风机",
  "空气炸锅",
] as const;
const reasons = [
  "不想要了",
  "尺寸不合适",
  "颜色和图片不一样",
  "收到时外包装破损",
  "买重复了",
  "质量有问题",
  "功能不符合预期",
] as const;
const returnWindows = [7, 15, 30] as const;
const returnFees = [0, 500, 800, 1000, 1500] as const;

// The facts of one scenario's shop: one customer, their orders, and someone else's.
class Shop {
  readonly draws: Draws;
  readonly customerId: string;
  readonly policy: BusinessData["policy"];
  readonly orders: Order[] = [];
  readonly aftersales: SeededAftersales[] = [];
  private readonly unusedProducts: string[] = [...products];
  private readonly orderIds = new Set<string>();

  constructor(seed: string) {
    this.draws = drawsFrom(seed);
    this.customerId = `C-${this.draws.int(1000, 9999)}`;
    this.policy = {
      returnWindowDays: this.draws.pick(returnWindows),
      returnFeeCents: this.draws.pick(returnFees),
    };
  }

  product(): string {
    const index = this.draws.int(0, this.unusedProducts.length - 1);
    const [product] = this.unusedProducts.splice(index, 1);
    if (product === undefined) {
      throw new Error("The catalog ran out of products");
    }
    return product;
  }

  reason(): string {
    return this.draws.pick(reasons);
  }

  // Delivered well inside the return window unless told otherwise.
  order(
    lines: readonly { productName?: string; quantity?: number | undefined }[],
    options: { customerId?: string; status?: Order["status"]; deliveredDaysAgo?: number } = {},
  ): Order {
    let id: string;
    do {
      id = `O-${this.draws.int(10000, 99999)}`;
    } while (this.orderIds.has(id));
    this.orderIds.add(id);
    const order: Order = {
      id,
      customerId: options.customerId ?? this.customerId,
      status: options.status ?? "delivered",
      deliveredDaysAgo:
        options.deliveredDaysAgo ?? this.draws.int(1, this.policy.returnWindowDays - 2),
      lines: lines.map((line, k) => ({
        id: `L${k + 1}`,
        productName: line.productName ?? this.product(),
        quantity: line.quantity ?? this.draws.int(1, 3),
      })),
    };
    this.orders.push(order);
    return order;
  }

  // An order of someone else's: it must stay untouched.
  someoneElsesOrder(): Order {
    let customerId: string;
    do {
      customerId = `C-${this.draws.int(1000, 9999)}`;
    } while (customerId === this.customerId);
    return this.order([{}], { customerId });
  }

  seedAftersales(order: Order, line: Line, record: Pick<SeededAftersales, "quantity" | "status">) {
    this.aftersales.push({
      id: `AS-EARLIER-${this.aftersales.length + 1}`,
      orderId: order.id,
      lineId: line.id,
      reason: "此前的申请",
      returnFeeCents: this.policy.returnFeeCents,
      ...record,
    });
  }

  business(): BusinessData {
    return { policy: this.policy, orders: this.orders, aftersales: this.aftersales };
  }
}

function lineOf(order: Order, index = 0): Line {
  return at(order.lines, index);
}

// What the customer wants returned: the parameters they confirm.
interface Wanted {
  order: Order;
  line: Line;
  quantity: number;
  reason: string;
}

function anyQuantity(shop: Shop, order: Order, line = lineOf(order)): Wanted {
  return { order, line, quantity: shop.draws.int(1, line.quantity), reason: shop.reason() };
}

function returnParameters(wanted: Wanted, fee: number) {
  return {
    orderId: wanted.order.id,
    lineId: wanted.line.id,
    quantity: wanted.quantity,
    reason: wanted.reason,
    returnFeeCents: fee,
  };
}

const yuan = (cents: number) => (cents / 100).toFixed(2);

// The agent's moves, as the scripted model makes them.
const agent = {
  looksUpOrder: (orderId: string): ScriptedResponse => ({
    content: "好的，我先查一下这笔订单。",
    toolCalls: [{ name: "query_order", arguments: { orderId } }],
  }),
  readsRules: (orderId: string): ScriptedResponse => ({
    toolCalls: [{ name: "query_aftersales_rules", arguments: { orderId } }],
  }),
  asks: (question: string, slot: string, options?: string[]): ScriptedResponse => ({
    toolCalls: [
      {
        name: "ask_user",
        arguments: { question, slot, ...(options === undefined ? {} : { options }) },
      },
    ],
  }),
  asksToConfirm: (wanted: Wanted, fee: number): ScriptedResponse => ({
    toolCalls: [
      {
        name: "request_confirmation",
        arguments: {
          tool: "submit_return",
          parameters: returnParameters(wanted, fee),
          message: `请确认：退订单 ${wanted.order.id} 的${wanted.line.productName} ${wanted.quantity} 件，原因“${wanted.reason}”，退货运费 ${yuan(fee)} 元。`,
        },
      },
    ],
  }),
  submits: (wanted: Wanted, fee: number): ScriptedResponse => ({
    toolCalls: [{ name: "submit_return", arguments: returnParameters(wanted, fee) }],
  }),
  says: (content: string): ScriptedResponse => ({ content }),
};

const progressQuestion = "退货办得怎么样了？";

function progressTurn(orderId: string): ScriptedResponse[] {
  return [
    { toolCalls: [{ name: "query_aftersales", arguments: { orderId } }] },
    agent.says("您的售后单正在处理中，寄回单已生成，请按寄回单把商品寄回。"),
  ];
}

// The turn after the customer confirms: the confirmed return is submitted.
function submitTurn(shop: Shop, wanted: Wanted): ScriptedResponse[] {
  const fee = shop.policy.returnFeeCents;
  return [
    agent.submits(wanted, fee),
    agent.says(`已为您提交退货申请，并生成了寄回单。退货运费 ${yuan(fee)} 元。`),
  ];
}

function statesEverything(wanted: Wanted): string {
  return `我想退订单 ${wanted.order.id} 里的 ${wanted.quantity} 件${wanted.line.productName}，原因是${wanted.reason}。`;
}

// Every line of every order is asserted: the wanted one gains exactly the confirmed return (or
// nothing), all others keep what was seeded.
function expectedBusiness(shop: Shop, written?: Wanted): BusinessAssertion[] {
  return shop.orders.flatMap((order) =>
    order.lines.flatMap((line): BusinessAssertion[] => {
      const where = { kind: "aftersales" as const, orderId: order.id, lineId: line.id };
      const seeded = shop.aftersales.filter(
        (record) => record.orderId === order.id && record.lineId === line.id,
      ).length;
      if (written === undefined || written.order !== order || written.line !== line) {
        return [{ ...where, count: seeded }];
      }
      const record = {
        quantity: written.quantity,
        returnFeeCents: shop.policy.returnFeeCents,
        status: "in_progress" as const,
        returnShipment: true,
      };
      return seeded === 0
        ? [{ ...where, count: 1, ...record }]
        : [
            { ...where, count: seeded + 1 },
            { ...where, includeSeeded: false, count: 1, ...record },
          ];
    }),
  );
}

interface Conversation {
  description: string;
  shop: Shop;
  wanted: Wanted;
  // Whether the customer's return gets written.
  written: boolean;
  messages: string[];
  orderAnswer?: string | { choose: string };
  turns: ScriptedResponse[][];
}

function scenario(name: string, conversation: Conversation): ScenarioFile {
  const { shop, wanted } = conversation;
  return {
    name,
    description: conversation.description,
    seed: name,
    business: shop.business(),
    simulatedUser: {
      customerId: shop.customerId,
      messages: conversation.messages,
      // Everything this customer knows, whichever of it the agent asks for.
      answers: {
        orderId: conversation.orderAnswer ?? wanted.order.id,
        lineId: { choose: wanted.line.productName },
        quantity: `${wanted.quantity} 件`,
        reason: wanted.reason,
      },
      confirmations: [
        { tool: "submit_return", parameters: returnParameters(wanted, shop.policy.returnFeeCents) },
      ],
    },
    model: { turns: conversation.turns },
    expected: {
      outcome: "auto_completed",
      business: expectedBusiness(shop, conversation.written ? wanted : undefined),
    },
  };
}

// The customer names order, product, quantity and reason at once; the agent reads the order and
// the rules, asks to confirm, and submits.
function completeInfo(
  name: string,
  description: string,
  setUp: (shop: Shop) => Wanted,
  options: { asksProgress?: boolean } = {},
): ScenarioFile {
  const shop = new Shop(name);
  const wanted = setUp(shop);
  const turns = [
    [
      agent.looksUpOrder(wanted.order.id),
      agent.readsRules(wanted.order.id),
      agent.asksToConfirm(wanted, shop.policy.returnFeeCents),
    ],
    submitTurn(shop, wanted),
  ];
  const messages = [statesEverything(wanted)];
  if (options.asksProgress === true) {
    turns.push(progressTurn(wanted.order.id));
    messages.push(progressQuestion);
  }
  return scenario(name, { description, shop, wanted, written: true, messages, turns });
}

export const completeInfoTemplate: ScenarioTemplate = {
  name: "complete-info",
  variants: [
    {
      name: "one-line",
      build: (name) =>
        completeInfo(
          name,
          "信息完整：订单只有一个商品行，顾客一次说清订单、商品、数量和原因。",
          (shop) => anyQuantity(shop, shop.order([{}])),
        ),
    },
    {
      name: "several-lines",
      build: (name) =>
        completeInfo(
          name,
          "信息完整：订单有多个商品行，顾客另有订单，店里还有他人的订单；只退其中一行。",
          (shop) => {
            const order = shop.order(Array.from({ length: shop.draws.int(2, 3) }, () => ({})));
            shop.order([{}]);
            shop.someoneElsesOrder();
            return anyQuantity(
              shop,
              order,
              lineOf(order, shop.draws.int(0, order.lines.length - 1)),
            );
          },
        ),
    },
    {
      name: "whole-line",
      build: (name) =>
        completeInfo(name, "信息完整：顾客把一个商品行的全部数量都退掉。", (shop) => {
          const order = shop.order([{ quantity: shop.draws.int(2, 3) }, {}]);
          const line = lineOf(order);
          return { order, line, quantity: line.quantity, reason: shop.reason() };
        }),
    },
    {
      name: "asks-progress",
      build: (name) =>
        completeInfo(
          name,
          "信息完整：提交退货后，顾客在同一个任务里继续问进度。",
          (shop) =>
            anyQuantity(shop, shop.order(Array.from({ length: shop.draws.int(1, 2) }, () => ({})))),
          { asksProgress: true },
        ),
    },
  ],
};

type Missing = "reason" | "quantity" | "product";

// The customer leaves out some of product, quantity and reason; the agent reads the order, asks
// for each missing piece in its own turn, then confirms and submits.
function followUp(name: string, description: string, missing: readonly Missing[]): ScenarioFile {
  const shop = new Shop(name);
  const asksProduct = missing.includes("product");
  const asksQuantity = missing.includes("quantity");
  // "一件商品" fixes the quantity when the product is left out; a missing quantity needs a choice.
  const lineQuantity = asksProduct ? 1 : asksQuantity ? shop.draws.int(2, 3) : undefined;
  const lineCount = shop.draws.int(2, 3);
  const position = shop.draws.int(0, lineCount - 1);
  const order = shop.order(
    Array.from({ length: lineCount }, (_, k) => (k === position ? { quantity: lineQuantity } : {})),
  );
  const line = lineOf(order, position);
  const wanted = anyQuantity(shop, order, line);
  const because = missing.includes("reason") ? "" : `，原因是${wanted.reason}`;
  const howMany = asksQuantity ? "" : `${wanted.quantity} 件`;
  const opening = asksProduct
    ? `订单 ${order.id} 里有一件商品我想退${because}。`
    : `我想退订单 ${order.id} 里的${howMany}${line.productName}${because}。`;
  const questions: ScriptedResponse[] = [];
  if (asksProduct) {
    questions.push(
      agent.asks(
        "请问要退订单里的哪件商品？",
        "lineId",
        order.lines.map((orderLine) => orderLine.productName),
      ),
    );
  }
  if (asksQuantity) {
    questions.push(
      agent.asks(`请问要退几件${line.productName}？最多可退 ${line.quantity} 件。`, "quantity"),
    );
  }
  if (missing.includes("reason")) {
    questions.push(agent.asks("请问退货的原因是什么？", "reason"));
  }
  const [firstQuestion, ...laterQuestions] = questions;
  if (firstQuestion === undefined) {
    throw new Error(`${name} leaves nothing out`);
  }
  const turns = [
    [agent.looksUpOrder(order.id), firstQuestion],
    ...laterQuestions.map((question) => [question]),
    [agent.readsRules(order.id), agent.asksToConfirm(wanted, shop.policy.returnFeeCents)],
    submitTurn(shop, wanted),
  ];
  return scenario(name, { description, shop, wanted, written: true, messages: [opening], turns });
}

export const followUpTemplate: ScenarioTemplate = {
  name: "follow-up",
  variants: [
    {
      name: "reason",
      build: (name) => followUp(name, "需要追问：顾客没说退货原因。", ["reason"]),
    },
    {
      name: "quantity",
      build: (name) => followUp(name, "需要追问：商品买了多件，顾客没说退几件。", ["quantity"]),
    },
    {
      name: "product",
      build: (name) =>
        followUp(name, "需要追问：订单有多个商品，顾客没说退哪件，从选项中选择。", ["product"]),
    },
    {
      name: "quantity-and-reason",
      build: (name) =>
        followUp(name, "需要追问：顾客既没说数量也没说原因，Agent 分两轮追问。", [
          "quantity",
          "reason",
        ]),
    },
    {
      name: "product-and-reason",
      build: (name) =>
        followUp(name, "需要追问：顾客既没说退哪件商品也没说原因，Agent 分两轮追问。", [
          "product",
          "reason",
        ]),
    },
  ],
};

// The customer bought the product in several orders and does not say which; the agent lists
// the orders and offers the candidates, and the customer picks theirs from the options.
function candidateOrders(
  name: string,
  description: string,
  options: { candidates: number; otherOrders: number },
): ScenarioFile {
  const shop = new Shop(name);
  const productName = shop.product();
  const candidates = Array.from({ length: options.candidates }, () =>
    shop.order(shop.draws.int(0, 1) === 1 ? [{ productName }, {}] : [{ productName }]),
  );
  for (let k = 0; k < options.otherOrders; k++) {
    shop.order([{}]);
  }
  const wanted = anyQuantity(shop, shop.draws.pick(candidates));
  const { order } = wanted;
  const offered = candidates.map(
    (candidate) => `${candidate.id}（${productName} ${lineOf(candidate).quantity} 件）`,
  );
  const turns = [
    [
      { content: "我先查一下您的订单。", toolCalls: [{ name: "query_order", arguments: {} }] },
      agent.asks(
        `您有 ${candidates.length} 笔订单买过${productName}，请问要退哪一笔？`,
        "orderId",
        offered,
      ),
    ],
    [agent.readsRules(order.id), agent.asksToConfirm(wanted, shop.policy.returnFeeCents)],
    submitTurn(shop, wanted),
  ];
  return scenario(name, {
    description,
    shop,
    wanted,
    written: true,
    messages: [
      `我想退 ${wanted.quantity} 件${productName}，原因是${wanted.reason}。我买过不止一次，记不清是哪笔订单了。`,
    ],
    // A customer recognizes their order in the list; its order number stands in for that.
    orderAnswer: { choose: order.id },
    turns,
  });
}

export const candidateOrdersTemplate: ScenarioTemplate = {
  name: "candidate-orders",
  variants: [
    {
      name: "two-orders",
      build: (name) =>
        candidateOrders(name, "多个候选订单：顾客在两笔订单里都买过这件商品。", {
          candidates: 2,
          otherOrders: 0,
        }),
    },
    {
      name: "three-orders",
      build: (name) =>
        candidateOrders(name, "多个候选订单：顾客在三笔订单里都买过这件商品。", {
          candidates: 3,
          otherOrders: 0,
        }),
    },
    {
      name: "among-other-orders",
      build: (name) =>
        candidateOrders(
          name,
          "多个候选订单：顾客有两笔订单买过这件商品，另有不含它的订单，Agent 只列出候选订单。",
          { candidates: 2, otherOrders: 2 },
        ),
    },
  ],
};

// Where the agent learns that the return cannot be made: from the order, from the rules, or
// only from the business service refusing the confirmed write.
type Refusal = "order" | "rules" | "write";

// The customer states everything, as in complete-info, but the return is not allowed; the agent
// explains why and nothing is written.
function ineligible(
  name: string,
  description: string,
  refusal: Refusal,
  setUp: (shop: Shop) => { wanted: Wanted; explanation: string },
): ScenarioFile {
  const shop = new Shop(name);
  const { wanted, explanation } = setUp(shop);
  const orderId = wanted.order.id;
  const fee = shop.policy.returnFeeCents;
  const turns: Record<Refusal, ScriptedResponse[][]> = {
    order: [[agent.looksUpOrder(orderId), agent.says(explanation)]],
    rules: [[agent.looksUpOrder(orderId), agent.readsRules(orderId), agent.says(explanation)]],
    write: [
      [agent.looksUpOrder(orderId), agent.readsRules(orderId), agent.asksToConfirm(wanted, fee)],
      [agent.submits(wanted, fee), agent.says(explanation)],
    ],
  };
  return scenario(name, {
    description,
    shop,
    wanted,
    written: false,
    messages: [statesEverything(wanted)],
    turns: turns[refusal],
  });
}

// Eligible variants sit at the edge of a rule; ineligible ones break one.
export const eligibilityTemplate: ScenarioTemplate = {
  name: "eligibility",
  variants: [
    {
      name: "partly-returned",
      build: (name) =>
        completeInfo(
          name,
          "符合条件：这行商品此前已退过 1 件（已完成），剩余数量仍可退。",
          (shop) => {
            const order = shop.order([{ quantity: 3 }]);
            const line = lineOf(order);
            shop.seedAftersales(order, line, { quantity: 1, status: "completed" });
            return { order, line, quantity: shop.draws.int(1, 2), reason: shop.reason() };
          },
        ),
    },
    {
      name: "closed-application",
      build: (name) =>
        completeInfo(
          name,
          "符合条件：这行商品有一张已关闭的售后单，关闭的申请不占可退数量。",
          (shop) => {
            const order = shop.order([{}]);
            const line = lineOf(order);
            shop.seedAftersales(order, line, { quantity: line.quantity, status: "closed" });
            return anyQuantity(shop, order);
          },
        ),
    },
    {
      name: "last-day",
      build: (name) =>
        completeInfo(name, "符合条件：签收至今离售后期限只剩半天。", (shop) =>
          anyQuantity(
            shop,
            shop.order([{}], { deliveredDaysAgo: shop.policy.returnWindowDays - 0.5 }),
          ),
        ),
    },
    {
      name: "other-line-active",
      build: (name) =>
        completeInfo(
          name,
          "符合条件：同一订单的另一行商品有他人提交的进行中申请，不影响这一行。",
          (shop) => {
            const order = shop.order([{}, {}]);
            shop.seedAftersales(order, lineOf(order, 1), { quantity: 1, status: "in_progress" });
            return anyQuantity(shop, order);
          },
        ),
    },
    {
      name: "window-expired",
      build: (name) =>
        ineligible(
          name,
          "不符合条件：订单已超过售后期限，Agent 查规则后说明原因。",
          "rules",
          (shop) => {
            const window = shop.policy.returnWindowDays;
            const order = shop.order([{}], { deliveredDaysAgo: window + shop.draws.int(1, 10) });
            return {
              wanted: anyQuantity(shop, order),
              explanation: `抱歉，这笔订单已超过签收后 ${window} 天的售后期限，无法再办理退货。`,
            };
          },
        ),
    },
    {
      name: "refunded",
      build: (name) =>
        ineligible(name, "不符合条件：订单已经退款，Agent 查订单后说明原因。", "order", (shop) => {
          const order = shop.order([{}], { status: "refunded" });
          return {
            wanted: anyQuantity(shop, order),
            explanation: `订单 ${order.id} 已经退款，无法再办理退货。`,
          };
        }),
    },
    {
      name: "fully-returned",
      build: (name) =>
        ineligible(
          name,
          "不符合条件：这行商品已全部退过（售后单已完成），可退数量为 0，Agent 查订单后说明原因。",
          "order",
          (shop) => {
            const order = shop.order([{}]);
            const line = lineOf(order);
            shop.seedAftersales(order, line, { quantity: line.quantity, status: "completed" });
            return {
              wanted: anyQuantity(shop, order),
              explanation: `订单 ${order.id} 里的${line.productName}已经全部退过货了，没有可退的数量。`,
            };
          },
        ),
    },
    {
      name: "active-application",
      build: (name) =>
        ineligible(
          name,
          "不符合条件：这行商品已有他人提交的进行中申请；查询结果仍有可退数量，顾客确认后业务服务在写入时拒绝，Agent 说明原因。",
          "write",
          (shop) => {
            const order = shop.order([{ quantity: shop.draws.int(2, 3) }]);
            const line = lineOf(order);
            shop.seedAftersales(order, line, { quantity: 1, status: "in_progress" });
            return {
              wanted: { order, line, quantity: 1, reason: shop.reason() },
              explanation: `抱歉，${line.productName}已有一张处理中的售后申请，需要等它办结后才能再申请退货。`,
            };
          },
        ),
    },
  ],
};

export const scenarioTemplates: readonly ScenarioTemplate[] = [
  completeInfoTemplate,
  followUpTemplate,
  candidateOrdersTemplate,
  eligibilityTemplate,
];
