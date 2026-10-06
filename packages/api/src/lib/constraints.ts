// Database constraints the routes translate into an HTTP answer. Without this
// a violation surfaces as an unhandled error, and the server has no
// setErrorHandler, so the 500 body carries the SQL statement and its params —
// DrizzleQueryError holds both as own properties.
export const ONE_ORCHESTRATOR_PER_REPO = "agents_one_orchestrator_per_repo";

type PgLike = { code?: string; constraint_name?: string; constraint?: string; cause?: unknown };

// Drizzle wraps driver errors: the PostgresError carrying `code` and
// `constraint_name` sits on `.cause`, so a check on the thrown object alone
// silently never matches and every violation becomes a 500.
export function isConstraintViolation(err: unknown, constraint: string): boolean {
  for (let e = err, depth = 0; e && typeof e === "object" && depth < 5; depth++) {
    const pg = e as PgLike;
    if (pg.code === "23505" && (pg.constraint_name === constraint || pg.constraint === constraint)) {
      return true;
    }
    e = pg.cause;
  }
  return false;
}
