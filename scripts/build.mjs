import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve("src");
const output = resolve("dist");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });

console.log(`Built static site: ${output}`);
