import { pgTable, text, serial, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const sessionsTable = pgTable("sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  model: text("model").notNull().default("qwen3-coder-next"),
  workspacePath: text("workspace_path").notNull(),
  messageCount: integer("message_count").notNull().default(0),
  // GitHub link: "owner/name" once the user creates/links a repo for this
  // session; autopush pushes after each turn's checkpoint when enabled.
  githubRepo: text("github_repo"),
  githubAutopush: boolean("github_autopush").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertSessionSchema = createInsertSchema(sessionsTable).omit({
  id: true,
  messageCount: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessionsTable.$inferSelect;
