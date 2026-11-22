CREATE TABLE "aftersales_orders" (
	"id" text PRIMARY KEY,
	"order_id" text NOT NULL,
	"line_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"return_fee_cents" integer NOT NULL,
	"client_ref" text,
	"deadline" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aftersales_orders_quantity_positive" CHECK ("quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "aftersales_policy" (
	"id" integer PRIMARY KEY DEFAULT 1,
	"return_window_days" integer NOT NULL,
	"return_fee_cents" integer NOT NULL,
	CONSTRAINT "aftersales_policy_single_row" CHECK ("id" = 1),
	CONSTRAINT "aftersales_policy_window_non_negative" CHECK ("return_window_days" >= 0),
	CONSTRAINT "aftersales_policy_fee_non_negative" CHECK ("return_fee_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"endpoint" text,
	"key" text,
	"request_hash" text NOT NULL,
	"status_code" integer NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY("endpoint","key")
);
--> statement-breakpoint
CREATE TABLE "mock_config" (
	"id" integer PRIMARY KEY DEFAULT 1,
	"scenario_seed" text NOT NULL,
	"idempotency_mode" text NOT NULL,
	"check_fee" boolean NOT NULL,
	"processing_delay_ms" integer NOT NULL,
	CONSTRAINT "mock_config_single_row" CHECK ("id" = 1),
	CONSTRAINT "mock_config_processing_delay_non_negative" CHECK ("processing_delay_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"order_id" text,
	"id" text,
	"product_name" text NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "order_lines_pkey" PRIMARY KEY("order_id","id"),
	CONSTRAINT "order_lines_quantity_positive" CHECK ("quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY,
	"customer_id" text NOT NULL,
	"status" text NOT NULL,
	"delivered_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "return_shipments" (
	"id" text PRIMARY KEY,
	"aftersales_id" text NOT NULL UNIQUE,
	"client_ref" text NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "aftersales_orders_one_in_progress_per_line" ON "aftersales_orders" ("order_id","line_id") WHERE "status" = 'in_progress';--> statement-breakpoint
ALTER TABLE "aftersales_orders" ADD CONSTRAINT "aftersales_orders_order_id_line_id_order_lines_order_id_id_fkey" FOREIGN KEY ("order_id","line_id") REFERENCES "order_lines"("order_id","id");--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id");--> statement-breakpoint
ALTER TABLE "return_shipments" ADD CONSTRAINT "return_shipments_aftersales_id_aftersales_orders_id_fkey" FOREIGN KEY ("aftersales_id") REFERENCES "aftersales_orders"("id");