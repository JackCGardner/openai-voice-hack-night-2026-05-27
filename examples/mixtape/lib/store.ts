// TODO (Cleo): file-backed JSON persistence using data/mixtapes.json
//
// Director will dispatch Cleo (Data) to build this during the demo.
// Expected behavior:
//   - readAll(): Promise<Mixtape[]>  — reads data/mixtapes.json.
//   - getById(id): Promise<Mixtape | null>.
//   - upsert(mix: Mixtape): Promise<Mixtape>  — atomic write (tmp + rename).
//   - All file IO via node:fs/promises, resolving paths relative to process.cwd().
//   - Validate via lib/schema before returning (zod optional, demo-grade is fine).

import type { Mixtape } from "./schema";

export async function readAll(): Promise<Mixtape[]> {
  throw new Error("lib/store.readAll not implemented yet (Cleo TODO)");
}

export async function getById(_id: string): Promise<Mixtape | null> {
  throw new Error("lib/store.getById not implemented yet (Cleo TODO)");
}

export async function upsert(_mixtape: Mixtape): Promise<Mixtape> {
  throw new Error("lib/store.upsert not implemented yet (Cleo TODO)");
}
