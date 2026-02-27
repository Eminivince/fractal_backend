import mongoose, { type Schema, type CallbackError } from "mongoose";

/**
 * Reference descriptor used by `preventDeletionIfReferenced`.
 *
 * @property model       - Mongoose model name of the referencing collection (e.g. "Application").
 * @property foreignKey  - Field on the referencing model that points back to the current doc.
 * @property excludeStatuses - Statuses that are considered "safe" and will NOT block deletion.
 *                             For example, withdrawn applications should not prevent deleting a Business.
 * @property statusField - The field that holds the status value (defaults to "status").
 */
export interface ReferenceDescriptor {
  model: string;
  foreignKey: string;
  excludeStatuses: string[];
  statusField?: string;
}

/**
 * Creates a Mongoose pre-hook ("deleteOne" / "findOneAndDelete") that prevents
 * hard-deletion of a document when active references exist in other collections.
 *
 * Usage:
 * ```ts
 * import { preventDeletionIfReferenced } from "../plugins/cascade.js";
 *
 * businessSchema.plugin(
 *   preventDeletionIfReferenced("Business", [
 *     { model: "Application", foreignKey: "businessId", excludeStatuses: ["withdrawn"] },
 *   ]),
 * );
 * ```
 *
 * Orphan detection (references to models that don't exist yet) is logged as a
 * warning rather than throwing, so the system stays resilient during migrations.
 */
export function preventDeletionIfReferenced(
  modelName: string,
  references: ReferenceDescriptor[],
) {
  return function plugin(schema: Schema): void {
    const hookMethods = ["deleteOne", "findOneAndDelete"] as const;

    for (const method of hookMethods) {
      schema.pre(method, async function (this: any, next: (err?: CallbackError) => void) {
        try {
          const filter = this.getFilter?.() ?? this.getQuery?.();
          if (!filter?._id) {
            // Without an _id we can't look up references; skip check.
            return next();
          }

          const docId = filter._id;

          for (const ref of references) {
            let RefModel: mongoose.Model<any>;
            try {
              RefModel = mongoose.model(ref.model);
            } catch {
              // Model not registered yet — log and continue.
              console.warn(
                `[cascade] Orphan check skipped: model "${ref.model}" is not registered. ` +
                  `Referenced from ${modelName} deletion guard.`,
              );
              continue;
            }

            const statusField = ref.statusField ?? "status";

            const query: Record<string, unknown> = {
              [ref.foreignKey]: docId,
            };

            // Exclude documents whose status is in the safe list.
            if (ref.excludeStatuses.length > 0) {
              query[statusField] = { $nin: ref.excludeStatuses };
            }

            const count = await RefModel.countDocuments(query);

            if (count > 0) {
              return next(
                new Error(
                  `Cannot delete ${modelName} (${docId}): ` +
                    `${count} active ${ref.model} record(s) still reference it.`,
                ),
              );
            }
          }

          next();
        } catch (err) {
          // Unexpected error — log but do not silently swallow.
          console.error(`[cascade] Error in deletion guard for ${modelName}:`, err);
          next(err as CallbackError);
        }
      });
    }
  };
}

// ── Pre-built guard factories for common domain models ───────────────

/**
 * Prevent deletion of a Business if it has non-withdrawn Applications.
 */
export function guardBusiness(): ReturnType<typeof preventDeletionIfReferenced> {
  return preventDeletionIfReferenced("Business", [
    {
      model: "Application",
      foreignKey: "businessId",
      excludeStatuses: ["withdrawn"],
    },
  ]);
}

/**
 * Prevent deletion of an Offering if it has non-refunded Subscriptions.
 */
export function guardOffering(): ReturnType<typeof preventDeletionIfReferenced> {
  return preventDeletionIfReferenced("Offering", [
    {
      model: "Subscription",
      foreignKey: "offeringId",
      excludeStatuses: ["refunded", "cancelled"],
    },
  ]);
}
