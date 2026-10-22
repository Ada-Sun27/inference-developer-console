import { GraphQLError } from "graphql";

/**
 * Resolve the tenant for a console request.
 *
 * Dev-only: reads DEV_TENANT_ID. In production this would come from an authenticated
 * session (e.g. a signed cookie verified here). The tenant is never taken from a
 * request header or GraphQL argument, so a client cannot ask for another tenant's data.
 */
export function resolveTenantId(_request: Request): string {
  const tenantId = process.env.DEV_TENANT_ID;
  if (!tenantId) {
    throw new GraphQLError("Not signed in. Set DEV_TENANT_ID for local development.", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }
  return tenantId;
}
