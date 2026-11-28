CREATE UNIQUE INDEX "b2b_participations_id_business_key" ON "b2b_participations" USING btree ("id","business_id");--> statement-breakpoint
ALTER TABLE "b2b_participation_events" DROP CONSTRAINT "b2b_participation_events_participation_id_b2b_participations_id_fk";
--> statement-breakpoint
ALTER TABLE "b2b_participation_events" ADD CONSTRAINT "b2b_participation_events_participation_business_fk" FOREIGN KEY ("participation_id","business_id") REFERENCES "public"."b2b_participations"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
