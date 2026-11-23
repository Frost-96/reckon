CREATE TABLE "confirmations" (
	"task_id" uuid,
	"seq" integer,
	"tool" text NOT NULL,
	"parameters" jsonb NOT NULL,
	"parameters_hash" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "confirmations_pkey" PRIMARY KEY("task_id","seq")
);
--> statement-breakpoint
CREATE TABLE "write_intents" (
	"operation_id" text PRIMARY KEY,
	"task_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"operation" text NOT NULL,
	"state" text NOT NULL,
	"parameters" jsonb NOT NULL,
	"deadline" timestamp with time zone,
	"result" jsonb,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_visible_messages" ADD COLUMN "payload" jsonb;--> statement-breakpoint
CREATE INDEX "write_intents_by_task" ON "write_intents" ("task_id","created_at");--> statement-breakpoint
ALTER TABLE "confirmations" ADD CONSTRAINT "confirmations_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id");--> statement-breakpoint
ALTER TABLE "write_intents" ADD CONSTRAINT "write_intents_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id");