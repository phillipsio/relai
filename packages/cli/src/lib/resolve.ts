import chalk from "chalk";
import type { CliApiClient } from "../api.js";

/**
 * Resolve a user-supplied agent reference (id or name) to an agent ID.
 * Pass-through for `agent_*` ids; case-insensitive name match otherwise.
 * Exits the process on ambiguous or unknown names.
 */
export async function resolveAgentRef(
  client: CliApiClient,
  projectId: string,
  ref: string,
): Promise<string> {
  if (ref === "@auto" || ref.startsWith("agent_")) return ref;

  const agents = await client.getAgents(projectId);
  const needle = ref.toLowerCase();
  const matches = agents.filter((a) => a.name.toLowerCase() === needle);

  if (matches.length === 1) return matches[0].id;

  if (matches.length === 0) {
    console.error(chalk.red(`No agent named "${ref}" in this project.`));
    const names = agents.map((a) => a.name).join(", ");
    if (names) console.error(chalk.dim(`Available: ${names}`));
    process.exit(1);
  }

  console.error(chalk.red(`Multiple agents named "${ref}". Use the agent id instead:`));
  for (const a of matches) console.error(chalk.dim(`  ${a.id}  ${a.name}`));
  process.exit(1);
}
