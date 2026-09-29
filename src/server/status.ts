// OpenAI service status from the public status page, cached for a few minutes.
export type ServiceStatus = {
  indicator: "none" | "minor" | "major" | "critical" | string;
  description: string;
  // Open incidents, Codex-related first.
  incidents: string[];
  url: string;
};

const URL = "https://status.openai.com/api/v2/summary.json";
const FRESH_MS = 5 * 60_000;
let cached: { at: number; value: ServiceStatus } | null = null;

export async function serviceStatus(): Promise<ServiceStatus | null> {
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.value;
  try {
    const response = await fetch(URL, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return cached?.value ?? null;
    const data: any = await response.json();
    const incidents = (data.incidents ?? [])
      .filter((i: any) => i.status !== "resolved" && i.status !== "postmortem")
      .map((i: any) => String(i.name))
      .sort((a: string, b: string) => Number(/codex/i.test(b)) - Number(/codex/i.test(a)));
    const value: ServiceStatus = {
      indicator: data.status?.indicator ?? "none",
      description: data.status?.description ?? "",
      incidents,
      url: data.page?.url ?? "https://status.openai.com/",
    };
    cached = { at: Date.now(), value };
    return value;
  } catch {
    return cached?.value ?? null;
  }
}
