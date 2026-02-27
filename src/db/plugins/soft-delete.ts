import type { Schema, Model, Document, CallbackError } from "mongoose";

/**
 * Mongoose plugin that adds soft-delete capability to a schema.
 *
 * Adds a `deletedAt` field and overrides common query methods so that
 * soft-deleted documents are excluded by default.
 *
 * Instance methods: `softDelete()`, `restore()`
 * Static methods:   `findDeleted()`, `findWithDeleted()`
 */

export interface SoftDeleteDocument extends Document {
  deletedAt: Date | null;
  softDelete(): Promise<this>;
  restore(): Promise<this>;
}

export interface SoftDeleteModel<T extends SoftDeleteDocument> extends Model<T> {
  findDeleted(filter?: Record<string, unknown>): ReturnType<Model<T>["find"]>;
  findWithDeleted(filter?: Record<string, unknown>): ReturnType<Model<T>["find"]>;
}

function softDeletePlugin(schema: Schema): void {
  // ── Field ──────────────────────────────────────────────────────────
  schema.add({
    deletedAt: { type: Date, default: null },
  });

  schema.index({ deletedAt: 1 });

  // ── Query middleware ───────────────────────────────────────────────
  // Automatically exclude soft-deleted docs unless the caller has
  // explicitly set a `deletedAt` condition.
  const queryMethods = [
    "find",
    "findOne",
    "countDocuments",
    "findOneAndUpdate",
  ] as const;

  for (const method of queryMethods) {
    schema.pre(method, function (this: any, next: (err?: CallbackError) => void) {
      const filter = this.getFilter();

      // Only add the exclusion when the caller did not set their own
      // `deletedAt` filter — this lets `findDeleted` / `findWithDeleted`
      // work without interference.
      if (filter.deletedAt === undefined) {
        this.where({ deletedAt: null });
      }

      next();
    });
  }

  // ── Instance methods ───────────────────────────────────────────────
  schema.method("softDelete", async function (this: SoftDeleteDocument) {
    this.deletedAt = new Date();
    return this.save();
  });

  schema.method("restore", async function (this: SoftDeleteDocument) {
    this.deletedAt = null;
    return this.save();
  });

  // ── Static methods ─────────────────────────────────────────────────
  schema.static(
    "findDeleted",
    function (this: Model<any>, filter: Record<string, unknown> = {}) {
      return this.find({ ...filter, deletedAt: { $ne: null } });
    },
  );

  schema.static(
    "findWithDeleted",
    function (this: Model<any>, filter: Record<string, unknown> = {}) {
      return this.find({ ...filter, deletedAt: { $exists: true } });
    },
  );
}

export default softDeletePlugin;
