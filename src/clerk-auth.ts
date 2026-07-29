/**
 * OAuth caller auth via Clerk, sitting alongside the original shared secret.
 *
 * Two kinds of caller, two mechanisms:
 *   - n8n and the WhatsApp bot send `Bearer <MCP_CLIENT_SECRET>`. They are
 *     headless and cannot complete an interactive consent flow, so the static
 *     secret stays.
 *   - Claude Desktop and other MCP clients run the OAuth flow against Clerk,
 *     which is already the identity provider for the rest of BoxConv. This
 *     gives per-operator logins that can be revoked individually.
 *
 * Clerk is optional: with the CLERK_* vars unset, `oauthEnabled` is false and
 * the server behaves exactly as it did before.
 */

import type { IncomingMessage } from "node:http";
import { createClerkClient } from "@clerk/backend";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  fetchClerkAuthorizationServerMetadata,
  generateClerkProtectedResourceMetadata,
  verifyClerkToken,
} from "@clerk/mcp-tools/server";
import { config } from "./config";

const PRM_PREFIX = "/.well-known/oauth-protected-resource";
const AS_METADATA_PATH = "/.well-known/oauth-authorization-server";

const clerk =
  config.clerkSecretKey && config.clerkPublishableKey
    ? createClerkClient({
        secretKey: config.clerkSecretKey,
        publishableKey: config.clerkPublishableKey,
      })
    : undefined;

export const oauthEnabled = clerk !== undefined;

/**
 * `authenticateRequest` wants a Fetch `Request`. Token verification only reads
 * the method, URL and headers, so the body is deliberately left off.
 */
function toFetchRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? "localhost";
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers.set(key, value);
    }
  }
  return new Request(`https://${host}${req.url ?? "/"}`, {
    method: "GET",
    headers,
  });
}

/**
 * Verify a Clerk-issued OAuth access token. Returns the MCP SDK's AuthInfo on
 * success, or undefined for anything unverifiable.
 *
 * ponytail: any authenticated Clerk OAuth token gets full tool access, exactly
 * like the shared secret does. Gate on `authInfo.scopes` here if operators ever
 * need to differ from each other.
 */
export async function verifyOAuthToken(
  req: IncomingMessage,
  token: string
): Promise<AuthInfo | undefined> {
  if (!clerk) {
    return undefined;
  }
  try {
    const state = await clerk.authenticateRequest(toFetchRequest(req), {
      acceptsToken: "oauth_token",
    });
    const auth = state.toAuth();
    if (!auth?.isAuthenticated) {
      return undefined;
    }
    return verifyClerkToken(auth, token);
  } catch (err) {
    console.error("Clerk OAuth verification failed:", String(err));
    return undefined;
  }
}

/** The `resource_metadata` URL a 401 should point an MCP client at. */
export function protectedResourceUrl(
  req: IncomingMessage,
  resourcePath: string
): string {
  const host = req.headers.host ?? "localhost";
  return `https://${host}${PRM_PREFIX}${resourcePath}`;
}

export function isOAuthMetadataPath(pathname: string): boolean {
  return pathname.startsWith(PRM_PREFIX) || pathname === AS_METADATA_PATH;
}

/**
 * RFC 9728 protected-resource metadata, plus the authorization-server metadata
 * that pre-2025-06-18 MCP clients look for instead.
 */
export async function oauthMetadata(
  req: IncomingMessage,
  pathname: string
): Promise<unknown> {
  const publishableKey = config.clerkPublishableKey;
  if (!publishableKey) {
    return undefined;
  }

  if (pathname === AS_METADATA_PATH) {
    return await fetchClerkAuthorizationServerMetadata({ publishableKey });
  }

  // Clients append the resource path, e.g. /.well-known/…-resource/mcp
  const resourcePath = pathname.slice(PRM_PREFIX.length) || "/mcp";
  return generateClerkProtectedResourceMetadata({
    publishableKey,
    resourceUrl: `https://${req.headers.host ?? "localhost"}${resourcePath}`,
  });
}
