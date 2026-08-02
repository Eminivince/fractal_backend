import type { PostgresMigration } from "./types.js";

/**
 * Do not present settings as operational before their consumers persist an
 * exact version binding. These definitions remain in the governed catalogue
 * for future activation work, but only the public catalogue default currently
 * has a complete consumer path.
 */
export const retireUnboundConfigurationDefinitionsMigration: PostgresMigration = {
  version: "069-retire-unbound-configuration-definitions",
  sql: `
    UPDATE fractal.platform_configuration_definitions
       SET status = 'retired'
     WHERE configuration_key IN (
       'auth.session.absolute_lifetime_minutes',
       'support.case.default_priority'
     );
  `,
};
