CREATE TABLE "steps" (
	"task_id" uuid,
	"seq" integer,
	"turn" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer NOT NULL,
	"input_hash" text NOT NULL,
	"input" jsonb,
	"output" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "steps_pkey" PRIMARY KEY("task_id","seq")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"customer_id" text NOT NULL,
	"state" text NOT NULL,
	"turn" integer DEFAULT 0 NOT NULL,
	"owner" text,
	"lease_until" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_lease_iff_running" CHECK (("state" = 'RUNNING') = ("owner" IS NOT NULL AND "lease_until" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "user_visible_messages" (
	"task_id" uuid,
	"turn" integer,
	"seq" integer,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_visible_messages_pkey" PRIMARY KEY("task_id","turn","seq")
);
--> statement-breakpoint
CREATE INDEX "tasks_ready_queue" ON "tasks" ("updated_at","id") WHERE "state" = 'READY';--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "steps_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id");--> statement-breakpoint
ALTER TABLE "user_visible_messages" ADD CONSTRAINT "user_visible_messages_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id");