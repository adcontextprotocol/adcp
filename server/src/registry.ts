import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import type { Agent, AgentType } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// In dev: __dirname is /server/src, registry is at ../../registry
// In prod: __dirname is /dist, registry is at ../registry
const REGISTRY_ROOT = process.env.NODE_ENV === 'production'
  ? path.join(__dirname, "../registry")
  : path.join(__dirname, "../../registry");

export class Registry {
  private agents: Map<string, Agent> = new Map();

  async load(): Promise<void> {
    const types: AgentType[] = ["creative", "signals", "sales"];

    for (const type of types) {
      const dir = path.join(REGISTRY_ROOT, type);
      try {
        const files = await fs.readdir(dir);
        for (const file of files) {
          if (file.endsWith(".json")) {
            const filePath = path.join(dir, file);
            const content = await fs.readFile(filePath, "utf-8");
            const agent: Agent = JSON.parse(content);
            const key = `${type}/${file.replace(".json", "")}`;
            this.agents.set(key, agent);
          }
        }
      } catch (error) {
        console.error(`Error loading ${type} agents:`, error);
      }
    }

    console.log(`Loaded ${this.agents.size} agents from registry`);
  }

  listAgents(type?: AgentType): Agent[] {
    if (type) {
      return Array.from(this.agents.entries())
        .filter(([key]) => key.startsWith(`${type}/`))
        .map(([, agent]) => agent);
    }
    return Array.from(this.agents.values());
  }

  getAgent(name: string): Agent | undefined {
    return this.agents.get(name);
  }

  getAllAgents(): Map<string, Agent> {
    return this.agents;
  }
}
