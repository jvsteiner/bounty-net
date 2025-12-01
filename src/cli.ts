#!/usr/bin/env node
import { Command } from "commander";
import { runDaemon } from "./daemon/index.js";
import { runServer } from "./server/index.js";
import {
  initCommand,
  identityCommands,
  daemonCommands,
  walletCommands,
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

// bounty-net serve (MCP server - called by IDE)
program
  .command("serve")
  .description("Run MCP server (called by IDE)")
  .action(runServer);

program.parse();
