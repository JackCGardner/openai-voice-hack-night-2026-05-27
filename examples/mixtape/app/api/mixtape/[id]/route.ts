// TODO (Jin): GET/POST persisted mixtape via lib/store
//
// Director will dispatch Jin (Backend) to build this during the demo.
// Expected behavior:
//   - GET  /api/mixtape/[id]  -> 200 with Mixtape JSON, 404 if missing.
//   - POST /api/mixtape/[id]  -> upsert the supplied Mixtape, return it.
// Persistence layer is Cleo's lib/store (file-backed JSON in data/mixtapes.json).

import { NextResponse } from "next/server";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  return NextResponse.json(
    { error: `mixtape ${params.id} lookup not implemented yet (Jin TODO)` },
    { status: 501 },
  );
}

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  return NextResponse.json(
    { error: `mixtape ${params.id} persistence not implemented yet (Jin TODO)` },
    { status: 501 },
  );
}
