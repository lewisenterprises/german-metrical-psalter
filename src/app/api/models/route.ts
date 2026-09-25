import { NextResponse } from "next/server";
import { discoverLMStudioModels } from "@/lib/providers";
import { discoveryDiagnostics, listCloudModels } from "@/lib/discovery";

export const runtime = "nodejs";

export async function GET() {
  const [cloudModels, local] = await Promise.all([
    listCloudModels(),
    discoverLMStudioModels(),
  ]);
  const localModels = local.map((m) => ({ ...m, available: true }));

  return NextResponse.json({
    models: [...cloudModels, ...localModels],
    discovery: discoveryDiagnostics(),
  });
}
