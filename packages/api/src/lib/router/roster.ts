import { z } from "zod";

// Every routing prompt lists one agent per line, so a newline in any stored
// field would forge roster entries for the model that reads it.
export const oneLine = (v: string) => v.replace(/[\r\n]+/g, " ").slice(0, 80);

export const promptList = (vs: string[]) => vs.map(oneLine).join(", ");

export function agentRosterLine(a: {
  id: string;
  name: string;
  specialization?: string | null;
  domains: string[];
  lastSeenAt: Date | string;
}, now = Date.now()): string {
  const online = now - new Date(a.lastSeenAt).getTime() < 10 * 60 * 1000;
  return `- id: ${a.id}  name: ${oneLine(a.name)}  specialization: ${a.specialization ? oneLine(a.specialization) : "none"}  domains: [${promptList(a.domains)}]  online: ${online}`;
}

// Anything that lands on a roster line is refused at the door too, so a stored
// value cannot rely on render-time scrubbing being applied everywhere.
export const promptSafeText = z.string().max(80).regex(/^[^\r\n]+$/);
export const promptSafeDomains = z.array(z.string().max(40).regex(/^[^\r\n]+$/)).max(20);
