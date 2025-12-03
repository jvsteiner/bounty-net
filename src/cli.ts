#!/usr/bin/env node

// Set default log level for CLI (can be overridden by LOG_LEVEL env var)
// Daemon and serve commands will override this to show logs
if (!process.env.LOG_LEVEL) {
  process.env.LOG_LEVEL = "silent";
}

import { Command } from "commander";
import { runDaemon } from "./daemon/index.js";
import { runServer } from "./server/index.js";
import {
  initCommand,
  initRepoCommand,
  identityCommands,
  daemonCommands,
  walletCommands,
  reportsCommands,
  repoCommands,
} from "./cli/commands/index.js";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : "0.0.0-dev";

const program = new Command();

program
  .name("bounty-net")
  .description("Decentralized bug reporting network for AI agents")
  .version(VERSION);

// bounty-net init
program
  .command("init")
  .description("Initialize Bounty-Net configuration")
  .action(initCommand);

// bounty-net init-repo
program
  .command("init-repo")
  .description("Initialize .bounty-net.yaml file in current repository")
  .option("-i, --identity <name>", "Use nametag from this identity")
  .option("-n, --nametag <nametag>", "Maintainer nametag (e.g., myproject@unicity)")
  .option("-r, --repo <url>", "Canonical repository URL (auto-detected from git if not specified)")
  .option("-d, --deposit <amount>", "Required deposit amount in ALPHA tokens (default: 100)", parseInt)
  .action(initRepoCommand);

// bounty-net identity <subcommand>
const identity = program.command("identity").description("Manage identities");

identity
  .command("create <name>")
  .description("Generate a new identity keypair")
  .action(identityCommands.create);

identity
  .command("list")
  .description("List configured identities")
  .action(identityCommands.list);

identity
  .command("register <name>")
  .option("--nametag <tag>", "Nametag to register")
  .description("Register identity nametag on NOSTR network")
  .action(identityCommands.register);

identity
  .command("resolve <nametag>")
  .description("Resolve a nametag to its public key")
  .action(identityCommands.resolve);

// bounty-net daemon <subcommand>
const daemon = program
  .command("daemon")
  .description("Manage background daemon");

daemon
  .command("start")
  .description("Start daemon in background")
  .action(daemonCommands.start);

daemon
  .command("stop")
  .description("Stop running daemon")
  .action(daemonCommands.stop);

daemon
  .command("status")
  .description("Check daemon status")
  .action(daemonCommands.status);

daemon
  .command("run")
  .description("Run daemon in foreground (for debugging)")
  .action(runDaemon);

daemon
  .command("logs")
  .option("-f, --follow", "Follow log output")
  .option("-n, --lines <n>", "Number of lines to show", "50")
  .description("View daemon logs")
  .action(daemonCommands.logs);

// bounty-net wallet <subcommand>
const wallet = program.command("wallet").description("Wallet operations");

wallet
  .command("balance [identity]")
  .description("Check token balance")
  .action(walletCommands.balance);

wallet
  .command("address [identity]")
  .description("Show deposit address")
  .action(walletCommands.address);

wallet
  .command("mint [identity] [amount]")
  .description("Mint test ALPHA tokens")
  .action(walletCommands.mint);

// bounty-net reports <subcommand>
const reports = program.command("reports").description("Manage bug reports");

reports
  .command("list")
  .option("-s, --status <status>", "Filter by status (pending, acknowledged, accepted, rejected)")
  .option("-d, --direction <dir>", "Filter by direction (sent, received)")
  .option("--repo <url>", "Filter by repository URL")
  .option("-n, --limit <n>", "Maximum number of results", "50")
  .description("List bug reports")
  .action(reportsCommands.list);

reports
  .command("show <id>")
  .description("Show details of a bug report")
  .action(reportsCommands.show);

// bounty-net lookup-maintainer
program
  .command("lookup-maintainer [repo-url]")
  .description("Look up maintainer for a repository (reads local .bounty-net.yaml if no URL provided)")
  .action(repoCommands.lookupMaintainer);

// bounty-net serve (MCP server - called by IDE)
program
  .command("serve")
  .description("Run MCP server (called by IDE)")
  .action(runServer);

program.parse();
