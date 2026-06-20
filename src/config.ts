function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export const config = {
  convexUrl: required("CONVEX_URL"),
  clientSecret: required("MCP_CLIENT_SECRET"),
  // The geocoding tools (find_address / resolve_address / reverse_geocode) run
  // as Convex actions that read GOOGLE_API_KEY from the CONVEX deployment, not
  // from this process. We still require it here so a container can't be started
  // without the key configured — it MUST also be set in Convex
  // (`npx convex env set GOOGLE_API_KEY ...`) for those tools to work.
  googleApiKey: required("GOOGLE_API_KEY"),
  port: Number(process.env.PORT ?? 3000),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};
