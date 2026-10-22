export const typeDefs = /* GraphQL */ `
  "Timestamps are ISO-8601 strings in UTC."
  type Query {
    models: [String!]!
    projects: [Project!]!
    requests(filter: RequestFilter, first: Int = 25, after: String): RequestConnection!
    usageSummary(range: TimeRange!, projectId: ID, model: String): UsageSummary!
    usageSeries(range: TimeRange!, interval: Interval!, projectId: ID, model: String): [UsagePoint!]!
  }

  type Mutation {
    createProject(name: String!): Project!
    "Returns the secret once. Only a hash is stored."
    createApiKey(projectId: ID!, name: String!): CreatedApiKey!
    revokeApiKey(id: ID!): ApiKey!
  }

  type Project {
    id: ID!
    name: String!
    createdAt: String!
    apiKeys: [ApiKey!]!
  }

  type ApiKey {
    id: ID!
    projectId: ID!
    name: String!
    prefix: String!
    createdAt: String!
    lastUsedAt: String
    revokedAt: String
  }

  type CreatedApiKey {
    apiKey: ApiKey!
    secret: String!
  }

  enum RequestStatus {
    SUCCESS
    ERROR
  }

  enum Interval {
    MINUTE
    HOUR
    DAY
  }

  input TimeRange {
    from: String!
    to: String!
  }

  input RequestFilter {
    projectId: ID
    model: String
    status: RequestStatus
    from: String
    to: String
  }

  type InferenceRequest {
    id: ID!
    requestId: String!
    projectId: ID!
    model: String!
    status: RequestStatus!
    errorCode: String
    inputTokens: Int!
    outputTokens: Int!
    estimatedCostUsd: Float!
    latencyMs: Int!
    startedAt: String!
    receivedAt: String!
  }

  type RequestEdge {
    cursor: String!
    node: InferenceRequest!
  }

  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }

  type RequestConnection {
    edges: [RequestEdge!]!
    pageInfo: PageInfo!
  }

  "Token counts are Float because tenant totals can exceed GraphQL's 32-bit Int."
  type UsageSummary {
    requestCount: Float!
    errorCount: Float!
    errorRate: Float!
    inputTokens: Float!
    outputTokens: Float!
    estimatedCostUsd: Float!
    avgLatencyMs: Float
    p95LatencyMs: Float
  }

  type UsagePoint {
    t: String!
    requestCount: Float!
    errorCount: Float!
    tokens: Float!
    estimatedCostUsd: Float!
    avgLatencyMs: Float
  }
`;
