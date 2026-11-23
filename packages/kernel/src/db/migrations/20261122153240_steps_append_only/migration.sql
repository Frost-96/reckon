-- The step log is append-only: recovery rebuilds progress from it, so a logged step never changes.
CREATE FUNCTION "steps_refuse_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'steps is append-only: % refused', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "steps_append_only" BEFORE UPDATE OR DELETE ON "steps"
	FOR EACH ROW EXECUTE FUNCTION "steps_refuse_change"();
