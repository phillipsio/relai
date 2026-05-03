import chalk from "chalk";
import ora from "ora";
import { confirm } from "@inquirer/prompts";
import { requireConfig, writeConfig, configPath } from "../config.js";
import { CliApiClient } from "../api.js";

export async function tokenRotateCommand() {
  const config = requireConfig();
  const client = new CliApiClient(config);

  const s = ora("Issuing new token…").start();
  try {
    const { token, tokenId } = await client.rotateToken(config.agentId);
    s.succeed(chalk.green("New token issued"));

    writeConfig({ ...config, apiToken: token });

    console.log(`
${chalk.bold("Saved")} ${chalk.dim(configPath())}
${chalk.dim("token id:")} ${tokenId}

${chalk.yellow("Note:")} the previous token is still valid until you revoke it.
Update any other clients (MCP config, workers) that used the old token, then run:
  ${chalk.cyan("relai token revoke <old-token-id>")}
`);
  } catch (err) {
    s.fail(chalk.red("Rotate failed"));
    console.error(chalk.dim(String(err)));
    process.exit(1);
  }
}

export async function tokenRevokeCommand(tokenId: string) {
  const config = requireConfig();
  const client = new CliApiClient(config);

  const ok = await confirm({
    message: `Revoke token ${tokenId}? This cannot be undone.`,
    default: false,
  });
  if (!ok) return;

  const s = ora("Revoking…").start();
  try {
    await client.revokeToken(tokenId);
    s.succeed(chalk.green(`Revoked ${tokenId}`));
  } catch (err) {
    s.fail(chalk.red("Revoke failed"));
    console.error(chalk.dim(String(err)));
    process.exit(1);
  }
}
