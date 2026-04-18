import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { config } from "./config";

// Single shared client. Convex HTTP is stateless and auth-free here — the MCP
// server only invokes guest-scoped queries/mutations that do not require a
// Clerk identity.
export const convex = new ConvexHttpClient(config.convexUrl);

// Re-export anyApi so tool files can reference `api.typesense.searchProducts`
// without needing the Convex _generated types in this repo.
export const api = anyApi;
