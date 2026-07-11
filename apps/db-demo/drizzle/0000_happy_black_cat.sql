CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"author" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
