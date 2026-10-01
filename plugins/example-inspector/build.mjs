import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = new URL("./", import.meta.url);
mkdirSync(fileURLToPath(new URL("dist/", root)), { recursive: true });
copyFileSync(new URL("src/index.html", root), new URL("dist/index.html", root));
