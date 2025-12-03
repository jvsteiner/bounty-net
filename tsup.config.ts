import { defineConfig } from "tsup";
import { readFileSync, cpSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  splitting: false,
  shims: true,
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  onSuccess: async () => {
    // Copy UI public files to dist
    const srcPublic = resolve("src/ui/public");
    const destPublic = resolve("dist/ui/public");

    if (existsSync(srcPublic)) {
      mkdirSync(destPublic, { recursive: true });
      cpSync(srcPublic, destPublic, { recursive: true });
      console.log("Copied UI public files to dist/ui/public");
    }
  },
});
