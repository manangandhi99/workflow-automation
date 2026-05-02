import OpenAI from 'openai';
import { toolLibrary, Tool } from './tools.js';

type ToolVector = {
  tool: Tool;
  vector: number[];
};

let toolIndex: ToolVector[] | null = null;

function stringifyTool(tool: Tool) {
  return `${tool.name}: ${tool.description}. Parameters: ${JSON.stringify(tool.parameters)}`;
}

async function getOpenAIClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

export async function initializeToolIndex() {
  if (toolIndex) {
    return toolIndex;
  }

  const openai = await getOpenAIClient();
  const tools = Object.values(toolLibrary);
  const embeddings = await Promise.all(
    tools.map(async (tool) => {
      const response = await openai.embeddings.create({
        model: 'text-embedding-3-large',
        input: stringifyTool(tool),
      });
      const embedding = response.data?.[0]?.embedding;
      if (!embedding) {
        throw new Error('Failed to retrieve tool embedding');
      }
      return {
        tool,
        vector: embedding,
      };
    })
  );

  toolIndex = embeddings;
  return toolIndex;
}

function cosineSimilarity(a: number[], b: number[]) {
  const dot = a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
  const normA = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
  const normB = Math.sqrt(b.reduce((sum, value) => sum + value * value, 0));
  return dot / (normA * normB);
}

export async function retrieveRelevantTools(goal: string, topK = 5) {
  const index = await initializeToolIndex();
  const openai = await getOpenAIClient();
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-large',
    input: goal,
  });
  const goalVector = response.data?.[0]?.embedding;
  if (!goalVector) {
    throw new Error('Failed to retrieve goal embedding');
  }

  return [...index]
    .map((entry) => ({
      tool: entry.tool,
      score: cosineSimilarity(goalVector, entry.vector),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((entry) => entry.tool);
}
