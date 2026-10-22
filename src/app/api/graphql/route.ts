import { createSchema, createYoga } from "graphql-yoga";
import { resolvers, type Context } from "../../../graphql/resolvers";
import { typeDefs } from "../../../graphql/typeDefs";
import { pool } from "../../../lib/db";
import { redis } from "../../../lib/redis";
import { resolveTenantId } from "../../../server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const { handleRequest } = createYoga<object, Context>({
  schema: createSchema({ typeDefs, resolvers }),
  graphqlEndpoint: "/api/graphql",
  fetchAPI: { Response },
  context: ({ request }) => ({ tenantId: resolveTenantId(request), pool, redis }),
});

export { handleRequest as GET, handleRequest as POST };
