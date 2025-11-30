import fs from "fs";
import crypto from "crypto";
import { PATHS } from "../../constants/paths.js";
import { createDefaultConfig, saveConfig } from "../../config/loader.js";

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
