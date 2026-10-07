// Database constraints the routes translate into an HTTP answer. Without this
// a violation surfaces as the server's generic 500 ("Internal Server Error",
// server.ts's setErrorHandler already keeps the real SQL/params out of that
// body) — accurate, but useless to a caller who needs to know this project
// already has an orchestrator, not just that something broke.
export const ONE_ORCHESTRATOR_PER_REPO = "agents_one_orchestrator_per_repo";
export const ONE_GOD_AGENT_PER_OWNER = "owner_god_agents_owner_id_unique";

type PgLike = { code?: string; constraint_name?: string; constraint?: string; cause?: unknown };

// Drizzle wraps driver errors exactly one level deep: the PostgresError
// carrying `code` and `constraint_name` sits on `.cause`, so a check on the
// thrown object alone silently never matches and every violation becomes a
// 500. The loop still walks rather than checking `err`/`err.cause` directly,
// in case a future Drizzle version adds another layer.
export function isConstraintViolation(err: unknown, constraint: string): boolean {
  for (let e = err, depth = 0; e && typeof e === "object" && depth < 2; depth++) {
    const pg = e as PgLike;
    if (pg.code === "23505" && (pg.constraint_name === constraint || pg.constraint === constraint)) {
      return true;
    }
    e = pg.cause;
  }
  return false;
}
