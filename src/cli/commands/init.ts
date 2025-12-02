import fs from "fs";
import path from "path";
import crypto from "crypto";
import { PATHS } from "../../constants/paths.js";
import { createDefaultConfig, saveConfig, loadConfig } from "../../config/loader.js";

export async function initCommand(): Promise<void> {
  // Ensure base directory exists
  fs.mkdirSync(PATHS.BASE_DIR, { recursive: true });

  if (fs.existsSync(PATHS.CONFIG)) {
    console.log(`Config already exists at: ${PATHS.CONFIG}`);
    console.log("Delete it first if you want to reinitialize.");
    return;
  }

  const config = createDefaultConfig();
  saveConfig(config, PATHS.CONFIG);

  console.log(`Created config at: ${PATHS.CONFIG}`);
  console.log("");
  console.log("Next steps:");
  console.log("1. Generate a private key:");
  console.log("   bounty-net identity create personal");
  console.log("");
  console.log("2. Set environment variable:");
  console.log("   export BOUNTY_NET_PERSONAL_KEY=<your-private-key>");
  console.log("");
  console.log("3. Edit the config file to:");
  console.log("   - Add your nametag");
  console.log("   - Configure repositories (if you're a maintainer)");
  console.log("");
  console.log("4. Add to your MCP client config (e.g., Claude Desktop):");
  console.log("   {");
  console.log('     "mcpServers": {');
  console.log('       "bounty-net": {');
  console.log('         "command": "bounty-net",');
  console.log('         "args": ["serve"]');
  console.log("       }");
  console.log("     }");
  console.log("   }");
}

export async function initRepoCommand(options: {
  identity?: string;
  nametag?: string;
}): Promise<void> {
  const cwd = process.cwd();
  const bountyNetFile = path.join(cwd, ".bounty-net");

  // Check if we're in a git repo
  if (!fs.existsSync(path.join(cwd, ".git"))) {
    console.error("Error: Not in a git repository root.");
    console.error("Run this command from the root of your repository.");
    process.exit(1);
  }

  // Check if .bounty-net already exists
  if (fs.existsSync(bountyNetFile)) {
    console.log("File already exists: .bounty-net");
    console.log("");
    console.log(fs.readFileSync(bountyNetFile, "utf-8"));
    console.log("");
    console.log("Delete it first if you want to reinitialize.");
    return;
  }

  // Determine the nametag to use
  let nametag = options.nametag;

  if (!nametag && options.identity) {
    // Look up nametag from config
    try {
      const config = await loadConfig();
      const identity = config.identities[options.identity];
      if (identity?.nametag) {
        nametag = identity.nametag;
      }
    } catch {
      // Config doesn't exist or identity not found
    }
  }

  if (!nametag) {
    console.error("Error: No nametag specified.");
    console.error("");
    console.error("Usage:");
    console.error("  bounty-net init-repo --nametag your-name@unicity");
    console.error("  bounty-net init-repo --identity your-identity-name");
    process.exit(1);
  }

  // Create the .bounty-net file
  const content = `# Bounty-Net Configuration
# AI agents can report bugs to this repository's maintainer

maintainer: ${nametag}
`;

  fs.writeFileSync(bountyNetFile, content);

  console.log(`Created: .bounty-net`);
  console.log("");
  console.log(content);
  console.log("Next steps:");
  console.log("1. Commit this file to your repository");
  console.log("2. AI agents can now discover how to report bugs to you");
}
