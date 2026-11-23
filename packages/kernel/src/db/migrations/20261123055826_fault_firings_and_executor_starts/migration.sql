CREATE TABLE "executor_starts" (
	"owner" text PRIMARY KEY,
	"host" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fault_firings" (
	"run_id" uuid,
	"fault_point" text,
	"task_id" uuid NOT NULL,
	"owner" text NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fault_firings_pkey" PRIMARY KEY("run_id","fault_point")
);
--> statement-breakpoint
ALTER TABLE "fault_firings" ADD CONSTRAINT "fault_firings_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id");--> statement-breakpoint
ALTER TABLE "fault_firings" ADD CONSTRAINT "fault_firings_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id");