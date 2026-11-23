CREATE TABLE "lease_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "lease_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"task_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"owner" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lease_events_once_per_lease" UNIQUE("task_id","version","kind")
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "needs_recovery" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lease_events" ADD CONSTRAINT "lease_events_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id");