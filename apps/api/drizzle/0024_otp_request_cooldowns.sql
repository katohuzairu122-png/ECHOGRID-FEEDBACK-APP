CREATE TABLE "otp_request_cooldowns" (
	"phone" text PRIMARY KEY NOT NULL,
	"requested_at" timestamp with time zone NOT NULL
);

