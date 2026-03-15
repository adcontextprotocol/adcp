/**
 * Generate illustrated documentation images using Gemini.
 *
 * Usage:
 *   npx tsx scripts/generate-images.ts <prompt-file.json>
 *   npx tsx scripts/generate-images.ts <prompt-file.json> --only panel-03
 *
 * Prompt file format: Array of { filename, prompt } objects.
 * Images are saved relative to repo root.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import * as fs from "fs";
import * as path from "path";

const BASE_STYLE = `Flat illustration, teal/emerald color palette (#047857 primary, #0d9488 secondary, #134e4a dark accents). Graphic novel style with clean panel borders. Clean, minimal linework with subtle gradients. Tech-forward but warm. No real brand names or logos. Wide aspect ratio suitable for documentation headers (roughly 16:9). Characters should have simple but expressive faces. Use white/light backgrounds for readability.`;

interface ImagePrompt {
  filename: string;
  prompt: string;
}

async function generateImage(
  genAI: GoogleGenerativeAI,
  entry: ImagePrompt,
): Promise<void> {
  const fullPrompt = `${BASE_STYLE}\n\n${entry.prompt}`;

  const model = genAI.getGenerativeModel({
    model: "gemini-3.1-flash-image-preview",
    generationConfig: {
      // @ts-expect-error - responseModalities not in SDK types yet
      responseModalities: ["TEXT", "IMAGE"],
    },
  });

  console.log(`Generating: ${entry.filename}...`);

  const result = await model.generateContent(fullPrompt);
  const response = result.response;

  // Extract image from response parts
  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData) {
      const outputPath = path.resolve(entry.filename);
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const buffer = Buffer.from(part.inlineData.data, "base64");
      fs.writeFileSync(outputPath, buffer);
      console.log(`  Saved: ${outputPath} (${(buffer.length / 1024).toFixed(0)} KB)`);
      return;
    }
  }

  // If no image found, log the text response for debugging
  const text = response.text();
  console.error(`  No image generated for ${entry.filename}. Response: ${text.slice(0, 200)}`);
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY not set");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const promptFile = args[0];
  if (!promptFile) {
    console.error("Usage: npx tsx scripts/generate-images.ts <prompt-file.json> [--only <pattern>]");
    process.exit(1);
  }

  const onlyIdx = args.indexOf("--only");
  const onlyPattern = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

  const prompts: ImagePrompt[] = JSON.parse(fs.readFileSync(promptFile, "utf-8"));
  const filtered = onlyPattern
    ? prompts.filter((p) => p.filename.includes(onlyPattern))
    : prompts;

  console.log(`Generating ${filtered.length} images...`);

  const genAI = new GoogleGenerativeAI(apiKey);

  // Generate sequentially to avoid rate limits
  for (const entry of filtered) {
    try {
      await generateImage(genAI, entry);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  Error generating ${entry.filename}: ${message}`);
    }
  }

  console.log("Done.");
}

main();
