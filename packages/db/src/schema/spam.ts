import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { json, stamp, ts } from "./columns";
import { messages } from "./mail";

/** Naive Bayes token counts, trained online from spam / not-spam actions. */
export const spamTokens = sqliteTable("spam_tokens", {
  token: text("token").primaryKey(),
  spamCount: integer("spam_count").notNull().default(0),
  hamCount: integer("ham_count").notNull().default(0),
  updatedAt: stamp("updated_at"),
});

/**
 * What each message was trained as, so changing your mind unlearns exactly the
 * counts that were added.
 */
export const spamTraining = sqliteTable("spam_training", {
  messageId: text("message_id")
    .primaryKey()
    .references(() => messages.id, { onDelete: "cascade" }),
  label: text("label", { enum: ["spam", "ham"] }).notNull(),
  trainedAt: stamp("trained_at"),
});

/** Body fingerprints (TLSH / simhash) of mail the owner marked spam. */
export const spamFingerprints = sqliteTable(
  "spam_fingerprints",
  {
    id: text("id").primaryKey(),
    algorithm: text("algorithm", { enum: ["tlsh", "simhash"] }).notNull(),
    hash: text("hash").notNull(),
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    createdAt: stamp("created_at"),
  },
  (t) => [index("spam_fingerprints_hash_idx").on(t.algorithm, t.hash)],
);

/** The owner's history with each sender, one input to the score combiner. */
export const senderReputation = sqliteTable(
  "sender_reputation",
  {
    /** Stored lowercased. */
    email: text("email").primaryKey(),
    domain: text("domain").notNull(),
    inboundCount: integer("inbound_count").notNull().default(0),
    /** Times the owner wrote to them; any > 0 is the "someone you've written to" hard rule. */
    outboundCount: integer("outbound_count").notNull().default(0),
    spamCount: integer("spam_count").notNull().default(0),
    hamCount: integer("ham_count").notNull().default(0),
    firstSeenAt: stamp("first_seen_at"),
    lastSeenAt: stamp("last_seen_at"),
  },
  (t) => [index("sender_reputation_domain_idx").on(t.domain)],
);

/**
 * Small learned state by name: "bayes" holds document totals, "combiner" the
 * logistic-regression weights (AI-on and AI-off sets) refit nightly.
 */
export const spamModels = sqliteTable(
  "spam_models",
  {
    name: text("name").notNull(),
    variant: text("variant").notNull().default("default"),
    params: json<Record<string, unknown>>("params").notNull().default({}),
    sampleCount: integer("sample_count").notNull().default(0),
    fittedAt: ts("fitted_at"),
    updatedAt: stamp("updated_at"),
  },
  (t) => [primaryKey({ columns: [t.name, t.variant] })],
);
